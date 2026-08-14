import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomInt } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt, encrypt, phoneHash } from '../../common/crypto.util';
import { MetaNumerosClient } from './meta-numeros.client';
import { normalizarTelefoneBR, mascarar, TelefoneInvalidoError } from './telefone';
import { ERROS_CONEXAO, codigoIncorreto, mensagemParaCliente } from './erros';

const VIVOS = ['criando', 'aguardando_codigo'];
const MAX_TENTATIVAS_CODIGO = 5;
const MAX_SMS_24H = 3;
const COOLDOWN_SMS_MS = 60_000;
const JANELA_24H_MS = 24 * 60 * 60 * 1000;

/** O texto de erro da Meta vai para `error_detail` (coluna SEM cifra) e para o
 *  log. O único insumo deste fluxo é um telefone, e a Meta às vezes ecoa o
 *  número na mensagem — então some com qualquer sequência longa de dígitos
 *  antes de persistir ou logar. O código numérico do erro é guardado à parte,
 *  em `error_code`, que é o que o suporte realmente usa. */
export function sanitizarDetalhe(texto: unknown): string {
  return String(texto ?? '')
    .replace(/\d{4,}/g, '[…]')
    .slice(0, 300);
}

@Injectable()
export class AssistedService {
  private readonly logger = new Logger('ConexaoAssistida');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly meta: MetaNumerosClient,
  ) {}

  private cfg() {
    return this.config.get<any>('assisted');
  }

  /** Grava um evento em `audit_logs`. `resource_id` é sempre o HASH do
   *  telefone, nunca o número em claro — mesmo padrão de
   *  privacy.service.ts. O código numérico da Meta (quando houver) vai em
   *  `metadata`: é o rastro que ERROS_CONEXAO esconde do cliente de propósito.
   *
   *  Falha ao gravar NUNCA pode derrubar o fluxo do cliente: em sms_sent e
   *  registered a Meta já consumiu a vaga do número antes desta chamada —
   *  se a exceção subisse, o cliente veria erro numa operação que na
   *  verdade deu certo, tentaria de novo, e queimaria outra vaga (que não
   *  volta por API). Por isso a falha vira só um log de erro bem visível. */
  private async auditar(
    orgId: string, userId: string | null, acao: string, hash: string, metadata: any = {},
  ) {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO audit_logs (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
        VALUES (${orgId}::uuid, ${userId}::uuid, ${acao}, 'channel_connection', ${hash}, ${JSON.stringify(metadata)}::jsonb)`;
    } catch (e) {
      this.logger.error(
        `falha ao gravar auditoria (ação ${acao}, hash ${hash}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Marca o diagnóstico interno da solicitação sem nunca derrubar o fluxo:
   *  quando o próprio banco é a causa da falha, insistir só trocaria a
   *  mensagem do catálogo por um 500 em inglês. Mesmo raciocínio de auditar(). */
  private async registrarErro(id: string, codigo: string, detalhe: string, status?: string) {
    try {
      await this.prisma.channelConnectionRequest.update({
        where: { id },
        data: { errorCode: codigo, errorDetail: sanitizarDetalhe(detalhe), ...(status ? { status } : {}) },
      });
    } catch (e) {
      this.logger.error(
        `falha ao gravar o erro da solicitação ${id} (${codigo}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Solicitação em andamento — é o que a tela usa para retomar de onde parou.
   *  Só devolve status VIVO (`criando` ou `aguardando_codigo`); os demais já
   *  não são retomáveis e viram `solicitacao: null`. */
  async atual(orgId: string) {
    const r = await this.prisma.channelConnectionRequest.findFirst({
      where: { organizationId: orgId, status: { in: VIVOS } },
      orderBy: { createdAt: 'desc' },
    });
    if (!r) return { solicitacao: null };
    return {
      solicitacao: {
        id: r.id,
        status: r.status,
        numeroMascarado: mascarar(r.phoneDdd, r.phoneLast4),
        nomeExibicao: r.displayName,
        tentativasRestantes: MAX_TENTATIVAS_CODIGO - r.codeAttempts,
        podeReenviarEm: this.segundosParaReenvio(r.lastCodeSentAt),
        // Booleano derivado de `code_verified_at`: a Meta já aceitou o código e
        // só o registro ficou faltando (ver verificar()). Sem isso a tela pede
        // de novo um código de 6 dígitos que o servidor vai ignorar — o cliente
        // digita qualquer coisa sem entender. A data em si não sai daqui: à tela
        // interessa apenas se ainda há código a digitar.
        codigoJaVerificado: r.codeVerifiedAt !== null,
      },
    };
  }

  private segundosParaReenvio(ultimo: Date | null): number {
    if (!ultimo) return 0;
    const falta = COOLDOWN_SMS_MS - (Date.now() - ultimo.getTime());
    return falta > 0 ? Math.ceil(falta / 1000) : 0;
  }

  async iniciar(
    orgId: string,
    userId: string,
    dto: { telefone: string; nomeExibicao: string; aceitouPreRequisito: boolean },
  ) {
    if (!dto.aceitouPreRequisito) {
      throw new BadRequestException('É preciso confirmar o pré-requisito do número.');
    }
    const nome = (dto.nomeExibicao || '').trim();
    if (nome.length < 2 || nome.length > 60) {
      throw new BadRequestException('Informe o nome do negócio (2 a 60 caracteres).');
    }

    const cfg = this.cfg();
    const desde24h = new Date(Date.now() - JANELA_24H_MS);

    // Teto por organização em 24h, contado no BANCO (não em memória — o
    // balde do @Throttle do controller é por processo e por usuário; usuários
    // diferentes da mesma org somam baldes independentes contra o MESMO teto
    // global de vagas da WABA da Zaplane). Sem isso, uma org insistindo
    // esgota a capacidade de todo mundo — e a vaga não volta por API. Checado
    // antes de qualquer outra coisa, inclusive antes de normalizar o
    // telefone: é o mais barato e o mais amplo dos vetos.
    const tentativas24h = await this.prisma.channelConnectionRequest.count({
      where: { organizationId: orgId, createdAt: { gte: desde24h } },
    });
    if (tentativas24h >= cfg.maxConnectAttempts24h) {
      // Mensagem do catálogo — não inventar texto que revele o mecanismo
      // (rate limit por organização) para quem está tentando abusar.
      throw new ConflictException(ERROS_CONEXAO.capacidade);
    }

    // Trava SEPARADA, e a que realmente protege a plataforma: a de cima conta
    // TENTATIVAS, esta conta VAGAS QUEIMADAS. A vaga é consumida no instante
    // em que a Meta aceita o número (phone_number_id preenchido) e não volta
    // por API — mesmo que a verificação nunca complete. Sem esta trava, uma
    // única organização torra maxConnectAttempts24h vagas por dia, todo dia,
    // das ~20 que a WABA inteira tem.
    const vagasQueimadas24h = await this.prisma.channelConnectionRequest.count({
      where: {
        organizationId: orgId,
        createdAt: { gte: desde24h },
        phoneNumberId: { not: null },
        status: { not: 'concluida' },
      },
    });
    if (vagasQueimadas24h >= cfg.maxBurnedSlots24h) {
      throw new ConflictException(ERROS_CONEXAO.capacidade);
    }

    let tel;
    try {
      tel = normalizarTelefoneBR(dto.telefone);
    } catch (e) {
      if (e instanceof TelefoneInvalidoError) {
        throw new BadRequestException(ERROS_CONEXAO.numero_indisponivel);
      }
      throw e;
    }
    const hash = phoneHash(tel.e164);

    // Travas ANTES de qualquer escrita na Meta — a vaga do número não volta por API.
    const jaTem = await this.prisma.whatsappChannel.count({
      where: { organizationId: orgId, status: 'active' },
    });
    if (jaTem >= cfg.orgMaxChannels) {
      throw new ConflictException('Sua conta já tem um número conectado.');
    }
    const emAndamento = await this.prisma.channelConnectionRequest.findFirst({
      where: { organizationId: orgId, status: { in: VIVOS } },
    });
    if (emAndamento) {
      throw new ConflictException('Já existe uma conexão em andamento.');
    }
    // Número de outra organização: falha fechado, com a mensagem genérica.
    // whatsapp_channels NÃO tem phone_hash — a checagem é contra as
    // solicitações concluídas, que é onde o hash vive.
    const deOutra = await this.prisma.channelConnectionRequest.findFirst({
      where: { phoneHash: hash, status: 'concluida' },
    });
    if (deOutra && deOutra.organizationId !== orgId) {
      // Este veto tem que CUSTAR o mesmo que uma tentativa de verdade. Se ele
      // devolvesse 400 sem gravar nada, sondar a base inteira sairia de graça:
      // número livre gasta orçamento e duas idas à Graph API, número de outro
      // cliente não gastava nada — e a diferença entrega justamente o que o
      // catálogo de erros existe para esconder. A linha nasce em 'falhou'
      // (fora dos índices parciais de solicitação viva) só para consumir o
      // orçamento de 24h contado acima.
      await this.criarSolicitacaoQueimada(orgId, userId, cfg.wabaId, tel, hash, nome);
      this.logger.warn(`Tentativa de conectar número de outra organização (org ${orgId})`);
      throw new BadRequestException(ERROS_CONEXAO.numero_indisponivel);
    }
    // Trava irreversível: não conseguir verificar a capacidade (token expirado,
    // 5xx, rede) é motivo para NÃO prosseguir — seguir otimista queimaria uma
    // vaga que não volta.
    const capacidade = await this.meta.contarNumeros(cfg.wabaId);
    if (!capacidade.ok) {
      // Sem este log, uma falha de credencial (token vazio/expirado) chega
      // ao cliente como "capacidade cheia" e ao operador como silêncio total
      // — não há como distinguir "WABA realmente lotada" de "token ruim".
      this.logger.error(
        `contarNumeros falhou (waba ${cfg.wabaId}): código ${capacidade.codigo} — ${sanitizarDetalhe(capacidade.detalhe)}`,
      );
      throw new ConflictException(ERROS_CONEXAO.capacidade);
    }
    if (capacidade.total >= cfg.phoneCap) {
      throw new ConflictException(ERROS_CONEXAO.capacidade);
    }

    // Linha ANTES da Meta: se a chamada aceitar e o nosso UPDATE falhar, a
    // reconciliação encontra o número; sem a linha ele seria invisível.
    let req;
    try {
      req = await this.prisma.channelConnectionRequest.create({
        data: {
          organizationId: orgId,
          createdBy: userId,
          wabaId: cfg.wabaId,
          phoneE164Enc: encrypt(tel.e164),
          phoneHash: hash,
          phoneDdd: tel.nacional.slice(0, 2),
          phoneLast4: tel.ultimos4,
          displayName: nome,
          status: 'criando',
        },
      });
    } catch (e) {
      // Corrida entre a leitura (travas acima) e a escrita: quem segura de
      // verdade são os índices únicos parciais do banco (idx_ccr_org_viva por
      // org; idx_ccr_phone_viva GLOBAL, entre orgs). Um P2002 cru viraria 500
      // — e no caso do índice global, um 500 em vez do 400 genérico é fresta
      // no oráculo de enumeração que ERROS_CONEXAO tenta fechar. Pelo mesmo
      // motivo o status é 400, igual ao veto de "número de outra organização":
      // um 409 com o texto de numero_indisponivel só poderia significar "outra
      // organização está conectando este número agora mesmo".
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException(ERROS_CONEXAO.numero_indisponivel);
      }
      throw e;
    }
    await this.auditar(orgId, userId, 'channel.connect.requested', hash);

    const add = await this.meta.adicionarNumero(cfg.wabaId, tel, nome);
    if (!add.ok) {
      const detalhe = sanitizarDetalhe(add.detalhe);
      await this.registrarErro(req.id, String(add.codigo ?? ''), detalhe, 'falhou');
      this.logger.warn(`adicionarNumero falhou (org ${orgId}): ${add.codigo} ${detalhe}`);
      throw new BadRequestException(mensagemParaCliente(add.codigo));
    }

    const webhook = await this.meta.inscreverWebhook(cfg.wabaId);
    if (!webhook.ok) {
      // Idempotente por WABA — na prática já estará inscrito na maioria dos
      // casos, mas no primeiro número de uma WABA nova o silêncio custa caro:
      // sem isso nenhum status de mensagem volta. Não aborta o fluxo, só avisa alto.
      this.logger.error(
        `inscreverWebhook falhou (waba ${cfg.wabaId}): ${webhook.codigo} ${sanitizarDetalhe(webhook.detalhe)}`,
      );
    }
    const sms = await this.meta.pedirCodigo(add.phoneNumberId, 'SMS');
    if (!sms.ok) {
      const detalhe = sanitizarDetalhe(sms.detalhe);
      // phoneNumberId é gravado mesmo na falha: a vaga JÁ foi consumida e essa
      // coluna é o que a reconciliação e a trava de vagas queimadas enxergam.
      await this.prisma.channelConnectionRequest.update({
        where: { id: req.id },
        data: {
          status: 'falhou', phoneNumberId: add.phoneNumberId,
          errorCode: String(sms.codigo ?? ''), errorDetail: detalhe,
        },
      });
      this.logger.warn(`pedirCodigo falhou (org ${orgId}): ${sms.codigo} ${detalhe}`);
      throw new BadRequestException(mensagemParaCliente(sms.codigo));
    }

    await this.prisma.channelConnectionRequest.update({
      where: { id: req.id },
      data: {
        phoneNumberId: add.phoneNumberId,
        status: 'aguardando_codigo',
        codeRequests: 1,
        lastCodeSentAt: new Date(),
      },
    });
    await this.auditar(orgId, userId, 'channel.connect.sms_sent', hash);
    return { id: req.id, numeroMascarado: mascarar(tel.nacional.slice(0, 2), tel.ultimos4) };
  }

  /** Solicitação que nasce e morre no mesmo instante, só para consumir o
   *  orçamento de 24h de quem tentou um número que não pode usar. Falhar ao
   *  gravar não muda a resposta ao cliente (o veto vale de qualquer jeito) —
   *  só perde a trava, então é log de erro, nunca exceção. */
  private async criarSolicitacaoQueimada(
    orgId: string, userId: string, wabaId: string,
    tel: { e164: string; nacional: string; ultimos4: string }, hash: string, nome: string,
  ) {
    try {
      await this.prisma.channelConnectionRequest.create({
        data: {
          organizationId: orgId,
          createdBy: userId,
          wabaId,
          phoneE164Enc: encrypt(tel.e164),
          phoneHash: hash,
          phoneDdd: tel.nacional.slice(0, 2),
          phoneLast4: tel.ultimos4,
          displayName: nome,
          status: 'falhou',
          errorCode: 'numero_de_outra_org',
        },
      });
    } catch (e) {
      this.logger.error(
        `falha ao registrar a tentativa vetada (org ${orgId}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async reenviar(orgId: string, id: string, metodo: 'SMS' | 'VOICE') {
    const req = await this.buscarViva(orgId, id);
    // 'criando' está em VIVOS mas ainda não tem phoneNumberId (só ganha os
    // dois juntos, no fim de iniciar()) — sem essa trava, uma corrida com um
    // iniciar() em andamento chamaria a Meta com "null" na URL.
    if (!req.phoneNumberId) throw new BadRequestException(ERROS_CONEXAO.generico);
    if (req.codeRequests >= MAX_SMS_24H) throw new BadRequestException(ERROS_CONEXAO.sms_limite);
    if (this.segundosParaReenvio(req.lastCodeSentAt) > 0) {
      throw new BadRequestException(ERROS_CONEXAO.sms_limite);
    }
    const r = await this.meta.pedirCodigo(req.phoneNumberId!, metodo);
    if (!r.ok) {
      // Sem log, error_code e auditoria este era o único erro da Meta no fluxo
      // inteiro que não deixava rastro nenhum: o cliente liga para o suporte
      // dizendo "não chega SMS" e não há o que olhar. A solicitação continua
      // VIVA — reenviar é retentável, ao contrário de adicionar o número.
      const detalhe = sanitizarDetalhe(r.detalhe);
      this.logger.warn(`pedirCodigo (reenvio ${metodo}) falhou (org ${orgId}): ${r.codigo} ${detalhe}`);
      await this.registrarErro(req.id, String(r.codigo ?? ''), detalhe);
      await this.auditar(orgId, req.createdBy, 'channel.connect.resend_failed', req.phoneHash, {
        metodo, codigoMeta: r.codigo,
      });
      throw new BadRequestException(mensagemParaCliente(r.codigo));
    }
    await this.prisma.channelConnectionRequest.update({
      where: { id: req.id },
      data: { codeRequests: { increment: 1 }, lastCodeSentAt: new Date() },
    });
    return { ok: true };
  }

  async verificar(orgId: string, id: string, codigo: string) {
    const req = await this.buscarViva(orgId, id);
    // Mesma trava de reenviar(): sem phoneNumberId a chamada iria pra Meta
    // com "null" na URL, tomaria 400, e isso seria contado como código
    // errado — queimando uma das 5 tentativas do cliente por um erro nosso.
    if (!req.phoneNumberId) throw new BadRequestException(ERROS_CONEXAO.generico);

    // Verificação que JÁ deu certo numa tentativa anterior (o registro depois
    // dela é que falhou). Reenviar o mesmo código à Meta é recusa garantida —
    // "o número já está verificado" — e seria contabilizado como código
    // errado: 5 recusas assim terminam a solicitação em 'falhou' e a vaga do
    // número vai embora sem nunca virar canal. Daqui pula-se direto para o
    // registro, que é a única etapa que ainda falta.
    const jaVerificado = await this.verificacaoConcluida(req.id);

    let pin: string | null = null;
    if (jaVerificado) {
      // reusa o MESMO PIN: se o register anterior chegou a acontecer na Meta e
      // só a resposta se perdeu, registrar de novo com outro PIN trocaria o PIN
      // de duas etapas do número.
      pin = this.pinGuardado(req.registerPinEnc);
    } else {
      const v = await this.meta.verificarCodigo(req.phoneNumberId!, codigo);
      if (!v.ok) {
        const tentativas = req.codeAttempts + 1;
        const queimou = tentativas >= MAX_TENTATIVAS_CODIGO;
        await this.prisma.channelConnectionRequest.update({
          where: { id: req.id },
          data: {
            codeAttempts: tentativas,
            ...(queimou ? { status: 'falhou', errorCode: 'codigo_esgotado' } : {}),
          },
        });
        await this.auditar(orgId, req.createdBy, 'channel.connect.verify_failed', req.phoneHash, {
          tentativas, codigoMeta: v.codigo,
        });
        throw new BadRequestException(
          queimou ? 'Tentativas esgotadas. Recomece a conexão.' : codigoIncorreto(MAX_TENTATIVAS_CODIGO - tentativas),
        );
      }
    }

    if (!pin) {
      pin = String(randomInt(100000, 999999));
      // Grava o SUCESSO da verificação junto do PIN, ANTES de registrar: são as
      // escritas que tornam a tentativa seguinte possível. Sem `code_verified_at`
      // persistido, uma falha transitória no registrar deixaria o cliente sem
      // saída — a única coisa que ele pode fazer é digitar o mesmo código de
      // novo, e a Meta recusa código de número já verificado.
      // Esta escrita NÃO é engolida de propósito: registrar sem ter gravado a
      // verificação recria a mesma armadilha, agora com o número já
      // registrado. Falhar antes do /register é a direção segura.
      await this.marcarVerificado(req.id, encrypt(pin));
    }

    const reg = await this.meta.registrar(req.phoneNumberId!, pin);
    if (!reg.ok) {
      // Pode ser que o registro anterior tenha dado certo e o canal já exista:
      // nesse caso a falha é ruído, não erro do cliente.
      const jaFeito = await this.fecharSeJaExiste(orgId, req);
      if (jaFeito) return jaFeito;
      const detalhe = sanitizarDetalhe(reg.detalhe);
      // A solicitação continua VIVA e marcada como verificada — a próxima
      // tentativa entra direto no registro, sem gastar tentativa de código.
      await this.registrarErro(req.id, String(reg.codigo ?? ''), detalhe);
      this.logger.warn(`registrar falhou (org ${orgId}, solicitação ${req.id}): ${reg.codigo} ${detalhe}`);
      await this.auditar(orgId, req.createdBy, 'channel.connect.register_failed', req.phoneHash, {
        codigoMeta: reg.codigo,
      });
      throw new BadRequestException(mensagemParaCliente(reg.codigo));
    }

    // Daqui para baixo o número JÁ está registrado na Meta: a vaga foi
    // consumida e não volta por API. Nenhuma falha pode virar 500 e deixar a
    // solicitação num estado que perde o trabalho já feito.
    let canal: { id: string };
    try {
      // Só agora nasce o canal — invariante: linha aqui ⇒ pronto para enviar.
      canal = await this.prisma.whatsappChannel.create({
        data: {
          organizationId: orgId,
          label: req.displayName,
          phoneNumberId: req.phoneNumberId!,
          wabaId: req.wabaId,
          // o token da Zaplane NUNCA é copiado para a linha do canal; o
          // dispatcher resolve pelo fallback do ambiente (worker.go resolveToken)
          accessTokenEnc: '',
          registerPinEnc: encrypt(pin),
          connectedVia: 'assisted',
          status: 'active',
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // Duas causas possíveis, e o desfecho certo é diferente em cada uma.
        // (a) organizationId_phoneNumberId: o canal desta org já existe — a
        //     tentativa anterior foi até o fim e só a resposta se perdeu.
        //     Fecha a solicitação apontando para ele; é a retentativa dando
        //     certo, não um erro.
        const jaFeito = await this.fecharSeJaExiste(orgId, req);
        if (jaFeito) return jaFeito;
        // (b) idx_channels_pnid_global: o número está em OUTRA organização.
        //     A vaga já foi consumida e o canal não pode nascer — a
        //     solicitação morre, mas com rastro para a baixa manual.
        this.logger.error(
          `número ${req.phoneNumberId} registrado na Meta já pertence a outra organização ` +
            `(org ${orgId}, solicitação ${req.id}) — vaga ocupada na WABA ${req.wabaId}, remover no WhatsApp Manager`,
        );
        await this.registrarErro(req.id, 'pnid_de_outra_org', 'canal já existe para este número', 'falhou');
        await this.auditar(orgId, req.createdBy, 'channel.connect.channel_failed', req.phoneHash, {
          motivo: 'pnid_de_outra_org',
        });
        // 400, mesmo status e mesmo texto do veto de iniciar(): um 409 aqui
        // diria ao cliente que o número existe em outra conta.
        throw new BadRequestException(ERROS_CONEXAO.numero_indisponivel);
      }
      // Falha nossa (banco fora, por exemplo) com o número já registrado. A
      // solicitação fica VIVA e verificada: a próxima tentativa cai no
      // fecharSeJaExiste/registro e conclui. Nunca 500 cru.
      const detalhe = e instanceof Error ? e.message : String(e);
      this.logger.error(
        `falha ao criar o canal (org ${orgId}, solicitação ${req.id}) com o número já registrado na Meta: ${sanitizarDetalhe(detalhe)}`,
      );
      await this.registrarErro(req.id, 'canal_nao_criado', detalhe);
      await this.auditar(orgId, req.createdBy, 'channel.connect.channel_failed', req.phoneHash, {
        motivo: 'canal_nao_criado',
      });
      throw new BadRequestException(ERROS_CONEXAO.generico);
    }

    await this.prisma.channelConnectionRequest.update({
      where: { id: req.id },
      data: { status: 'concluida', channelId: canal.id },
    });
    await this.auditar(orgId, req.createdBy, 'channel.connect.registered', req.phoneHash, { canalId: canal.id });
    return { canalId: canal.id };
  }

  /** Fecha a solicitação apontando para o canal que JÁ existe nesta
   *  organização para este número — o passo anterior deu certo e só a resposta
   *  (ou a nossa escrita) se perdeu. Devolve null quando não há canal. */
  private async fecharSeJaExiste(
    orgId: string,
    req: { id: string; phoneNumberId: string | null; phoneHash: string; createdBy: string | null },
  ): Promise<{ canalId: string } | null> {
    const existente = await this.prisma.whatsappChannel.findFirst({
      where: { organizationId: orgId, phoneNumberId: req.phoneNumberId! },
    });
    if (!existente) return null;
    await this.prisma.channelConnectionRequest.update({
      where: { id: req.id },
      data: { status: 'concluida', channelId: existente.id },
    });
    await this.auditar(orgId, req.createdBy, 'channel.connect.registered', req.phoneHash, {
      canalId: existente.id, reaproveitado: true,
    });
    return { canalId: existente.id };
  }

  /** `code_verified_at` (migração 013) é lida e escrita por SQL cru de
   *  propósito: o model do Prisma ainda não conhece a coluna — a atualização
   *  do schema.prisma é de outra rodada da revisão. Trocar por Prisma quando o
   *  model tiver `codeVerifiedAt DateTime?`. */
  private async verificacaoConcluida(id: string): Promise<boolean> {
    const linhas = await this.prisma.$queryRaw<Array<{ verificado: boolean }>>`
      SELECT code_verified_at IS NOT NULL AS verificado
        FROM channel_connection_requests WHERE id = ${id}::uuid`;
    return linhas?.[0]?.verificado === true;
  }

  /** Verificação aceita pela Meta + PIN do registro, numa escrita só: as duas
   *  informações nascem juntas e uma sem a outra não serve para retomar. */
  private async marcarVerificado(id: string, pinEnc: string) {
    await this.prisma.$executeRaw`
      UPDATE channel_connection_requests
         SET code_verified_at = now(), register_pin_enc = ${pinEnc}, updated_at = now()
       WHERE id = ${id}::uuid`;
  }

  /** PIN guardado na solicitação. Se não der para decifrar (chave rotacionada,
   *  valor corrompido), devolve null e o chamador gera um novo — melhor um PIN
   *  novo que uma solicitação travada com a vaga já consumida. */
  private pinGuardado(enc: string | null): string | null {
    if (!enc) return null;
    try {
      return decrypt(enc);
    } catch (e) {
      this.logger.error(
        `não consegui decifrar o PIN guardado da solicitação: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  async cancelar(orgId: string, id: string) {
    const req = await this.buscarViva(orgId, id);
    await this.prisma.channelConnectionRequest.update({
      where: { id: req.id },
      data: { status: 'cancelada' },
    });
    // A vaga na Meta NÃO volta por API — fica para a baixa manual do operador.
    this.logger.warn(`Conexão cancelada; número ${req.phoneNumberId} segue ocupando vaga na WABA ${req.wabaId}`);
    await this.auditar(orgId, req.createdBy, 'channel.connect.cancelled', req.phoneHash);
    return { ok: true };
  }

  private async buscarViva(orgId: string, id: string) {
    const req = await this.prisma.channelConnectionRequest.findFirst({
      where: { id, organizationId: orgId, status: { in: VIVOS } },
    });
    if (!req) throw new NotFoundException('Conexão não encontrada.');
    return req;
  }
}

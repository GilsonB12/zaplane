import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomInt } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { encrypt, phoneHash } from '../../common/crypto.util';
import { MetaNumerosClient } from './meta-numeros.client';
import { normalizarTelefoneBR, mascarar, TelefoneInvalidoError } from './telefone';
import { ERROS_CONEXAO, codigoIncorreto, mensagemParaCliente } from './erros';

const VIVOS = ['criando', 'aguardando_codigo'];
const MAX_TENTATIVAS_CODIGO = 5;
const MAX_SMS_24H = 3;
const COOLDOWN_SMS_MS = 60_000;

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

  /** Solicitação em andamento — a tela abre direto no passo do código. */
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

    // Teto por organização em 24h, contado no BANCO (não em memória — o
    // balde do @Throttle do controller é por processo e por usuário; usuários
    // diferentes da mesma org somam baldes independentes contra o MESMO teto
    // global de vagas da WABA da Zaplane). Sem isso, uma org insistindo
    // esgota a capacidade de todo mundo — e a vaga não volta por API. Checado
    // antes de qualquer outra coisa, inclusive antes de normalizar o
    // telefone: é o mais barato e o mais amplo dos vetos.
    const tentativas24h = await this.prisma.channelConnectionRequest.count({
      where: { organizationId: orgId, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });
    if (tentativas24h >= cfg.maxConnectAttempts24h) {
      // Mensagem do catálogo — não inventar texto que revele o mecanismo
      // (rate limit por organização) para quem está tentando abusar.
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
        `contarNumeros falhou (waba ${cfg.wabaId}): código ${capacidade.codigo} — ${capacidade.detalhe}`,
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
      // no oráculo de enumeração que ERROS_CONEXAO tenta fechar.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(ERROS_CONEXAO.numero_indisponivel);
      }
      throw e;
    }
    await this.auditar(orgId, userId, 'channel.connect.requested', hash);

    const add = await this.meta.adicionarNumero(cfg.wabaId, tel, nome);
    if (!add.ok) {
      await this.prisma.channelConnectionRequest.update({
        where: { id: req.id },
        data: { status: 'falhou', errorCode: String(add.codigo ?? ''), errorDetail: add.detalhe },
      });
      this.logger.warn(`adicionarNumero falhou (org ${orgId}): ${add.codigo} ${add.detalhe}`);
      throw new BadRequestException(mensagemParaCliente(add.codigo));
    }

    const webhook = await this.meta.inscreverWebhook(cfg.wabaId);
    if (!webhook.ok) {
      // Idempotente por WABA — na prática já estará inscrito na maioria dos
      // casos, mas no primeiro número de uma WABA nova o silêncio custa caro:
      // sem isso nenhum status de mensagem volta. Não aborta o fluxo, só avisa alto.
      this.logger.error(`inscreverWebhook falhou (waba ${cfg.wabaId}): ${webhook.codigo} ${webhook.detalhe}`);
    }
    const sms = await this.meta.pedirCodigo(add.phoneNumberId, 'SMS');
    if (!sms.ok) {
      await this.prisma.channelConnectionRequest.update({
        where: { id: req.id },
        data: { status: 'falhou', phoneNumberId: add.phoneNumberId, errorCode: String(sms.codigo ?? ''), errorDetail: sms.detalhe },
      });
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
    if (!r.ok) throw new BadRequestException(mensagemParaCliente(r.codigo));
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

    const pin = String(randomInt(100000, 999999));
    // PIN gravado ANTES do registrar: é a segunda escrita irreversível (a
    // primeira é a linha em si). Se o create do canal falhar logo depois, o
    // PIN para re-registrar/desregistrar o número não pode ficar só na
    // memória do processo — a coluna existe exatamente para isso.
    await this.prisma.channelConnectionRequest.update({
      where: { id: req.id },
      data: { registerPinEnc: encrypt(pin) },
    });
    const reg = await this.meta.registrar(req.phoneNumberId!, pin);
    if (!reg.ok) {
      await this.prisma.channelConnectionRequest.update({
        where: { id: req.id },
        data: { errorCode: String(reg.codigo ?? ''), errorDetail: reg.detalhe },
      });
      throw new BadRequestException(mensagemParaCliente(reg.codigo));
    }

    // Só agora nasce o canal — invariante: linha aqui ⇒ pronto para enviar.
    const canal = await this.prisma.whatsappChannel.create({
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
    await this.prisma.channelConnectionRequest.update({
      where: { id: req.id },
      data: { status: 'concluida', channelId: canal.id },
    });
    await this.auditar(orgId, req.createdBy, 'channel.connect.registered', req.phoneHash, { canalId: canal.id });
    return { canalId: canal.id };
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

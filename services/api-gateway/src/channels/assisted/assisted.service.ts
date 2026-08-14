import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
    const cfg = this.cfg();

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
    const capacidade = await this.meta.contarNumeros(cfg.wabaId);
    if (capacidade.ok && capacidade.total >= cfg.phoneCap) {
      throw new ConflictException(ERROS_CONEXAO.capacidade);
    }

    // Linha ANTES da Meta: se a chamada aceitar e o nosso UPDATE falhar, a
    // reconciliação encontra o número; sem a linha ele seria invisível.
    const req = await this.prisma.channelConnectionRequest.create({
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

    const add = await this.meta.adicionarNumero(cfg.wabaId, tel, nome);
    if (!add.ok) {
      await this.prisma.channelConnectionRequest.update({
        where: { id: req.id },
        data: { status: 'falhou', errorCode: String(add.codigo ?? ''), errorDetail: add.detalhe },
      });
      this.logger.warn(`adicionarNumero falhou (org ${orgId}): ${add.codigo} ${add.detalhe}`);
      throw new BadRequestException(mensagemParaCliente(add.codigo));
    }

    await this.meta.inscreverWebhook(cfg.wabaId); // idempotente; sem isso nenhum status volta
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
    return { id: req.id, numeroMascarado: mascarar(tel.nacional.slice(0, 2), tel.ultimos4) };
  }

  async reenviar(orgId: string, id: string, metodo: 'SMS' | 'VOICE') {
    const req = await this.buscarViva(orgId, id);
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
      throw new BadRequestException(
        queimou ? 'Tentativas esgotadas. Recomece a conexão.' : codigoIncorreto(MAX_TENTATIVAS_CODIGO - tentativas),
      );
    }

    const pin = String(randomInt(100000, 999999));
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
      } as any,
    });
    await this.prisma.channelConnectionRequest.update({
      where: { id: req.id },
      data: { status: 'concluida', channelId: canal.id },
    });
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

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeBrPhone } from '../common/phone.util';
import { decrypt } from '../common/crypto.util';

const OPT_OUT_KEYWORDS = ['parar', 'sair', 'stop', 'cancelar', 'descadastrar', 'unsubscribe'];

// cache em memória do secret+canal por phone_number_id (evita decifrar/consultar a
// cada evento) — TTL 5 min, invalidação perfeita não é requisito (o TTL cobre
// rotação/edição do secret e troca de dono do número).
const CHANNEL_SECRET_TTL_MS = 5 * 60 * 1000;

export interface ScopedChannel {
  id: string;
  organizationId: string;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger('Webhooks');
  private readonly secretCache = new Map<
    string,
    { secret: string; channel: ScopedChannel; expiresAt: number }
  >();

  constructor(private prisma: PrismaService, private config: ConfigService) {}

  // GET: handshake de verificação do webhook
  verify(mode?: string, token?: string, challenge?: string): string | null {
    const expected = this.config.get<string>('whatsapp.webhookVerifyToken');
    if (mode === 'subscribe' && token && token === expected) return challenge ?? '';
    return null;
  }

  // valida X-Hub-Signature-256 (HMAC do corpo cru) em duas fases:
  // 1) secret global (whatsapp.appSecret) — cobre canais via Embedded Signup (app
  //    Zaplane) e canais legados sem app_secret_enc próprio. Quem assina com esse
  //    secret só pode ser a Meta: confiança total, sem escopo (scopedPhoneNumberId null).
  // 2) por canal: extrai phone_number_id do body já parseado, busca o canal com
  //    app_secret_enc preenchido e valida o HMAC contra o secret decifrado dele. Esse
  //    secret é do tenant dono do canal, então a autenticação só vale PARA AQUELE
  //    phone_number_id — retornamos o escopo p/ o process() filtrar os changes.
  async validateSignature(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    body: any,
  ): Promise<{ valid: boolean; scopedPhoneNumberId: string | null; scopedChannel: ScopedChannel | null }> {
    if (!rawBody || !signature) {
      return { valid: false, scopedPhoneNumberId: null, scopedChannel: null };
    }

    const globalSecret = this.config.get<string>('whatsapp.appSecret');
    if (globalSecret && this.hmacMatches(rawBody, signature, globalSecret)) {
      return { valid: true, scopedPhoneNumberId: null, scopedChannel: null };
    }

    const phoneNumberId = extractPhoneNumberId(body);
    if (!phoneNumberId) return { valid: false, scopedPhoneNumberId: null, scopedChannel: null };

    const found = await this.getChannelForSignature(phoneNumberId);
    if (!found) return { valid: false, scopedPhoneNumberId: null, scopedChannel: null };

    if (!this.hmacMatches(rawBody, signature, found.secret)) {
      return { valid: false, scopedPhoneNumberId: null, scopedChannel: null };
    }
    return { valid: true, scopedPhoneNumberId: phoneNumberId, scopedChannel: found.channel };
  }

  private hmacMatches(rawBody: Buffer, signature: string, secret: string): boolean {
    const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // busca (com cache de 5 min) o secret decifrado + o canal dono do phone_number_id.
  // NÃO filtra por organização: o webhook é global e phone_number_id é único entre
  // canais ATIVOS — resolve o mais recente (createdAt desc) para o caso de churn
  // (um número trocar de dono: o disconnect é soft, então a linha antiga do dono
  // anterior continua existindo, só com status 'disabled').
  private async getChannelForSignature(
    phoneNumberId: string,
  ): Promise<{ secret: string; channel: ScopedChannel } | null> {
    const cached = this.secretCache.get(phoneNumberId);
    if (cached && cached.expiresAt > Date.now()) {
      return { secret: cached.secret, channel: cached.channel };
    }

    const channel = await this.prisma.whatsappChannel.findFirst({
      where: { phoneNumberId, appSecretEnc: { not: null }, status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
    if (!channel?.appSecretEnc) return null;

    // app_secret_enc pode estar cifrado (AES-GCM) ou em texto puro (cifragem é TODO no projeto)
    let secret: string;
    try {
      secret = decrypt(channel.appSecretEnc);
    } catch {
      secret = channel.appSecretEnc;
    }

    const scopedChannel: ScopedChannel = { id: channel.id, organizationId: channel.organizationId };
    this.secretCache.set(phoneNumberId, {
      secret,
      channel: scopedChannel,
      expiresAt: Date.now() + CHANNEL_SECRET_TTL_MS,
    });
    return { secret, channel: scopedChannel };
  }

  // scopedPhoneNumberId/scopedChannel: null quando o payload foi autenticado com o
  // secret global (Meta) — processa todos os changes. Quando autenticado com o
  // secret de UM canal (fase 2), só processa changes cujo metadata.phone_number_id
  // seja o mesmo autenticado; caso contrário um tenant poderia assinar com o próprio
  // secret e "carregar junto" um change forjado apontando para o phone_number_id de
  // outra organização.
  async process(body: any, scopedPhoneNumberId: string | null = null, scopedChannel: ScopedChannel | null = null) {
    const entries = body?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const pnid = value?.metadata?.phone_number_id;

        // defense-in-depth: payload autenticado com secret de canal só pode afetar
        // aquele canal — descarta changes com phone_number_id diferente do autenticado.
        if (scopedPhoneNumberId && pnid !== scopedPhoneNumberId) {
          this.logger.warn(
            `Change descartado: payload autenticado para ${scopedPhoneNumberId}, mas change referencia outro phone_number_id.`,
          );
          continue;
        }

        // resolve o canal dono do número (ativo, mais recente) uma vez e propaga —
        // evita que 3 queries independentes divirjam quando um número troca de dono
        // (disconnect é soft: a linha antiga do dono anterior continua existindo,
        // só com status 'disabled', então o findFirst tem que ser status-aware).
        const channel = scopedChannel && pnid === scopedPhoneNumberId
          ? scopedChannel
          : pnid
            ? await this.prisma.whatsappChannel.findFirst({
                where: { phoneNumberId: pnid, status: 'active' },
                orderBy: { createdAt: 'desc' },
              })
            : null;
        if (!channel) continue;

        for (const status of value.statuses ?? []) await this.handleStatus(status, channel.id);
        for (const message of value.messages ?? []) await this.handleInbound(message, value, channel);
      }
    }
  }

  private async handleStatus(status: any, channelId: string) {
    // status: sent | delivered | read | failed
    const waId = status.id;
    // o lookup é sempre restrito ao canal resolvido em process() — evita atualizar
    // status/contadores de campanha de outra organização.
    const msg = await this.prisma.outboundMessage.findFirst({
      where: { waMessageId: waId, channelId },
    });
    if (!msg) return;

    const now = new Date();
    const data: any = { status: status.status };
    const counter: any = {};
    if (status.status === 'delivered') { data.deliveredAt = now; counter.deliveredCount = { increment: 1 }; }
    if (status.status === 'read') { data.readAt = now; counter.readCount = { increment: 1 }; }
    if (status.status === 'sent') { data.sentAt = now; }
    if (status.status === 'failed') {
      data.errorDetail = JSON.stringify(status.errors ?? {});
      counter.failedCount = { increment: 1 };
    }
    await this.prisma.outboundMessage.update({ where: { id: msg.id }, data });
    if (msg.campaignId && Object.keys(counter).length) {
      await this.prisma.campaign.update({ where: { id: msg.campaignId }, data: counter });
    }
  }

  private async handleInbound(message: any, value: any, channel: ScopedChannel) {
    // wa_id antigo de celular BR vem sem o nono dígito — normaliza adicionando-o
    const from = normalizeBrPhone('+' + message.from);
    const text: string = (message.text?.body ?? '').trim();
    const orgId = channel.organizationId;

    // persiste a mensagem recebida (tabela inbound_messages — insert raw)
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO inbound_messages
         (organization_id, channel_id, from_phone_e164, wa_message_id, type, body, raw)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::jsonb)`,
      orgId, channel.id, from, message.id ?? null,
      message.type ?? null, text || null, JSON.stringify(message),
    );

    const contact = await this.prisma.contact.findFirst({
      where: { organizationId: orgId, phoneE164: from, deletedAt: null },
    });

    // captura o nome de perfil do WhatsApp (pushname) — só chega via webhook.
    // Guardado em attributes.whatsapp_name; {{name}} das campanhas prefere ele.
    const pushName: string | undefined = value?.contacts?.[0]?.profile?.name;
    if (contact && pushName) {
      const attrs = (contact.attributes as Record<string, any>) ?? {};
      if (attrs.whatsapp_name !== pushName) {
        await this.prisma.contact.update({
          where: { id: contact.id },
          data: { attributes: { ...attrs, whatsapp_name: pushName } },
        });
        this.logger.log(`Nome do WhatsApp capturado p/ contato ${contact.id}: ${pushName}`);
      }
    }

    // opt-out automático por palavra-chave
    if (OPT_OUT_KEYWORDS.includes(text.toLowerCase())) {
      if (contact && !contact.optedOut) {
        await this.prisma.$transaction([
          this.prisma.contact.update({
            where: { id: contact.id },
            data: { optedOut: true, optedOutAt: new Date(), consentStatus: 'opted_out' },
          }),
          this.prisma.$executeRawUnsafe(
            `INSERT INTO consent_events (organization_id, contact_id, event, source)
             VALUES ($1::uuid,$2::uuid,'opted_out','whatsapp_inbound')`,
            orgId, contact.id,
          ),
        ]);
        this.logger.log(`Opt-out registrado para contato ${contact.id}`);
      }
    }
  }
}

// varre entry[]/changes[] em busca do primeiro phone_number_id válido (pode haver
// múltiplos entries/changes no mesmo payload de webhook).
function extractPhoneNumberId(body: any): string | null {
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const phoneNumberId = change?.value?.metadata?.phone_number_id;
      if (phoneNumberId) return phoneNumberId;
    }
  }
  return null;
}

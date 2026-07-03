import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeBrPhone } from '../common/phone.util';

const OPT_OUT_KEYWORDS = ['parar', 'sair', 'stop', 'cancelar', 'descadastrar', 'unsubscribe'];

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger('Webhooks');
  constructor(private prisma: PrismaService, private config: ConfigService) {}

  // GET: handshake de verificação do webhook
  verify(mode?: string, token?: string, challenge?: string): string | null {
    const expected = this.config.get<string>('whatsapp.webhookVerifyToken');
    if (mode === 'subscribe' && token && token === expected) return challenge ?? '';
    return null;
  }

  // valida X-Hub-Signature-256 (HMAC do corpo cru com o App Secret da Meta)
  validSignature(rawBody: Buffer | undefined, signature?: string): boolean {
    const secret = this.config.get<string>('whatsapp.appSecret');
    if (!secret || !rawBody || !signature) return false;
    const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async process(body: any) {
    const entries = body?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        for (const status of value.statuses ?? []) await this.handleStatus(status);
        for (const message of value.messages ?? []) await this.handleInbound(message, value);
      }
    }
  }

  private async handleStatus(status: any) {
    // status: sent | delivered | read | failed
    const waId = status.id;
    const msg = await this.prisma.outboundMessage.findFirst({ where: { waMessageId: waId } });
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

  private async handleInbound(message: any, value: any) {
    // wa_id antigo de celular BR vem sem o nono dígito — normaliza adicionando-o
    const from = normalizeBrPhone('+' + message.from);
    const text: string = (message.text?.body ?? '').trim();
    const phoneNumberId = value?.metadata?.phone_number_id;

    const channel = phoneNumberId
      ? await this.prisma.whatsappChannel.findFirst({ where: { phoneNumberId } })
      : null;
    const orgId = channel?.organizationId;
    if (!orgId) return;

    // persiste a mensagem recebida (tabela inbound_messages — insert raw)
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO inbound_messages
         (organization_id, channel_id, from_phone_e164, wa_message_id, type, body, raw)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::jsonb)`,
      orgId, channel!.id, from, message.id ?? null,
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

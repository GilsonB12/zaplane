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
// Cache NEGATIVO: phone_number_id que não resolve para canal nenhum. Sem ele,
// cada id inexistente vira uma consulta ao Postgres a cada requisição — e como
// a rota é pública, basta variar o id no corpo para gerar consulta ilimitada.
// TTL curto para um canal recém-conectado não ficar invisível.
const CHANNEL_MISS_TTL_MS = 30 * 1000;
const CHANNEL_MISS_MAX = 10_000;

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
  /** phone_number_id que não resolve para canal → epoch ms até quando vale o "não achei" */
  private readonly missCache = new Map<string, number>();

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

    const miss = this.missCache.get(phoneNumberId);
    if (miss && miss > Date.now()) return null;

    const channel = await this.prisma.whatsappChannel.findFirst({
      where: { phoneNumberId, appSecretEnc: { not: null }, status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
    if (!channel?.appSecretEnc) {
      // id forjado ou canal ainda sem app_secret: não repetir a consulta a cada
      // requisição. O cap evita que ids forjados façam o Map crescer sem fim.
      if (this.missCache.size >= CHANNEL_MISS_MAX) this.missCache.clear();
      this.missCache.set(phoneNumberId, Date.now() + CHANNEL_MISS_TTL_MS);
      return null;
    }
    this.missCache.delete(phoneNumberId);

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

        // Alertas de conta da Meta (pagamento pendente, qualidade, restrição…).
        // Chegam SEM metadata.phone_number_id — o dono é a WABA em entry.id.
        // Precisam ser tratados antes da resolução por número, senão caem no
        // `continue` abaixo e somem (era o que acontecia).
        if (change.field === 'account_alerts') {
          await this.handleAccountAlert(entry.id, value, scopedPhoneNumberId);
          continue;
        }

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
        // Prefere o canal ATIVO (se o número mudou de dono, o novo dono é quem
        // recebe). Se nenhum estiver ativo, cai no desconectado mais recente:
        // mensagens enviadas antes da desconexão continuam recebendo entrega,
        // leitura e cobrança. Antes esses eventos eram descartados em silêncio
        // e a mensagem ficava presa em "enviada" para sempre, sem debitar.
        const channel = scopedChannel && pnid === scopedPhoneNumberId
          ? scopedChannel
          : pnid
            ? (await this.prisma.whatsappChannel.findFirst({
                where: { phoneNumberId: pnid, status: 'active' },
                orderBy: { createdAt: 'desc' },
              })) ??
              (await this.prisma.whatsappChannel.findFirst({
                where: { phoneNumberId: pnid },
                orderBy: { updatedAt: 'desc' },
              }))
            : null;
        if (!channel) continue;

        for (const status of value.statuses ?? []) await this.handleStatus(status, channel.id, channel.organizationId);
        for (const message of value.messages ?? []) await this.handleInbound(message, value, channel);
      }
    }
  }

  /** Alerta de conta da Meta (`account_alerts`) — pagamento pendente, queda de
   *  qualidade, restrição da conta. É o ÚNICO aviso que um Tech Provider
   *  recebe sobre a saúde da conta do cliente: os campos de faturamento da
   *  WABA são exclusivos de Business Solution Provider.
   *
   *  Guardamos o alerta ativo no canal para o painel exibir; quando a Meta
   *  informa que foi resolvido, limpamos. */
  private async handleAccountAlert(wabaId: string, value: any, scopedPhoneNumberId: string | null) {
    if (!wabaId) return;

    const canais = await this.prisma.whatsappChannel.findMany({
      where: { wabaId, status: 'active' },
      select: { id: true, phoneNumberId: true },
    });
    if (canais.length === 0) return;

    // se o payload veio autenticado pelo secret de um canal específico, o
    // alerta só pode afetar aquele canal (mesma defesa do fluxo de status)
    const alvos = scopedPhoneNumberId
      ? canais.filter((c) => c.phoneNumberId === scopedPhoneNumberId)
      : canais;
    if (alvos.length === 0) return;

    const resolvido = String(value?.alert_status ?? '').toUpperCase() === 'RESOLVED';
    const data = resolvido
      ? { alertSeverity: null, alertType: null, alertMessage: null, alertAt: null }
      : {
          alertSeverity: value?.alert_severity ?? 'WARNING',
          alertType: value?.alert_type ?? null,
          alertMessage: value?.alert_description ?? value?.alert_message ?? null,
          alertAt: new Date(),
        };

    await this.prisma.whatsappChannel.updateMany({
      where: { id: { in: alvos.map((c) => c.id) } },
      data,
    });
    // não logamos a descrição (pode conter dado do cliente), só o tipo
    this.logger.warn(
      `Alerta da Meta ${resolvido ? 'RESOLVIDO' : 'ATIVO'} para WABA ${wabaId} (tipo: ${value?.alert_type ?? 'n/d'}).`,
    );
  }

  private async handleStatus(status: any, channelId: string, organizationId: string) {
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
    // os contadores da campanha só podem subir na PRIMEIRA transição para cada
    // status — a Meta pode reentregar o mesmo webhook (rede instável, retry do
    // lado deles etc.), e sem essa guarda um reenvio dobraria delivered/read/
    // failed mesmo a mensagem tendo transicionado só uma vez de verdade. As
    // colunas deliveredAt/readAt/sentAt continuam sendo gravadas de forma
    // idempotente (mesmo valor em reenvios), só o incremento é que é gated.
    if (status.status === 'delivered') {
      data.deliveredAt = now;
      if (msg.deliveredAt == null) counter.deliveredCount = { increment: 1 };
    }
    if (status.status === 'read') {
      data.readAt = now;
      if (msg.readAt == null) counter.readCount = { increment: 1 };
    }
    if (status.status === 'sent') { data.sentAt = now; }
    if (status.status === 'failed') {
      data.errorDetail = JSON.stringify(status.errors ?? {});
      if (msg.status !== 'failed') counter.failedCount = { increment: 1 };
    }
    await this.prisma.outboundMessage.update({ where: { id: msg.id }, data });
    if (msg.campaignId && Object.keys(counter).length) {
      await this.prisma.campaign.update({ where: { id: msg.campaignId }, data: counter });
    }

    // --- Medição de cobrança (billing) ------------------------------------
    // A Meta reporta o custo real da mensagem no campo `pricing` do webhook
    // de status (tipicamente junto do evento "delivered"); nem todo evento
    // de status carrega `pricing` — só agimos quando presente. O guard
    // billing_recorded_at evita reprocessar reenvios do mesmo webhook.
    const pricing = status.pricing;
    if (pricing && typeof pricing.billable === 'boolean' && !msg.billingRecordedAt) {
      await this.recordPricing(pricing, msg, organizationId);
    }
  }

  // Grava billable/pricing_category/pricing_model em outbound_messages e,
  // quando a Meta efetivamente tarifou a mensagem (billable=true), debita o
  // preço fixo (BILLING_USAGE_PRICE_CENTS) da carteira pré-paga da
  // organização. Idempotente em duas camadas: (1) o caller só chama aqui se
  // billing_recorded_at ainda for NULL; (2) dentro da transação, o UNIQUE
  // parcial (organization_id, wa_message_id) WHERE kind='debit' garante que
  // nem uma corrida entre reentregas concorrentes do webhook da Meta debite
  // duas vezes a mesma mensagem.
  private async recordPricing(
    pricing: { billable: boolean; category?: string; pricing_model?: string },
    msg: { id: string; waMessageId: string | null; organizationId: string },
    organizationId: string,
  ) {
    const category = pricing.category ?? null;
    const pricingModel = pricing.pricing_model ?? null;

    if (!pricing.billable) {
      // Meta não tarifou esta mensagem — não há débito, só registramos o
      // resultado e travamos billing_recorded_at p/ não reprocessar.
      await this.prisma.outboundMessage.update({
        where: { id: msg.id },
        data: { billable: false, pricingCategory: category, pricingModel, billingRecordedAt: new Date() },
      });
      return;
    }

    // Preço por CATEGORIA (utility custa muito menos que marketing na Meta).
    // Categoria vem em minúsculas no payload da Meta ('marketing', 'utility',
    // 'authentication', 'service'…); quando ausente/desconhecida, cai no preço
    // padrão — nunca cobramos menos do que o configurado por engano.
    const byCategory = this.config.get<Record<string, number>>('billing.usagePriceByCategory') ?? {};
    const defaultPrice = this.config.get<number>('billing.usagePriceCents') ?? 43;
    const categoryKey = (category ?? '').toLowerCase();
    const priceCents = byCategory[categoryKey] ?? defaultPrice;
    const isMarketing = categoryKey === 'marketing';

    // defesa em profundidade: outbound_messages.organization_id deveria SEMPRE
    // coincidir com a organização dona do canal autenticado (ambos derivam da
    // mesma campanha/envio) — um descompasso aqui indicaria um bug grave de
    // particionamento multi-tenant. Por segurança, bloqueamos o débito
    // financeiro nesse caso (sem PII/valor no log) em vez de confiar cegamente
    // no organizationId do canal.
    if (msg.organizationId && msg.organizationId !== organizationId) {
      this.logger.warn('recordPricing: organização da mensagem diverge da organização do canal — débito bloqueado.');
      await this.prisma.outboundMessage.update({
        where: { id: msg.id },
        data: { billable: true, pricingCategory: category, pricingModel, billingRecordedAt: new Date() },
      });
      return;
    }

    if (!msg.waMessageId) {
      // sem wa_message_id não há chave de idempotência confiável para o
      // débito (não deveria ocorrer — todo status da Meta traz `id`).
      // Por segurança gravamos o pricing e não debitamos, evitando um
      // débito não rastreável.
      this.logger.warn('Status com pricing.billable=true sem wa_message_id — débito ignorado.');
      await this.prisma.outboundMessage.update({
        where: { id: msg.id },
        data: { billable: true, pricingCategory: category, pricingModel, billingRecordedAt: new Date() },
      });
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      // Cota de marketing inclusa na assinatura: se ainda houver saldo de
      // cota, esta mensagem de marketing não debita a taxa Zaplane. A linha da
      // assinatura é travada (FOR UPDATE) para que dois webhooks concorrentes
      // não consumam a mesma unidade da cota duas vezes.
      let usouCota = false;
      if (isMarketing) {
        const subRows = await tx.$queryRawUnsafe<Array<{ id: string; free_marketing_remaining: number }>>(
          `SELECT id, free_marketing_remaining FROM subscriptions
            WHERE organization_id = $1::uuid FOR UPDATE`,
          organizationId,
        );
        const sub = subRows[0];
        if (sub && sub.free_marketing_remaining > 0) {
          await tx.$executeRawUnsafe(
            `UPDATE subscriptions SET free_marketing_remaining = free_marketing_remaining - 1
              WHERE id = $1::uuid`,
            sub.id,
          );
          usouCota = true;
        }
      }

      // trava a linha da carteira da organização (se existir) — evita corrida
      // entre débitos concorrentes calculando balance_after_cents errado.
      const walletRows = await tx.$queryRawUnsafe<Array<{ balance_cents: number }>>(
        'SELECT balance_cents FROM wallets WHERE organization_id = $1::uuid FOR UPDATE',
        organizationId,
      );
      const hasWallet = walletRows.length > 0;
      const currentBalance = walletRows[0]?.balance_cents ?? 0;
      // CHECK(balance_cents >= 0): nunca deixamos o saldo ir negativo. Quando o
      // saldo é insuficiente (currentBalance < priceCents), o débito é
      // "clampado" em currentBalance (deduz só o que existe) em vez do
      // priceCents cheio. Isso é um PALIATIVO (stopgap): a pré-checagem de
      // saldo da B2 (assertBalanceFor, antes de enfileirar a mensagem) deve
      // tornar este caminho inatingível na prática — o envio é bloqueado antes
      // de a Meta chegar a tarifar. Mesmo assim, para manter o livro-razão
      // auditável, registramos a diferença não coberta em `metadata.shortfall_cents`.
      // valor efetivamente cobrado: zero quando a mensagem saiu pela cota inclusa
      const cobrarCents = usouCota ? 0 : priceCents;
      const newBalance = Math.max(currentBalance - cobrarCents, 0);
      const actuallyDeducted = currentBalance - newBalance;
      const shortfallCents = cobrarCents - actuallyDeducted;
      const metadata: Record<string, unknown> = {};
      if (shortfallCents > 0) metadata.shortfall_cents = shortfallCents;
      if (usouCota) metadata.cota_inclusa = true;
      if (categoryKey) metadata.categoria = categoryKey;

      // amount_cents registra o que SAIU da carteira (não o preço de tabela),
      // para que o livro-razão reconcilie: saldo_anterior - amount = balance_after.
      // O que ficou a descoberto vive em metadata.shortfall_cents.
      const inserted = await tx.$queryRawUnsafe<Array<{ id: bigint }>>(
        `INSERT INTO wallet_transactions
           (organization_id, kind, amount_cents, balance_after_cents, reason, outbound_message_id, wa_message_id, metadata)
         VALUES ($1::uuid, 'debit', $2::int, $3::int, 'message', $4::uuid, $5, $6::jsonb)
         ON CONFLICT (organization_id, wa_message_id) WHERE kind = 'debit' DO NOTHING
         RETURNING id`,
        organizationId, actuallyDeducted, newBalance, msg.id, msg.waMessageId, JSON.stringify(metadata),
      );

      if (inserted.length > 0 && hasWallet) {
        await tx.$executeRawUnsafe(
          'UPDATE wallets SET balance_cents = $2::int WHERE organization_id = $1::uuid',
          organizationId, newBalance,
        );
      } else if (inserted.length > 0 && !hasWallet) {
        // carteira ainda não provisionada para a org — registra o débito no
        // livro-razão (histórico correto), mas não há saldo para atualizar.
        this.logger.warn('Débito registrado sem carteira provisionada para a organização.');
      }

      await tx.outboundMessage.update({
        where: { id: msg.id },
        data: { billable: true, pricingCategory: category, pricingModel, billingRecordedAt: new Date() },
      });
    });
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

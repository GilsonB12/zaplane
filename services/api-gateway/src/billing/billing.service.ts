import { HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  NormalizedEvent,
  PAYMENT_PROVIDER,
  PaymentProviderAdapter,
} from './providers/payment-provider.interface';
import { BuyCreditsDto } from './dto/buy-credits.dto';

// Prisma $transaction: as transações de ativação de assinatura/compra de
// créditos fazem chamadas HTTP síncronas ao Asaas DENTRO da transação (de
// propósito — é o que serializa a criação de customer/subscription por
// organização, Fix I3 do review B3). O timeout/maxWait padrão do Prisma
// (5s/2s) é curto demais para isso; o axios do AsaasProvider já tem seu
// próprio timeout de 15s por chamada.
const PROVIDER_CALL_TX_OPTS = { timeout: 30_000, maxWait: 10_000 };

@Injectable()
export class BillingService {
  private readonly logger = new Logger('Billing');

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProviderAdapter,
  ) {}

  /** Resumo p/ o painel: assinatura + saldo da carteira + últimos pagamentos
   *  (com paymentUrl, para o painel linkar cobranças pendentes/vencidas). */
  async getSummary(orgId: string) {
    const [subscription, wallet, recentPayments] = await Promise.all([
      this.prisma.subscription.findUnique({ where: { organizationId: orgId } }),
      this.prisma.wallet.findUnique({ where: { organizationId: orgId } }),
      this.prisma.payment.findMany({
        where: { organizationId: orgId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    const mappedPayments = recentPayments.map((p) => ({
      id: p.id,
      kind: p.kind,
      amountCents: p.amountCents,
      creditedCents: p.creditedCents,
      status: p.status,
      method: p.method,
      paymentUrl: p.providerUrl,
      dueAt: p.dueAt,
      paidAt: p.paidAt,
      createdAt: p.createdAt,
    }));

    return {
      subscription: subscription
        ? {
            status: subscription.status,
            currentPeriodEnd: subscription.currentPeriodEnd,
            priceCents: subscription.priceCents,
            gracePeriodEndsAt: subscription.gracePeriodEndsAt,
          }
        : null,
      wallet: { balanceCents: wallet?.balanceCents ?? 0 },
      recentPayments: mappedPayments,
      // conveniência p/ o painel: cobranças que ainda precisam de ação do
      // usuário (pagar), já com o link de pagamento em destaque.
      pendingPayments: mappedPayments.filter((p) => p.status === 'pending' || p.status === 'overdue'),
    };
  }

  /** Saldo + extrato (últimas 50 transações do livro-razão). */
  async getWallet(orgId: string) {
    const [wallet, transactions] = await Promise.all([
      this.prisma.wallet.findUnique({ where: { organizationId: orgId } }),
      this.prisma.walletTransaction.findMany({
        where: { organizationId: orgId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    return {
      balanceCents: wallet?.balanceCents ?? 0,
      transactions: transactions.map((t) => ({
        id: t.id.toString(),
        kind: t.kind,
        amountCents: t.amountCents,
        balanceAfterCents: t.balanceAfterCents,
        reason: t.reason,
        waMessageId: t.waMessageId,
        createdAt: t.createdAt,
      })),
    };
  }

  async getSubscription(orgId: string) {
    const sub = await this.prisma.subscription.findUnique({ where: { organizationId: orgId } });
    if (!sub) return null;
    return {
      status: sub.status,
      provider: sub.provider,
      priceCents: sub.priceCents,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      gracePeriodEndsAt: sub.gracePeriodEndsAt,
      canceledAt: sub.canceledAt,
    };
  }

  /** Pré-checagem de saldo (read-only): bloqueia ANTES do disparo quando a
   *  carteira não cobre o custo estimado (elegíveis x usagePrice em campanhas,
   *  ou usagePrice fixo em envio avulso). O débito real só ocorre depois, via
   *  webhook (recordPricing em webhooks.service.ts), quando a Meta confirma
   *  billable=true — aqui só garantimos que o teto existe. Sem lock: uma
   *  leitura desatualizada no pior caso permite um envio a mais, que o
   *  webhook não vai debitar além do saldo (CHECK balance_cents >= 0).
   */
  async assertBalanceFor(orgId: string, cents: number): Promise<void> {
    const wallet = await this.prisma.wallet.findUnique({ where: { organizationId: orgId } });
    const balance = wallet?.balanceCents ?? 0;
    if (balance < cents) {
      throw new HttpException(
        { code: 'INSUFFICIENT_CREDITS', message: 'Saldo de créditos insuficiente.', needed: cents, balance },
        402,
      );
    }
  }

  get usagePriceCents(): number {
    return this.config.get<number>('billing.usagePriceCents') ?? 43;
  }

  get subscriptionPriceCents(): number {
    return this.config.get<number>('billing.subscriptionPriceCents') ?? 13500;
  }

  // -----------------------------------------------------------------------
  // B3 — Asaas: ativação de assinatura e compra de créditos
  // -----------------------------------------------------------------------

  /** Garante customer + subscription no Asaas p/ a organização e retorna o
   *  link de pagamento da 1ª cobrança. A assinatura permanece 'inactive' no
   *  nosso banco até o webhook confirmar o 1º pagamento — só o provedor sabe
   *  quando o Pix/boleto/cartão foi de fato pago. Idempotente: chamadas
   *  repetidas não criam customer/subscription duplicados no Asaas (reusa
   *  provider_customer_id/provider_subscription_id já persistidos).
   *
   *  Fix I3 (review B3): a leitura+decisão+escrita de
   *  provider_customer_id/provider_subscription_id acontece inteira dentro
   *  de UMA transação com `SELECT ... FOR UPDATE` na linha de subscriptions
   *  da organização. Sem isso, um duplo-clique (duas requisições quase
   *  simultâneas) poderia ambas ler providerSubscriptionId=null e criar DUAS
   *  assinaturas no Asaas para a mesma organização. Com a trava, a segunda
   *  requisição só prossegue depois que a primeira commita — e nesse ponto já
   *  vê os IDs preenchidos, então não cria de novo.
   */
  async activateSubscription(orgId: string, actorEmail: string | null): Promise<{ paymentUrl: string | null }> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundException('Organização não encontrada.');

    // garante a linha fora da trava — caso defensivo (normalmente já existe
    // desde o cadastro, criada em auth.service.ts); não há corrida real aqui
    // porque orgId é único por chamador autenticado, mas o create pode
    // colidir em teoria — deixamos o erro de UNIQUE subir se acontecer.
    const existing = await this.prisma.subscription.findUnique({ where: { organizationId: orgId } });
    if (!existing) {
      await this.prisma.subscription.create({
        data: { organizationId: orgId, status: 'inactive', provider: 'asaas', priceCents: this.subscriptionPriceCents },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        Array<{
          id: string;
          provider_customer_id: string | null;
          provider_subscription_id: string | null;
          price_cents: number;
        }>
      >(
        `SELECT id, provider_customer_id, provider_subscription_id, price_cents
         FROM subscriptions WHERE organization_id = $1::uuid FOR UPDATE`,
        orgId,
      );
      const locked = rows[0];
      if (!locked) throw new NotFoundException('Assinatura não encontrada.');

      let providerCustomerId = locked.provider_customer_id;
      if (!providerCustomerId) {
        const created = await this.provider.createCustomer({
          id: orgId,
          name: org.name,
          email: actorEmail,
          cpfCnpj: null,
        });
        providerCustomerId = created.providerCustomerId;
        await tx.subscription.update({
          where: { id: locked.id },
          data: { providerCustomerId, provider: 'asaas' },
        });
      }

      if (!locked.provider_subscription_id) {
        const result = await this.provider.createSubscription({
          customerId: providerCustomerId,
          priceCents: locked.price_cents,
          orgId,
        });
        await tx.subscription.update({
          where: { id: locked.id },
          data: { providerSubscriptionId: result.providerSubscriptionId, provider: 'asaas' },
        });

        if (result.providerPaymentId) {
          await tx.payment.create({
            data: {
              organizationId: orgId,
              subscriptionId: locked.id,
              kind: 'subscription',
              amountCents: locked.price_cents,
              status: 'pending',
              provider: 'asaas',
              providerPaymentId: result.providerPaymentId,
              providerUrl: result.paymentUrl,
              dueAt: result.dueDate ? new Date(result.dueDate) : null,
            },
          });
        }
        return { paymentUrl: result.paymentUrl };
      }

      // assinatura já existe no Asaas — não cria de novo; devolve o link da
      // cobrança pendente mais recente (se houver) do nosso próprio registro.
      const pending = await tx.payment.findFirst({
        where: { subscriptionId: locked.id, kind: 'subscription', status: { in: ['pending', 'overdue'] } },
        orderBy: { createdAt: 'desc' },
      });
      return { paymentUrl: pending?.providerUrl ?? null };
    }, PROVIDER_CALL_TX_OPTS);
  }

  /** Inicia a compra de créditos: cria uma cobrança avulsa no Asaas e uma
   *  linha `payments` pendente. A carteira só é creditada quando o webhook
   *  confirmar o pagamento (processProviderEvent).
   *
   *  Fix I3 (review B3, "menor impacto"): a criação do customer Asaas usa a
   *  mesma trava (`SELECT ... FOR UPDATE` em subscriptions) de
   *  activateSubscription, para não criar dois customers no Asaas por
   *  corrida (duplo clique aqui, ou entre esta chamada e activateSubscription
   *  concorrente para a mesma organização). */
  async buyCredits(orgId: string, dto: BuyCreditsDto): Promise<{ paymentUrl: string | null; paymentId: string }> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundException('Organização não encontrada.');

    const providerCustomerId = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ id: string; provider_customer_id: string | null }>>(
        'SELECT id, provider_customer_id FROM subscriptions WHERE organization_id = $1::uuid FOR UPDATE',
        orgId,
      );
      let locked = rows[0];

      if (!locked) {
        // caso defensivo (não deveria ocorrer — provisionado no cadastro).
        const created = await tx.subscription.create({
          data: { organizationId: orgId, status: 'inactive', provider: 'asaas', priceCents: this.subscriptionPriceCents },
        });
        locked = { id: created.id, provider_customer_id: null };
      }

      if (locked.provider_customer_id) return locked.provider_customer_id;

      const created = await this.provider.createCustomer({ id: orgId, name: org.name, email: null, cpfCnpj: null });
      await tx.subscription.update({ where: { id: locked.id }, data: { providerCustomerId: created.providerCustomerId } });
      return created.providerCustomerId;
    }, PROVIDER_CALL_TX_OPTS);

    const amountCents = dto.amountCents;
    const charge = await this.provider.createCharge({
      customerId: providerCustomerId,
      amountCents,
      orgId,
      description: `Compra de créditos Zaplane — R$ ${(amountCents / 100).toFixed(2)}`,
    });

    const payment = await this.prisma.payment.create({
      data: {
        organizationId: orgId,
        kind: 'credit_topup',
        amountCents,
        creditedCents: amountCents,
        status: 'pending',
        provider: 'asaas',
        providerPaymentId: charge.providerPaymentId,
        providerUrl: charge.paymentUrl,
        dueAt: new Date(charge.dueDate),
      },
    });

    return { paymentUrl: charge.paymentUrl, paymentId: payment.id };
  }

  // -----------------------------------------------------------------------
  // Webhook do provedor (POST /webhooks/billing/asaas) — ver
  // billing-webhook.controller.ts p/ a validação do header de autenticidade.
  // -----------------------------------------------------------------------

  /** Processa um evento normalizado do provedor. Idempotente via
   *  subscription_events (UNIQUE provider+provider_event_id): eventos já
   *  vistos saem sem reprocessar (nem re-creditar carteira, nem duplicar
   *  transição de assinatura).
   *
   *  Fix I1 (review B3): a organização é resolvida a partir do NOSSO banco
   *  (payments.organization_id / subscriptions.organization_id via
   *  provider_payment_id/provider_subscription_id), nunca do
   *  `externalReference` do corpo do webhook. O corpo só serve de fallback
   *  quando ainda não existe nenhuma linha nossa vinculada; e se ele
   *  divergir do dono real de uma linha que existe, o evento é rejeitado.
   *
   *  Fix C1 (review B3, parte 2): antes de autorizar handlePaymentConfirmed
   *  a mover dinheiro, re-consultamos o pagamento diretamente no Asaas
   *  (nunca confiamos só no `event.type` derivado do corpo do webhook) e só
   *  prosseguimos se o provedor confirmar CONFIRMED/RECEIVED. */
  async processProviderEvent(event: NormalizedEvent): Promise<void> {
    const subscriptionBySubId = event.providerSubscriptionId
      ? await this.prisma.subscription.findFirst({ where: { providerSubscriptionId: event.providerSubscriptionId } })
      : null;

    const existingPayment = event.providerPaymentId
      ? await this.prisma.payment.findFirst({ where: { provider: 'asaas', providerPaymentId: event.providerPaymentId } })
      : null;

    const rowOrgId = existingPayment?.organizationId ?? subscriptionBySubId?.organizationId ?? null;
    let orgId: string | null;
    if (rowOrgId) {
      orgId = rowOrgId;
      if (event.orgId && event.orgId !== rowOrgId) {
        this.logger.warn(
          `Webhook Asaas: externalReference do corpo (org ${event.orgId}) diverge do dono real (org ${rowOrgId}) ` +
            `do pagamento/assinatura vinculado(a) a ${event.providerPaymentId ?? event.providerSubscriptionId} — ` +
            `evento REJEITADO, sem movimentação de dinheiro.`,
        );
        return;
      }
    } else {
      orgId = event.orgId ?? null;
    }

    if (!orgId) {
      this.logger.warn(
        `Webhook Asaas: não foi possível resolver a organização do evento ${event.type} (${event.idempotencyKey}) — ignorado.`,
      );
      return;
    }

    const subscription =
      subscriptionBySubId ?? (await this.prisma.subscription.findUnique({ where: { organizationId: orgId } }));

    // Fix C1 (parte 2, a defesa real): mesmo com o header do webhook válido,
    // NUNCA decidimos crédito/ativação só pelo `event.type` — re-consultamos
    // o pagamento na API do Asaas e exigimos status CONFIRMED/RECEIVED. Um
    // PAYMENT_CONFIRMED forjado (token vazado/adivinhado) referenciando uma
    // cobrança que o Asaas ainda reporta como PENDING (ou 404) não credita
    // nem ativa nada — o evento ainda é registrado (idempotência), só sem
    // efeito financeiro.
    let verifiedStatus: string | null = null;
    let verifiedOk = false;
    if (event.type === 'payment_confirmed') {
      if (event.providerPaymentId) {
        const verified = await this.provider.getPayment(event.providerPaymentId);
        verifiedStatus = verified?.status ?? null;
        verifiedOk = verified != null && (verified.status === 'CONFIRMED' || verified.status === 'RECEIVED');
        if (!verifiedOk) {
          this.logger.warn(
            `Webhook Asaas: payment_confirmed para ${event.providerPaymentId} não confirmado na re-consulta ao ` +
              `provedor (status=${verifiedStatus ?? 'não encontrado'}) — evento registrado (idempotência), sem crédito/ativação.`,
          );
        }
      } else {
        this.logger.warn(
          'Webhook Asaas: payment_confirmed sem providerPaymentId — impossível re-verificar, sem crédito/ativação.',
        );
      }
    }

    // Fix M1 (review B3): metadata TRIMADA (sem PII do payload cru — o
    // corpo do Asaas pode trazer customer.name/email/cpfCnpj aninhado).
    // Só campos de auditoria não-sensíveis.
    const trimmedMetadata = {
      provider_event: event.raw?.event ?? null,
      payment_id: event.providerPaymentId,
      subscription_id: event.providerSubscriptionId,
      amount_cents: event.amountCents,
      verified_status: verifiedStatus,
    };

    await this.prisma.$transaction(async (tx) => {
      // idempotência: INSERT ... ON CONFLICT DO NOTHING no evento; se a
      // linha já existia (reenvio do mesmo evento pelo Asaas), sai sem
      // reprocessar nada (sem re-creditar carteira / re-transicionar status).
      const inserted = await tx.$queryRawUnsafe<Array<{ id: bigint }>>(
        `INSERT INTO subscription_events (organization_id, subscription_id, event, provider, provider_event_id, metadata)
         VALUES ($1::uuid, $2::uuid, $3, 'asaas', $4, $5::jsonb)
         ON CONFLICT (provider, provider_event_id) DO NOTHING
         RETURNING id`,
        orgId,
        subscription?.id ?? null,
        event.type,
        event.idempotencyKey,
        JSON.stringify(trimmedMetadata),
      );
      if (inserted.length === 0) return;

      if (event.type === 'payment_confirmed') {
        if (!verifiedOk) return; // Fix C1: sem confirmação real do provedor, dinheiro não se move
        await this.handlePaymentConfirmed(tx, orgId!, subscription, event, existingPayment);
      } else if (event.type === 'payment_overdue') {
        await this.handlePaymentOverdue(tx, orgId!, subscription, event, existingPayment);
      } else if (event.type === 'subscription_canceled') {
        await this.handleSubscriptionCanceled(tx, subscription);
      }
    });
  }

  private async handlePaymentConfirmed(
    tx: Prisma.TransactionClient,
    orgId: string,
    subscription: { id: string; providerSubscriptionId: string | null; priceCents: number; currentPeriodEnd: Date | null } | null,
    event: NormalizedEvent,
    existingPayment: { id: string; kind: string; status: string; creditedCents: number | null; amountCents: number } | null,
  ): Promise<void> {
    const isCreditTopup = existingPayment?.kind === 'credit_topup';

    if (isCreditTopup) {
      // Fix I2 (review B3): trava a linha do PRÓPRIO pagamento — a defesa
      // primária contra PAYMENT_CONFIRMED + PAYMENT_RECEIVED (ou reentregas)
      // chegando quase juntos para a MESMA cobrança. subscription_events só
      // dedupe pelo id do evento (diferente entre os dois), não pelo
      // pagamento em si — sem esta trava, duas transações concorrentes
      // poderiam ambas ler status='pending' antes de qualquer uma commitar.
      const paymentRows = await tx.$queryRawUnsafe<Array<{ status: string }>>(
        'SELECT status FROM payments WHERE id = $1::uuid FOR UPDATE',
        existingPayment!.id,
      );
      if (paymentRows[0]?.status === 'paid') return; // já creditado — idempotente

      const now = new Date();
      await tx.payment.update({ where: { id: existingPayment!.id }, data: { status: 'paid', paidAt: now } });

      const creditCents = existingPayment!.creditedCents ?? existingPayment!.amountCents;

      // trava a linha da carteira p/ crédito relativo consistente (mesmo
      // padrão do débito em webhooks.service.ts recordPricing).
      const walletRows = await tx.$queryRawUnsafe<Array<{ balance_cents: number }>>(
        'SELECT balance_cents FROM wallets WHERE organization_id = $1::uuid FOR UPDATE',
        orgId,
      );
      const hasWallet = walletRows.length > 0;
      const currentBalance = walletRows[0]?.balance_cents ?? 0;
      const newBalance = currentBalance + creditCents;

      // Fix I2, segunda camada de defesa: UNIQUE parcial (payment_id) WHERE
      // reason='topup' (migração 006) garante no próprio banco que este
      // payment_id só gera UMA linha de crédito no livro-razão, mesmo que a
      // trava acima falhe por algum motivo. Só mexemos no saldo (incremento
      // RELATIVO, não absoluto) se a linha tiver sido de fato inserida.
      const inserted = await tx.$queryRawUnsafe<Array<{ id: bigint }>>(
        `INSERT INTO wallet_transactions (organization_id, kind, amount_cents, balance_after_cents, reason, payment_id, metadata)
         VALUES ($1::uuid, 'credit', $2::int, $3::int, 'topup', $4::uuid, $5::jsonb)
         ON CONFLICT (payment_id) WHERE reason = 'topup' DO NOTHING
         RETURNING id`,
        orgId,
        creditCents,
        newBalance,
        existingPayment!.id,
        JSON.stringify({ provider_payment_id: event.providerPaymentId }),
      );

      if (inserted.length === 0) return; // outra transação já creditou este payment_id — não duplica

      if (hasWallet) {
        await tx.$executeRawUnsafe(
          'UPDATE wallets SET balance_cents = balance_cents + $2::int WHERE organization_id = $1::uuid',
          orgId,
          creditCents,
        );
      } else {
        await tx.$executeRawUnsafe(
          'INSERT INTO wallets (organization_id, balance_cents) VALUES ($1::uuid, $2::int)',
          orgId,
          creditCents,
        );
      }
      return;
    }

    // pagamento de assinatura (1ª cobrança ou renovação mensal)
    if (!subscription) {
      this.logger.warn(`payment_confirmed sem assinatura resolvida para a org ${orgId} — ignorado.`);
      return;
    }

    const now = new Date();
    // Fix M3 (review B3): a base do novo período é max(now, current_period_end)
    // — nunca sempre "now". Sem isso, um pagamento confirmado um pouco ANTES
    // do vencimento do período vigente (ou um evento duplicado —
    // PAYMENT_CONFIRMED + PAYMENT_RECEIVED para a mesma cobrança, chamando
    // handlePaymentConfirmed duas vezes) reiniciaria o relógio a partir de
    // "agora", encurtando (drift) ou sobrepondo (overlap) o período em vez de
    // encadear corretamente a partir do fim do período atual.
    const base =
      subscription.currentPeriodEnd && subscription.currentPeriodEnd > now ? subscription.currentPeriodEnd : now;
    const periodEnd = new Date(base);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'active',
        currentPeriodStart: base,
        currentPeriodEnd: periodEnd,
        gracePeriodEndsAt: null,
        provider: 'asaas',
      },
    });

    if (existingPayment) {
      await tx.payment.update({ where: { id: existingPayment.id }, data: { status: 'paid', paidAt: now } });
    } else {
      // renovação mensal: o Asaas gera um novo `payment` que nunca passou
      // pelo nosso buyCredits/activateSubscription — registramos agora.
      await tx.payment.create({
        data: {
          organizationId: orgId,
          subscriptionId: subscription.id,
          kind: 'subscription',
          amountCents: event.amountCents ?? subscription.priceCents,
          status: 'paid',
          provider: 'asaas',
          providerPaymentId: event.providerPaymentId,
          paidAt: now,
        },
      });
    }
  }

  private async handlePaymentOverdue(
    tx: Prisma.TransactionClient,
    orgId: string,
    subscription: { id: string; priceCents: number } | null,
    event: NormalizedEvent,
    existingPayment: { id: string; kind: string } | null,
  ): Promise<void> {
    const isCreditTopup = existingPayment?.kind === 'credit_topup';

    if (isCreditTopup) {
      await tx.payment.update({ where: { id: existingPayment!.id }, data: { status: 'overdue' } });
      return; // créditos vencidos não afetam a assinatura
    }

    if (!subscription) {
      this.logger.warn(`payment_overdue sem assinatura resolvida para a org ${orgId} — ignorado.`);
      return;
    }

    const graceEndsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 dias de carência

    await tx.subscription.update({
      where: { id: subscription.id },
      data: { status: 'past_due', gracePeriodEndsAt: graceEndsAt },
    });

    if (existingPayment) {
      await tx.payment.update({ where: { id: existingPayment.id }, data: { status: 'overdue' } });
    } else {
      await tx.payment.create({
        data: {
          organizationId: orgId,
          subscriptionId: subscription.id,
          kind: 'subscription',
          amountCents: event.amountCents ?? subscription.priceCents,
          status: 'overdue',
          provider: 'asaas',
          providerPaymentId: event.providerPaymentId,
        },
      });
    }
  }

  private async handleSubscriptionCanceled(
    tx: Prisma.TransactionClient,
    subscription: { id: string } | null,
  ): Promise<void> {
    if (!subscription) return;
    await tx.subscription.update({
      where: { id: subscription.id },
      data: { status: 'canceled', canceledAt: new Date() },
    });
  }
}

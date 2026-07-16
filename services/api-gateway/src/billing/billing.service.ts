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
   */
  async activateSubscription(orgId: string, actorEmail: string | null): Promise<{ paymentUrl: string | null }> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundException('Organização não encontrada.');

    let sub = await this.prisma.subscription.findUnique({ where: { organizationId: orgId } });
    if (!sub) {
      // não deveria ocorrer (auth.service.ts sempre cria a linha no
      // registro), mas cobrimos o caso defensivamente.
      sub = await this.prisma.subscription.create({
        data: { organizationId: orgId, status: 'inactive', provider: 'asaas', priceCents: this.subscriptionPriceCents },
      });
    }

    let providerCustomerId = sub.providerCustomerId;
    if (!providerCustomerId) {
      const created = await this.provider.createCustomer({
        id: orgId,
        name: org.name,
        email: actorEmail,
        cpfCnpj: null,
      });
      providerCustomerId = created.providerCustomerId;
      sub = await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { providerCustomerId, provider: 'asaas' },
      });
    }

    if (!sub.providerSubscriptionId) {
      const result = await this.provider.createSubscription({
        customerId: providerCustomerId,
        priceCents: sub.priceCents,
        orgId,
      });
      sub = await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { providerSubscriptionId: result.providerSubscriptionId, provider: 'asaas' },
      });

      if (result.providerPaymentId) {
        await this.prisma.payment.create({
          data: {
            organizationId: orgId,
            subscriptionId: sub.id,
            kind: 'subscription',
            amountCents: sub.priceCents,
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
    const pending = await this.prisma.payment.findFirst({
      where: { subscriptionId: sub.id, kind: 'subscription', status: { in: ['pending', 'overdue'] } },
      orderBy: { createdAt: 'desc' },
    });
    return { paymentUrl: pending?.providerUrl ?? null };
  }

  /** Inicia a compra de créditos: cria uma cobrança avulsa no Asaas e uma
   *  linha `payments` pendente. A carteira só é creditada quando o webhook
   *  confirmar o pagamento (processProviderEvent). */
  async buyCredits(orgId: string, dto: BuyCreditsDto): Promise<{ paymentUrl: string | null; paymentId: string }> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundException('Organização não encontrada.');

    let sub = await this.prisma.subscription.findUnique({ where: { organizationId: orgId } });
    let providerCustomerId = sub?.providerCustomerId ?? null;

    if (!providerCustomerId) {
      const created = await this.provider.createCustomer({ id: orgId, name: org.name, email: null, cpfCnpj: null });
      providerCustomerId = created.providerCustomerId;
      if (sub) {
        sub = await this.prisma.subscription.update({ where: { id: sub.id }, data: { providerCustomerId } });
      } else {
        sub = await this.prisma.subscription.create({
          data: {
            organizationId: orgId,
            status: 'inactive',
            provider: 'asaas',
            priceCents: this.subscriptionPriceCents,
            providerCustomerId,
          },
        });
      }
    }

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
   *  transição de assinatura). */
  async processProviderEvent(event: NormalizedEvent): Promise<void> {
    let orgId = event.orgId;
    let subscription = event.providerSubscriptionId
      ? await this.prisma.subscription.findFirst({ where: { providerSubscriptionId: event.providerSubscriptionId } })
      : null;
    if (!orgId && subscription) orgId = subscription.organizationId;

    let existingPayment = event.providerPaymentId
      ? await this.prisma.payment.findFirst({ where: { provider: 'asaas', providerPaymentId: event.providerPaymentId } })
      : null;
    if (!orgId && existingPayment) orgId = existingPayment.organizationId;

    if (!orgId) {
      this.logger.warn(
        `Webhook Asaas: não foi possível resolver a organização do evento ${event.type} (${event.idempotencyKey}) — ignorado.`,
      );
      return;
    }

    if (!subscription) {
      subscription = await this.prisma.subscription.findUnique({ where: { organizationId: orgId } });
    }

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
        JSON.stringify({ raw: event.raw }),
      );
      if (inserted.length === 0) return;

      if (event.type === 'payment_confirmed') {
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
    subscription: { id: string; providerSubscriptionId: string | null; priceCents: number } | null,
    event: NormalizedEvent,
    existingPayment: { id: string; kind: string; status: string; creditedCents: number | null; amountCents: number } | null,
  ): Promise<void> {
    const isCreditTopup = existingPayment?.kind === 'credit_topup';

    if (isCreditTopup) {
      if (existingPayment!.status === 'paid') return; // já creditado — idempotente
      const now = new Date();
      await tx.payment.update({ where: { id: existingPayment!.id }, data: { status: 'paid', paidAt: now } });

      const creditCents = existingPayment!.creditedCents ?? existingPayment!.amountCents;

      // trava a linha da carteira p/ crédito relativo consistente (mesmo
      // padrão do débito em webhooks.service.ts recordPricing).
      const walletRows = await tx.$queryRawUnsafe<Array<{ balance_cents: number }>>(
        'SELECT balance_cents FROM wallets WHERE organization_id = $1::uuid FOR UPDATE',
        orgId,
      );
      const currentBalance = walletRows[0]?.balance_cents ?? 0;
      const newBalance = currentBalance + creditCents;

      if (walletRows.length === 0) {
        await tx.$executeRawUnsafe(
          'INSERT INTO wallets (organization_id, balance_cents) VALUES ($1::uuid, $2::int)',
          orgId,
          creditCents,
        );
      } else {
        await tx.$executeRawUnsafe(
          'UPDATE wallets SET balance_cents = $2::int WHERE organization_id = $1::uuid',
          orgId,
          newBalance,
        );
      }

      await tx.$executeRawUnsafe(
        `INSERT INTO wallet_transactions (organization_id, kind, amount_cents, balance_after_cents, reason, payment_id, metadata)
         VALUES ($1::uuid, 'credit', $2::int, $3::int, 'topup', $4::uuid, $5::jsonb)`,
        orgId,
        creditCents,
        newBalance,
        existingPayment!.id,
        JSON.stringify({ provider_payment_id: event.providerPaymentId }),
      );
      return;
    }

    // pagamento de assinatura (1ª cobrança ou renovação mensal)
    if (!subscription) {
      this.logger.warn(`payment_confirmed sem assinatura resolvida para a org ${orgId} — ignorado.`);
      return;
    }

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'active',
        currentPeriodStart: now,
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

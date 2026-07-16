import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BillingService {
  constructor(private prisma: PrismaService, private config: ConfigService) {}

  /** Resumo p/ o painel: assinatura + saldo da carteira + últimos pagamentos. */
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
      recentPayments: recentPayments.map((p) => ({
        id: p.id,
        kind: p.kind,
        amountCents: p.amountCents,
        creditedCents: p.creditedCents,
        status: p.status,
        method: p.method,
        dueAt: p.dueAt,
        paidAt: p.paidAt,
        createdAt: p.createdAt,
      })),
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

  /** Compra de créditos — stub até a integração Asaas (B3). */
  async buyCredits(_orgId: string, _dto: { amountCents: number }): Promise<never> {
    throw new HttpException(
      { code: 'NOT_IMPLEMENTED', message: 'Compra de créditos disponível em breve (Asaas).' },
      501,
    );
  }
}

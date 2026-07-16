import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { REQUIRE_ACTIVE_SUBSCRIPTION_KEY } from '../decorators/subscription.decorator';

interface CacheEntry {
  status: string;
  provider: string;
  currentPeriodEnd: Date | null;
  graceEndsAt: Date | null;
  expiresAt: number;
}

// TTL do cache em memória (padrão do secretCache em webhooks.service.ts) —
// evita 1 SELECT por request em rotas quentes (criar campanha/enviar), ao
// custo de até 60s de atraso para refletir uma reativação/cancelamento.
const SUBSCRIPTION_CACHE_TTL_MS = 60 * 1000;

/**
 * Bloqueia (HTTP 402) ações pagas (criar campanha, enviar) quando a
 * assinatura da organização não está ativa. Permite 'active' e também
 * 'past_due' enquanto grace_period_ends_at ainda não passou (carência de
 * 5 dias após vencimento, decisão da spec). Degradação preguiçosa (sem
 * cron): ao encontrar 'past_due' com carência já vencida, primeiro rebaixa
 * para 'canceled' no banco e então trata como bloqueado.
 *
 * status='active' só é aceito quando provider='manual' (orgs grandfathered
 * pela migração 005, sem integração Asaas real) OU quando
 * current_period_end é null OU ainda não passou. Sem essa checagem, uma
 * assinatura Asaas que ficou 'active' no 1º pagamento confirmado
 * continuaria liberando envios para sempre, mesmo após o período pago
 * vencer sem o próximo pagamento ter sido confirmado ainda (o correto é
 * cair para 'past_due'+carência via webhook payment_overdue — mas até esse
 * webhook chegar, current_period_end vencido já deve bloquear).
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private reflector: Reflector, private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_ACTIVE_SUBSCRIPTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const req = context.switchToHttp().getRequest();
    const orgId: string | undefined = req.user?.organizationId;
    if (!orgId) {
      // sem usuário autenticado aqui é bug de ordenação de guards (JwtAuthGuard
      // deveria rodar antes) — falha fechado por segurança.
      this.throwInactive();
    }

    const entry = await this.resolve(orgId);
    const now = Date.now();
    const activeAndCurrent =
      entry.status === 'active' &&
      (entry.provider === 'manual' || !entry.currentPeriodEnd || entry.currentPeriodEnd.getTime() > now);
    const allowed =
      activeAndCurrent ||
      (entry.status === 'past_due' && !!entry.graceEndsAt && entry.graceEndsAt.getTime() > now);

    if (!allowed) this.throwInactive();
    return true;
  }

  private async resolve(orgId: string): Promise<CacheEntry> {
    const cached = this.cache.get(orgId);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const sub = await this.prisma.subscription.findUnique({ where: { organizationId: orgId } });

    // sem linha de assinatura -> trata como inativa (bloqueia). Não deveria
    // ocorrer em orgs criadas após a B2 (auth.service.ts provisiona) nem em
    // orgs pré-existentes (migração 005 fez o backfill 'active').
    if (!sub) {
      const entry: CacheEntry = {
        status: 'inactive',
        provider: 'asaas',
        currentPeriodEnd: null,
        graceEndsAt: null,
        expiresAt: Date.now() + SUBSCRIPTION_CACHE_TTL_MS,
      };
      this.cache.set(orgId, entry);
      return entry;
    }

    let status = sub.status;
    const graceEndsAt = sub.gracePeriodEndsAt ?? null;

    // degradação preguiçosa: past_due com carência vencida vira canceled.
    if (status === 'past_due' && graceEndsAt && graceEndsAt.getTime() < Date.now()) {
      const degraded = await this.prisma.subscription.updateMany({
        where: { id: sub.id, status: 'past_due', gracePeriodEndsAt: { lt: new Date() } },
        data: { status: 'canceled', canceledAt: new Date() },
      });
      if (degraded.count > 0) status = 'canceled';
    }

    const entry: CacheEntry = {
      status,
      provider: sub.provider,
      currentPeriodEnd: sub.currentPeriodEnd ?? null,
      graceEndsAt,
      expiresAt: Date.now() + SUBSCRIPTION_CACHE_TTL_MS,
    };
    this.cache.set(orgId, entry);
    return entry;
  }

  private throwInactive(): never {
    throw new HttpException(
      { code: 'SUBSCRIPTION_INACTIVE', message: 'Assinatura inativa. Ative para enviar.' },
      402,
    );
  }
}

import { SetMetadata } from '@nestjs/common';

export const REQUIRE_ACTIVE_SUBSCRIPTION_KEY = 'requireActiveSubscription';

/** Marca uma rota/controller como exigindo assinatura ativa (ou past_due
 *  dentro da carência) — checado pelo SubscriptionGuard. */
export const RequireActiveSubscription = () => SetMetadata(REQUIRE_ACTIVE_SUBSCRIPTION_KEY, true);

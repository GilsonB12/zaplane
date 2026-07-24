import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BillingService } from './billing.service';
import { BuyCreditsDto } from './dto/buy-credits.dto';
import { ActivateSubscriptionDto } from './dto/activate-subscription.dto';

// Sem SubscriptionGuard aqui de propósito: ver saldo/assinatura/extrato tem
// que funcionar mesmo com a assinatura inativa/vencida (é como o cliente
// descobre que precisa reativar/comprar créditos) — e ativar assinatura /
// comprar créditos são exatamente as ações que DESTRAVAM o resto do sistema,
// então não podem depender do próprio SubscriptionGuard.
@Controller('billing')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('summary')
  summary(@CurrentUser('organizationId') orgId: string) {
    return this.billing.getSummary(orgId);
  }

  @Get('wallet')
  wallet(@CurrentUser('organizationId') orgId: string) {
    return this.billing.getWallet(orgId);
  }

  @Get('subscription')
  subscription(@CurrentUser('organizationId') orgId: string) {
    return this.billing.getSubscription(orgId);
  }

  @Post('subscription/activate')
  @Roles('owner', 'admin')
  activateSubscription(
    @CurrentUser('organizationId') orgId: string,
    @CurrentUser('email') email: string,
    @Body() dto: ActivateSubscriptionDto,
  ) {
    return this.billing.activateSubscription(orgId, email ?? null, dto?.cpfCnpj ?? null);
  }

  @Post('credits')
  @Roles('owner', 'admin')
  buyCredits(@CurrentUser('organizationId') orgId: string, @Body() dto: BuyCreditsDto) {
    return this.billing.buyCredits(orgId, dto);
  }
}

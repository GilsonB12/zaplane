import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BillingService } from './billing.service';

// Sem SubscriptionGuard aqui de propósito: ver saldo/assinatura/extrato tem
// que funcionar mesmo com a assinatura inativa/vencida (é como o cliente
// descobre que precisa reativar/comprar créditos).
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

  @Post('credits')
  buyCredits(@CurrentUser('organizationId') orgId: string, @Body() dto: { amountCents: number }) {
    return this.billing.buyCredits(orgId, dto);
  }
}

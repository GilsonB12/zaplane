import { Body, Controller, Headers, HttpCode, Inject, Post, UnauthorizedException } from '@nestjs/common';
import { BillingService } from './billing.service';
import { PAYMENT_PROVIDER, PaymentProviderAdapter } from './providers/payment-provider.interface';

// IMPORTANTE: rota pública (sem JwtAuthGuard) — mesmo padrão do webhook da
// Meta (webhooks/whatsapp.controller.ts). A autenticidade vem do header
// `asaas-access-token` (comparação em tempo constante), não de assinatura
// de corpo cru — o Asaas não assina o payload como a Meta faz.
@Controller('webhooks/billing')
export class BillingWebhookController {
  constructor(
    private readonly billing: BillingService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProviderAdapter,
  ) {}

  @Post('asaas')
  @HttpCode(200)
  async asaas(@Headers() headers: Record<string, string>, @Body() body: any) {
    if (!this.provider.verifyWebhook(headers)) {
      throw new UnauthorizedException('Token de webhook inválido.');
    }
    const event = this.provider.normalizeEvent(body);
    await this.billing.processProviderEvent(event);
    return { received: true };
  }
}

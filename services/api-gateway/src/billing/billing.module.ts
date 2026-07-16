import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { BillingWebhookController } from './billing-webhook.controller';
import { AsaasProvider } from './providers/asaas.provider';
import { PAYMENT_PROVIDER } from './providers/payment-provider.interface';

@Module({
  controllers: [BillingController, BillingWebhookController],
  providers: [
    BillingService,
    AsaasProvider,
    {
      // seleciona o adaptador ativo por trás de PaymentProviderAdapter a
      // partir de PAYMENT_PROVIDER (env). Hoje só 'asaas' está implementado;
      // adicionar outro provedor = escrever a classe + um novo branch aqui,
      // sem tocar em billing.service.ts/controller.ts.
      provide: PAYMENT_PROVIDER,
      useFactory: (config: ConfigService, asaas: AsaasProvider) => {
        const provider = config.get<string>('billing.paymentProvider') ?? 'asaas';
        if (provider === 'asaas') return asaas;
        throw new Error(`Provedor de pagamento não suportado: ${provider}`);
      },
      inject: [ConfigService, AsaasProvider],
    },
  ],
  exports: [BillingService],
})
export class BillingModule {}

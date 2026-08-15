import { Global, Module } from '@nestjs/common';
import { QuotaService } from './quota.service';

// Global como MailModule/PrismaModule: a cota diária por organização é
// consultada por qualquer módulo que enfileira mensagens (hoje só
// CampaignsService) sem precisar reimportar este módulo em cada um.
@Global()
@Module({
  providers: [QuotaService],
  exports: [QuotaService],
})
export class QuotaModule {}

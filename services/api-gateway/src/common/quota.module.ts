import { Global, Module } from '@nestjs/common';
import { PlataformaService } from './plataforma.service';
import { QuotaService } from './quota.service';

// Global como MailModule/PrismaModule: a cota diária por organização é
// consultada por qualquer módulo que enfileira mensagens (hoje só
// CampaignsService) sem precisar reimportar este módulo em cada um. Mesma
// razão para PlataformaService: TemplatesService e MessagesService também
// precisam responder "esta organização está na WABA da Zaplane?" sem import novo.
@Global()
@Module({
  providers: [QuotaService, PlataformaService],
  exports: [QuotaService, PlataformaService],
})
export class QuotaModule {}

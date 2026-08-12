import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

// Global: qualquer módulo pode injetar MailService sem reimportar.
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}

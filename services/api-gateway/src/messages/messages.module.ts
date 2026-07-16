import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';

@Module({ imports: [BillingModule], controllers: [MessagesController], providers: [MessagesService] })
export class MessagesModule {}

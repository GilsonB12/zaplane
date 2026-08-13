import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';

import { TenantThrottlerGuard } from './common/guards/tenant-throttler.guard';
import { JanelaFixaStorage } from './common/throttler/janela-fixa.storage';

import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ContactsModule } from './contacts/contacts.module';
import { ListsModule } from './lists/lists.module';
import { TemplatesModule } from './templates/templates.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { MessagesModule } from './messages/messages.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { PrivacyModule } from './privacy/privacy.module';
import { ConversationsModule } from './conversations/conversations.module';
import { ChannelsModule } from './channels/channels.module';
import { BillingModule } from './billing/billing.module';
import { MembersModule } from './members/members.module';
import { MetricsModule } from './metrics/metrics.module';
import { MailModule } from './common/mail/mail.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    // Rate limit por usuário autenticado (ver TenantThrottlerGuard), não por
    // processo: um cliente não consegue mais consumir a cota dos outros. Os
    // webhooks são isentos via @SkipThrottle nos respectivos controllers, e as
    // rotas de autenticação apertam o limite via @Throttle.
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'default',
          ttl: 60_000,
          limit: parseInt(process.env.RATE_LIMIT_PER_MIN || '300', 10),
        },
      ],
      // storage próprio: o padrão do pacote compartilha uma lista de timers
      // entre TODOS os baldes de um mesmo throttler, então um cliente
      // bloqueado congelava o contador dos outros (429 em quem não abusou).
      storage: new JanelaFixaStorage(),
    }),
    // usado pelo TenantThrottlerGuard para verificar o access token antes de
    // usá-lo como chave do balde (segredo é passado no verify, por chamada)
    JwtModule.register({}),
    PrismaModule,
    MailModule,
    AuthModule,
    ContactsModule,
    ListsModule,
    TemplatesModule,
    CampaignsModule,
    MessagesModule,
    WebhooksModule,
    PrivacyModule,
    ConversationsModule,
    ChannelsModule,
    BillingModule,
    MembersModule,
    MetricsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: TenantThrottlerGuard }],
})
export class AppModule {}

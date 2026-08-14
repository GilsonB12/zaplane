import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TemplatesModule } from '../templates/templates.module';
import { ChannelsService } from './channels.service';
import { ChannelsController } from './channels.controller';
import { AssistedService } from './assisted/assisted.service';
import { AssistedController } from './assisted/assisted.controller';
import { MetaNumerosClient } from './assisted/meta-numeros.client';

@Module({
  imports: [TemplatesModule],
  controllers: [ChannelsController, AssistedController],
  providers: [
    ChannelsService,
    AssistedService,
    {
      provide: MetaNumerosClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new MetaNumerosClient(
          config.get<string>('whatsapp.graphVersion')!,
          process.env.WHATSAPP_ACCESS_TOKEN || '',
        ),
    },
  ],
})
export class ChannelsModule {}

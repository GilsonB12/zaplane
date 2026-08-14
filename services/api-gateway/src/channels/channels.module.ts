import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TemplatesModule } from '../templates/templates.module';
import { ChannelsService } from './channels.service';
import { ChannelsController } from './channels.controller';
import { AssistedService } from './assisted/assisted.service';
import { AssistedController } from './assisted/assisted.controller';
import { MetaNumerosClient } from './assisted/meta-numeros.client';

const logger = new Logger('ChannelsModule');

@Module({
  imports: [TemplatesModule],
  controllers: [ChannelsController, AssistedController],
  providers: [
    ChannelsService,
    AssistedService,
    {
      provide: MetaNumerosClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // Via ConfigService, não process.env direto — é o padrão do resto do
        // projeto (ver whatsapp.graphVersion abaixo) e passa pelo fallback
        // '' já declarado em configuration.ts.
        const token = config.get<string>('whatsapp.accessToken') || '';
        if (!token) {
          // Falha visível, não silenciosa: sem token o client chama a Graph
          // API com "Authorization: Bearer " vazio — TODA chamada falha por
          // autenticação, e o primeiro sintoma que o cliente vê na conexão
          // assistida é "capacidade cheia" (contarNumeros volta !ok, tratado
          // como capacidade esgotada). Sem este log, o operador não tem
          // pista nenhuma de que a causa real é credencial ausente.
          logger.error(
            'WHATSAPP_ACCESS_TOKEN vazio — a conexão assistida não vai funcionar ' +
              '(toda chamada à Graph API para adicionar/verificar/registrar número falhará por autenticação).',
          );
        }
        return new MetaNumerosClient(config.get<string>('whatsapp.graphVersion')!, token);
      },
    },
  ],
})
export class ChannelsModule {}

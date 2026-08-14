import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TemplatesModule } from '../templates/templates.module';
import { ChannelsService } from './channels.service';
import { ChannelsController } from './channels.controller';
import { AssistedService } from './assisted/assisted.service';
import { AssistedController } from './assisted/assisted.controller';
import { MetaNumerosClient } from './assisted/meta-numeros.client';
import { ReconciliacaoService } from './assisted/reconciliacao.service';

const logger = new Logger('ChannelsModule');

/** Timeout de cada chamada à Graph API, pelo ConfigService (nunca
 *  `process.env` direto no meio do código). Valor ausente OU inválido cai no
 *  default do próprio client: `parseInt('abc')` é NaN, e `setTimeout(NaN)`
 *  dispara na hora — toda chamada à Meta morreria como "tempo esgotado". */
export function timeoutDaMeta(config: ConfigService): number | undefined {
  const ms = parseInt(String(config.get<string>('META_HTTP_TIMEOUT_MS') ?? ''), 10);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** Configuração da conexão assistida, conferida no boot.
 *
 *  Duas variáveis mandam no fluxo inteiro: `ZAPLANE_WABA_ID` (a WABA da
 *  plataforma) e `WHATSAPP_ACCESS_TOKEN` (o System User que fala com ela).
 *  Faltando qualquer uma, o cliente recebia "Estamos com a capacidade cheia" —
 *  mensagem enganosa que mascara falha de credencial — e o alerta de conta da
 *  Meta voltava a ser espalhado para todos os canais (webhooks.service.ts
 *  compara a WABA do alerta com `assisted.wabaId`).
 *
 *  A forma de falhar é diferente em cada caso, de propósito:
 *
 *  • `ZAPLANE_WABA_ID` ausente = feature DESLIGADA. Não derruba o boot: as
 *    variáveis ainda não existem no Railway, e recusar aqui tiraria do ar a
 *    API inteira — campanhas, webhooks de status, cobrança — de clientes
 *    pagantes, por causa de uma feature nova que nenhum deles usa ainda. O
 *    barulho fica no log e, principalmente, na porta: as rotas de conexão
 *    assistida respondem 503 com texto honesto (ver garantirDisponivel em
 *    assisted.controller.ts) em vez de mentir sobre capacidade.
 *
 *  • `ZAPLANE_WABA_ID` definido e token vazio = feature LIGADA pela metade.
 *    Esse é o estado silencioso e perigoso, e ele só existe se o operador
 *    tiver ligado a feature de propósito — então vale o mesmo remédio do
 *    asaas.provider.ts (assertWebhookTokenIsSafe): recusa de boot em produção,
 *    aviso alto fora dela. Como o gatilho é uma variável que hoje NÃO está
 *    definida, este merge não tem como derrubar o deploy atual.
 *
 *  ANTES DE LIGAR EM PRODUÇÃO: definir `ZAPLANE_WABA_ID` e
 *  `WHATSAPP_ACCESS_TOKEN` no MESMO deploy (nunca só a WABA). */
export function conferirConfigAssistida(config: ConfigService): void {
  // Via ConfigService, não process.env direto — é o padrão do resto do
  // projeto (ver whatsapp.graphVersion abaixo) e passa pelo fallback '' já
  // declarado em configuration.ts.
  const wabaId = config.get<string>('assisted.wabaId') || '';
  const token = config.get<string>('whatsapp.accessToken') || '';

  if (!wabaId) {
    logger.error(
      'ZAPLANE_WABA_ID vazio — CONEXÃO ASSISTIDA DESLIGADA: as rotas /channels/assisted ' +
        'respondem 503 e o roteamento de alertas da Meta não distingue a WABA da plataforma. ' +
        'Defina ZAPLANE_WABA_ID e WHATSAPP_ACCESS_TOKEN juntos para ligar.',
    );
    return;
  }
  if (token) return;

  const mensagem =
    '[CONFIG] ZAPLANE_WABA_ID está definido (conexão assistida LIGADA) mas WHATSAPP_ACCESS_TOKEN ' +
    'está vazio: toda chamada à Graph API para adicionar/verificar/registrar número falha por ' +
    'autenticação e o cliente recebe "capacidade cheia", que é mentira.';
  if (config.get<string>('env') === 'production') {
    throw new Error(`${mensagem} Recusando iniciar em produção.`);
  }
  logger.error(
    `${mensagem} Permitido em ambiente "${config.get<string>('env') ?? 'development'}" apenas ` +
      'para desenvolvimento — NUNCA suba assim para produção.',
  );
}

/** Fábrica do client da Meta. Função nomeada e exportada (em vez de um lambda
 *  dentro do @Module) só para o boot poder ser testado sem levantar o Nest. */
export function criarMetaNumerosClient(config: ConfigService): MetaNumerosClient {
  conferirConfigAssistida(config);
  return new MetaNumerosClient(
    config.get<string>('whatsapp.graphVersion')!,
    config.get<string>('whatsapp.accessToken') || '',
    timeoutDaMeta(config),
  );
}

@Module({
  imports: [TemplatesModule],
  controllers: [ChannelsController, AssistedController],
  providers: [
    ChannelsService,
    AssistedService,
    ReconciliacaoService,
    {
      provide: MetaNumerosClient,
      inject: [ConfigService],
      useFactory: criarMetaNumerosClient,
    },
  ],
})
export class ChannelsModule {}

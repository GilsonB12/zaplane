// Placeholder documentado no .env.example para ASAAS_WEBHOOK_TOKEN —
// deliberadamente óbvio de não ser um segredo real. asaas.provider.ts recusa
// iniciar em produção (NODE_ENV=production) se ASAAS_WEBHOOK_TOKEN estiver
// vazio OU IGUAL a este valor exato (ver Fix C1 do review B3,
// .superpowers/sdd/b3-report.md): sem essa checagem, um deploy que esquecesse
// de trocar o placeholder aceitaria qualquer webhook forjado com esse valor
// público, permitindo creditar dinheiro em qualquer organização.
export const ASAAS_WEBHOOK_TOKEN_PLACEHOLDER = 'TROQUE-ESTE-VALOR-ISTO-NAO-E-UM-SEGREDO';

export default () => ({
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  apiPrefix: process.env.API_PREFIX || 'api/v1',
  databaseUrl: process.env.DATABASE_URL,
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh',
    accessTtl: parseInt(process.env.JWT_ACCESS_TTL || '900', 10),
    refreshTtl: parseInt(process.env.JWT_REFRESH_TTL || '2592000', 10),
  },
  importerUrl: process.env.IMPORTER_URL || 'http://localhost:8000',
  // URL pública do painel — usada para montar links enviados por e-mail
  // (ex.: redefinição de senha). Sem isso o link sairia relativo e quebrado.
  appPublicUrl: process.env.APP_PUBLIC_URL || 'https://zaplane.com.br',
  mail: {
    resendApiKey: process.env.RESEND_API_KEY || '',
    from: process.env.MAIL_FROM || 'Zaplane <onboarding@resend.dev>',
  },
  whatsapp: {
    graphVersion: process.env.WHATSAPP_GRAPH_API_VERSION || 'v21.0',
    webhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    // Token de System User da Zaplane (Meta Business) — NÃO é o token por
    // canal do cliente (esse vem cifrado do banco, ver dispatcher). É o
    // token usado pela CONEXÃO ASSISTIDA para adicionar, verificar e
    // registrar o número do cliente na WABA da própria Zaplane.
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
  },
  encryptionKey: process.env.APP_ENCRYPTION_KEY || '',
  webhookPublicUrl: process.env.WEBHOOK_PUBLIC_URL || '',
  billing: {
    // Taxa Zaplane por mensagem efetivamente tarifada pela Meta, POR CATEGORIA.
    // A tarifa da Meta varia muito entre categorias (marketing ~R$0,34 vs
    // utility ~R$0,04), então uma taxa única penalizava utility em ~10x. O
    // preço abaixo é o que debitamos da carteira; o custo da Meta é cobrado
    // por ela diretamente, no cartão da WABA do cliente.
    usagePriceCents: parseInt(process.env.BILLING_USAGE_PRICE_CENTS || '43', 10),
    usagePriceByCategory: {
      // R$0,10 — cobre a tarifa Meta (~R$0,04) e mantém margem
      utility: parseInt(process.env.BILLING_USAGE_PRICE_UTILITY_CENTS || '10', 10),
      // R$0,43 — tarifa Meta de marketing é ~R$0,34
      marketing: parseInt(process.env.BILLING_USAGE_PRICE_MARKETING_CENTS || '43', 10),
      authentication: parseInt(process.env.BILLING_USAGE_PRICE_AUTH_CENTS || '43', 10),
    } as Record<string, number>,
    // Mensagens de marketing inclusas na assinatura (concedidas uma vez, no
    // provisionamento da organização) — ver subscriptions.free_marketing_remaining.
    freeMarketingQuota: parseInt(process.env.BILLING_FREE_MARKETING_QUOTA || '200', 10),
    // preço da assinatura mensal (R$149,00 = 14900 centavos)
    subscriptionPriceCents: parseInt(process.env.BILLING_SUBSCRIPTION_PRICE_CENTS || '14900', 10),
    // provedor de pagamento ativo por trás da interface PaymentProviderAdapter
    // (billing/providers/) — hoje só 'asaas' está implementado.
    paymentProvider: process.env.PAYMENT_PROVIDER || 'asaas',
    asaas: {
      baseUrl: process.env.ASAAS_BASE_URL || 'https://sandbox.asaas.com/api/v3',
      apiKey: process.env.ASAAS_API_KEY || '',
      // token que o painel Asaas envia no header `asaas-access-token` do
      // webhook — comparado em tempo constante (nunca logar este valor).
      webhookToken: process.env.ASAAS_WEBHOOK_TOKEN || '',
    },
  },
  zaplane: {
    appId: process.env.ZAPLANE_FB_APP_ID || '',
    appSecret: process.env.ZAPLANE_FB_APP_SECRET || '',
    esConfigId: process.env.ZAPLANE_ES_CONFIG_ID || '',
  },
  assisted: {
    // WABA da Zaplane que recebe os números dos clientes
    wabaId: process.env.ZAPLANE_WABA_ID || '',
    // teto de números por WABA na Meta (2 sobe para 20 com empresa verificada)
    phoneCap: parseInt(process.env.ZAPLANE_WABA_PHONE_CAP || '20', 10),
    // canais ativos permitidos por organização
    orgMaxChannels: parseInt(process.env.ORG_MAX_CHANNELS || '1', 10),
    // Limite de mensagens é do PORTFÓLIO e compartilhado por todos os números
    // (Meta, desde 07/10/2025). Sem cota por org, um cliente consome o pote de
    // todos. Ver spec §2.
    orgDailyQuota: parseInt(process.env.ORG_DAILY_MESSAGE_QUOTA || '200', 10),
    // Teto de tentativas de conexão assistida por organização em 24h
    // (qualquer status). O recurso protegido — vagas de número na WABA da
    // Zaplane (ZAPLANE_WABA_PHONE_CAP) — é GLOBAL, compartilhado por toda a
    // plataforma, mas o @Throttle do controller conta por USUÁRIO autenticado
    // (chave `u:${sub}` no TenantThrottlerGuard) — usuários diferentes da
    // MESMA organização somam baldes independentes contra o mesmo teto
    // global. Sem esta trava contada no banco, por organização, uma única
    // organização insistindo esgota as vagas de todo mundo em minutos — a
    // vaga não volta por API.
    maxConnectAttempts24h: parseInt(process.env.ORG_MAX_CONNECT_ATTEMPTS_24H || '5', 10),
    // Teto de VAGAS QUEIMADAS por organização em 24h — solicitações que já
    // chegaram a ter phone_number_id (a Meta aceitou o número, a vaga foi
    // consumida) e não terminaram conectadas. É trava diferente da de cima:
    // aquela conta TENTATIVAS, e uma tentativa que a Meta recusa não custa
    // vaga nenhuma, enquanto uma vaga consumida não volta por API.
    // Default 2 e não 5: a WABA inteira tem ZAPLANE_WABA_PHONE_CAP (~20)
    // vagas para TODA a plataforma e ORG_MAX_CHANNELS é 1, então uma
    // organização legítima precisa de exatamente uma. O 2 deixa margem para
    // um percalço real (número digitado errado que a Meta aceitou, SMS que
    // nunca chegou) e ainda assim limita o estrago diário de uma única
    // organização a 10% da capacidade da plataforma, em vez de 25%.
    maxBurnedSlots24h: parseInt(process.env.ORG_MAX_BURNED_SLOTS_24H || '2', 10),
  },
});

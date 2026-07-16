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
  whatsapp: {
    graphVersion: process.env.WHATSAPP_GRAPH_API_VERSION || 'v21.0',
    webhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
  },
  encryptionKey: process.env.APP_ENCRYPTION_KEY || '',
  webhookPublicUrl: process.env.WEBHOOK_PUBLIC_URL || '',
  billing: {
    // preço fixo por mensagem efetivamente tarifada pela Meta (R$0,43 = 43 centavos)
    usagePriceCents: parseInt(process.env.BILLING_USAGE_PRICE_CENTS || '43', 10),
    // preço da assinatura mensal (R$135,00 = 13500 centavos)
    subscriptionPriceCents: parseInt(process.env.BILLING_SUBSCRIPTION_PRICE_CENTS || '13500', 10),
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
});

# Spec — Cobrança (Billing) do Zaplane

> Data: 2026-07-16 · Decisões do usuário travadas:
> **Provedor: Asaas** (atrás de interface, trocável) · **Uso: pré-pago (carteira de
> créditos)** · **Taxa vale para campanhas E envios avulsos** · **Sem trial; 5 dias de
> carência após vencimento antes de bloquear**. Investigação de base:
> `.superpowers/sdd/` (4 relatórios de 2026-07-16).

## 1. Objetivo

Monetizar o Zaplane com dois fluxos financeiros independentes por organização:

1. **Assinatura mensal — R$ 135,00** (recorrente, via Asaas). Libera o uso das funções
   pagas (criar campanha, disparar, enviar avulso). Sem período grátis. Fatura vencida →
   **5 dias de carência** → funções de envio bloqueadas (dados sempre preservados).
2. **Créditos pré-pagos** (carteira). Cada mensagem **tarifada pela Meta** debita
   **R$ 0,43** da carteira — em campanhas **e** avulsos. Mensagem que a Meta **não** cobrou
   (`pricing.billable=false`) **não debita**. Sem saldo suficiente → envio bloqueado antes
   de disparar.

Regra-chave do pré-pago + "só cobra se a Meta cobrou": o **débito real** só ocorre quando o
webhook de status confirma `billable=true`; a **checagem de saldo** é feita **antes** do
disparo, exigindo saldo ≥ estimativa (elegíveis × R$ 0,43), que é o teto. Assim a carteira
nunca fica negativa e o cliente só paga pelo que a Meta cobrou.

## 2. Escopo

### Entra
- Medição real de mensagens tarifadas (captura `pricing` do webhook da Meta — hoje ignorado).
- Carteira de créditos + livro-razão (débito por mensagem, crédito por compra).
- Assinatura recorrente + estados (ativa / vencida / cancelada) e carência.
- Travas: `SubscriptionGuard` (assinatura ativa) + checagem de saldo (pré-envio).
- Integração Asaas (assinatura R$135, compra de créditos, webhook).
- Painel de billing live + estimativa da taxa Zaplane no wizard.

### Fica fora (agora)
- Pós-pago / fatura de uso (decisão foi pré-pago).
- Multi-moeda, impostos/NF-e automatizada (Asaas emite; integração fica p/ depois).
- Preço por canal extra; planos múltiplos (só o de R$135 por ora).
- Cobrança do custo real da Meta (a Meta cobra o cliente direto; a taxa Zaplane é à parte).

## 3. Banco — migração aditiva `004_billing.sql`

Segue convenções: `organization_id` em toda tabela, enums `TEXT + CHECK`, trigger
`set_updated_at` já existente, `BIGSERIAL` para tabelas append-only (como `audit_logs`).

**`subscriptions`** (uma linha viva por org):
- `id UUID PK`, `organization_id UUID UNIQUE NOT NULL → organizations`
- `price_cents INT NOT NULL DEFAULT 13500`
- `status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','active','past_due','canceled'))`
  (sem trial → nasce `inactive`; vira `active` no 1º pagamento confirmado)
- `provider TEXT NOT NULL DEFAULT 'asaas' CHECK (provider IN ('asaas','mercadopago','manual'))`
- `provider_customer_id TEXT`, `provider_subscription_id TEXT`
- `current_period_start TIMESTAMPTZ`, `current_period_end TIMESTAMPTZ`
- `grace_period_ends_at TIMESTAMPTZ` (setado ao vencer; guard degrada past_due→canceled após)
- `canceled_at TIMESTAMPTZ`, `created_at/updated_at` + trigger

**`wallets`** (saldo pré-pago; uma por org):
- `id UUID PK`, `organization_id UUID UNIQUE NOT NULL`
- `balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0)`
- `created_at/updated_at` + trigger

**`wallet_transactions`** (livro-razão append-only):
- `id BIGSERIAL PK`, `organization_id UUID NOT NULL`
- `kind TEXT NOT NULL CHECK (kind IN ('credit','debit'))`
- `amount_cents INTEGER NOT NULL` (sempre positivo; `kind` diz o sinal)
- `balance_after_cents INTEGER NOT NULL`
- `reason TEXT NOT NULL CHECK (reason IN ('topup','message','refund','adjustment'))`
- `outbound_message_id UUID → outbound_messages(id) ON DELETE SET NULL` (nullable)
- `wa_message_id TEXT` (idempotência do débito por mensagem)
- `payment_id UUID → payments(id)` (nullable; crédito veio de qual compra)
- `metadata JSONB NOT NULL DEFAULT '{}'`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- `UNIQUE (organization_id, wa_message_id) WHERE kind='debit'` — trava dupla cobrança

**`payments`** (cobranças no provedor — assinatura e compra de créditos):
- `id UUID PK`, `organization_id UUID NOT NULL`, `subscription_id UUID → subscriptions` (nullable)
- `kind TEXT NOT NULL CHECK (kind IN ('subscription','credit_topup'))`
- `amount_cents INTEGER NOT NULL`, `credited_cents INTEGER` (topup: quanto entra na carteira)
- `status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','overdue','canceled','refunded'))`
- `provider TEXT NOT NULL`, `provider_payment_id TEXT`, `provider_url TEXT` (Pix copia-e-cola/boleto/checkout)
- `method TEXT CHECK (method IN ('pix','boleto','credit_card'))`
- `due_at`, `paid_at TIMESTAMPTZ`, `created_at/updated_at` + trigger
- `UNIQUE (provider, provider_payment_id)`

**`subscription_events`** (auditoria + idempotência de webhook):
- `id BIGSERIAL PK`, `organization_id UUID NOT NULL`, `subscription_id UUID → subscriptions`
- `event TEXT NOT NULL`, `provider TEXT`, `provider_event_id TEXT`, `metadata JSONB DEFAULT '{}'`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- `UNIQUE (provider, provider_event_id)`

**Colunas novas em `outbound_messages`** (captura do custo real da Meta):
- `billable BOOLEAN`, `pricing_category TEXT`, `pricing_model TEXT`,
  `billing_recorded_at TIMESTAMPTZ` (guard de idempotência do débito)

Decisão: **não** reaproveitar `organizations.plan/status` (são operacionais/abuso); billing
tem estado próprio. Prisma: rodar `db pull` + `generate` após aplicar.

## 4. B1 — Medição (provider-agnóstica)

`webhooks.service.ts` `handleStatus`:
- Ler `status.pricing` (`{ billable, category, pricing_model }`) e gravar em
  `outbound_messages.billable/pricing_category/pricing_model`.
- Threading: `handleStatus` precisa do `organizationId` — hoje só recebe `channelId`.
  O `process()` já resolve `channel` (com `organizationId`); passar adiante.
- Quando `billable=true` **e** `billing_recorded_at IS NULL`: **debitar R$ 0,43** —
  numa transação: `INSERT wallet_transactions(kind='debit', reason='message', amount_cents=43,
  wa_message_id, ...)` com `ON CONFLICT (organization_id, wa_message_id) DO NOTHING` +
  `UPDATE wallets SET balance_cents = balance_cents - 43` (só se a inserção ocorreu) +
  `UPDATE outbound_messages SET billing_recorded_at = now()`.
- `billable=false`: marca `billable=false`, **não debita** (grava `billing_recorded_at` p/ não reprocessar).
- Idempotência: a Meta reenvia status; o UNIQUE por `wa_message_id` e o `billing_recorded_at`
  impedem débito duplo (corrige também o risco pré-existente de contador de campanha dobrado).
- `BILLING_USAGE_PRICE_CENTS=43` no env (configurável).

## 5. B2 — Carteira, assinatura e travas (provider-agnóstica)

- Módulo `billing/` (service + controller): `GET /billing/summary` (assinatura + saldo +
  últimos pagamentos), `GET /billing/wallet` (saldo + extrato), `POST /billing/credits`
  (inicia compra de créditos — stub até B3), `GET /billing/subscription`.
- **`SubscriptionGuard`** (`common/guards/subscription.guard.ts`) + decorator
  `@RequireActiveSubscription()`: lê `subscriptions.status`; permite se `active`, ou
  `past_due` com `grace_period_ends_at > now()`; senão HTTP **402**
  (`{ code: 'SUBSCRIPTION_INACTIVE' }`). Cache em memória TTL ~60s (padrão do `secretCache`).
  Degradação preguiçosa (sem cron): ao ver `past_due` vencido, `UPDATE ... SET
  status='canceled' WHERE status='past_due' AND grace_period_ends_at < now()`.
- **Checagem de saldo (pré-envio)** — service `BillingService.assertBalanceFor(orgId, cents)`:
  - Campanha (`campaigns.service.create`): estima `eligible.length * 43`; exige
    `wallet.balance_cents >= estimativa`; senão HTTP 402 `{ code: 'INSUFFICIENT_CREDITS',
    needed, balance }`.
  - Avulso (`messages.service.sendSingle`/`sendText`): exige `>= 43`.
- **Onde aplicar** (`@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)` +
  `@RequireActiveSubscription()` + checagem de saldo no service):
  - `POST /campaigns` (create) · `POST /messages/send` · `POST /messages/text` → **travados**.
  - `GET /campaigns`, `/campaigns/:id`, `POST /campaigns/:id/cancel`, contatos, listas,
    templates, conversas, canais → **livres** (ver/cancelar/gerir dados não gasta).
- O Dispatcher (Go) não muda: o gateway é o único ponto de INSERT em `outbound_messages`,
  então a trava na entrada basta.
- `campaigns`: adicionar `platform_fee_estimate_cents BIGINT` (elegíveis × 43) ao lado do
  `cost_estimate_cents` (custo Meta) — dois números distintos, origens distintas.

## 6. B3 — Asaas (precisa da API key sandbox do usuário)

- Interface `PaymentProviderAdapter` (`billing/providers/payment-provider.interface.ts`):
  `createCustomer(org)`, `createSubscription(customerId, priceCents)`,
  `createCharge(customerId, amountCents, kind)` (Pix/boleto/cartão p/ créditos),
  `parseWebhook(rawBody, headers) → NormalizedEvent`.
- `AsaasProvider` implementa via REST (`https://sandbox.asaas.com/api/v3`), auth header
  `access_token`. Env: `PAYMENT_PROVIDER=asaas`, `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`,
  `BILLING_SUBSCRIPTION_PRICE_CENTS=13500`, `BILLING_USAGE_PRICE_CENTS=43`.
- Webhook `POST /webhooks/billing/asaas`: valida `asaas-access-token` (timingSafeEqual);
  idempotência por `subscription_events.provider_event_id`; numa transação:
  - pagamento de assinatura confirmado → `subscriptions.status='active'`, avança período,
    limpa `grace_period_ends_at`; `payments.status='paid'`.
  - assinatura vencida → `status='past_due'`, `grace_period_ends_at = now() + 5 dias`.
  - compra de créditos paga (`payments.kind='credit_topup'`) → `wallet += credited_cents`
    (via `wallet_transactions(kind='credit', reason='topup')`).
  - assinatura cancelada no provedor → `status='canceled'`.
- Reaproveita a captura de corpo cru já usada no webhook da Meta.

## 7. B4 — Painel (frontend)

- `Configuracoes.jsx` aba "Plano & billing" (hoje 100% mock): assinatura (status, próximo
  vencimento, link de pagamento se `inactive/past_due`), **saldo de créditos** + botão
  "Comprar créditos" (escolhe valor → Pix/boleto Asaas), extrato/pagamentos. Remove o banner
  de dados de exemplo dessa aba.
- Wizard de campanha (`Campanhas.jsx`): mostrar **estimativa da taxa Zaplane**
  (elegíveis × R$ 0,43) separada do custo Meta; se saldo insuficiente, avisar antes de disparar.
- `api/endpoints.js`: `getBillingSummary`, `getWallet`, `buyCredits`, `getSubscription`.
- Tratar 402 no cliente: `INSUFFICIENT_CREDITS` → CTA "comprar créditos";
  `SUBSCRIPTION_INACTIVE` → CTA "ativar assinatura".

## 8. Verificação (sem framework; builds + testes reais)
- Migração aplica; `prisma db pull`+`generate`; builds gateway/web.
- B1: simular webhook de status com `pricing.billable=true` → confere débito de 43 e
  idempotência (reenvio não debita de novo); `billable=false` → sem débito.
- B2: sem assinatura ativa → 402 em criar campanha/enviar; saldo < estimativa → 402
  `INSUFFICIENT_CREDITS`; com assinatura + saldo → passa.
- B3 (com sandbox): criar assinatura, simular webhook de pagamento → ativa; comprar
  créditos → webhook credita carteira.

## 9. Riscos e decisões
- **Pré-pago pode truncar campanha** se o saldo acabar no meio (débito é por webhook, após
  envio). Mitigação: pré-checagem exige saldo ≥ estimativa (teto). Campanhas concorrentes
  podem sobre-comprometer; aceitável agora (bloqueio no próximo disparo), reserva de saldo
  fica p/ depois se necessário.
- **Segredos**: `ASAAS_API_KEY` só no `.env`; nunca em log/resposta.
- **LGPD**: transições de assinatura e ajustes manuais de carteira → registrar em
  `subscription_events`/`audit_logs`.
- **Idempotência** é obrigatória em todo webhook (Meta e Asaas) — UNIQUE + guard.

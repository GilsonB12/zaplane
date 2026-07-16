-- =====================================================================
-- Zaplane — Cobranca (billing): assinatura mensal + carteira de creditos
-- Migracao ADITIVA sobre 001_init.sql (+ 002/003). Nao editar migracoes ja
-- aplicadas. Ver spec: docs/superpowers/specs/2026-07-16-cobranca-billing.md
--
-- Contexto:
--   - Assinatura mensal (R$135, via Asaas) libera o envio; sem trial. Fatura
--     vencida vira 'past_due' com 5 dias de carencia (grace_period_ends_at)
--     antes de degradar para 'canceled' (feito de forma preguicosa pelo guard,
--     sem cron).
--   - Creditos pre-pagos: cada mensagem que a Meta efetivamente tarifa
--     (webhook status.pricing.billable=true) debita R$0,43 da carteira via
--     wallet_transactions (livro-razao append-only). Mensagem nao tarifada
--     nao debita. Idempotencia por UNIQUE(organization_id, wa_message_id)
--     WHERE kind='debit' + outbound_messages.billing_recorded_at.
--   - subscriptions/wallets: uma linha viva por organizacao (UNIQUE
--     organization_id). wallet_transactions/subscription_events: append-only
--     (BIGSERIAL), como audit_logs em 001_init.sql.
--   - Decisao: NAO reaproveitar organizations.plan/status (sao
--     operacionais/abuso); billing tem estado proprio.
--
-- Ordem de criacao (difere da ordem de leitura da spec) por causa das FKs:
-- subscriptions -> wallets -> payments (refs subscriptions) ->
-- wallet_transactions (refs payments, outbound_messages) ->
-- subscription_events (refs subscriptions).
--
-- Aplicar (Windows — acentos corrompem em stdin, sempre rodar via arquivo):
--   set PGCLIENTENCODING=UTF8
--   "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost ^
--     -d zaplane -v ON_ERROR_STOP=1 -f db/migrations/004_billing.sql
-- Depois: atualizar prisma/schema.prisma (novos models + colunas em
-- outbound_messages) e rodar `npx prisma generate`.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Assinatura mensal (uma linha viva por organizacao)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id          UUID UNIQUE NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    price_cents              INTEGER NOT NULL DEFAULT 13500,
    -- sem trial -> nasce 'inactive'; vira 'active' no 1o pagamento confirmado
    status                   TEXT NOT NULL DEFAULT 'inactive'
                             CHECK (status IN ('inactive','active','past_due','canceled')),
    provider                 TEXT NOT NULL DEFAULT 'asaas'
                             CHECK (provider IN ('asaas','mercadopago','manual')),
    provider_customer_id     TEXT,
    provider_subscription_id TEXT,
    current_period_start     TIMESTAMPTZ,
    current_period_end       TIMESTAMPTZ,
    -- setado quando a fatura vence; o guard degrada past_due -> canceled apos esse instante
    grace_period_ends_at     TIMESTAMPTZ,
    canceled_at               TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER trg_subscriptions_updated BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 2. Carteira de creditos pre-pagos (saldo corrente; uma por organizacao)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID UNIQUE NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    balance_cents   INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER trg_wallets_updated BEFORE UPDATE ON wallets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 3. Pagamentos no provedor (cobrancas de assinatura e compra de creditos)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    subscription_id     UUID REFERENCES subscriptions(id),
    kind                TEXT NOT NULL CHECK (kind IN ('subscription','credit_topup')),
    amount_cents        INTEGER NOT NULL,
    -- topup: quanto entra na carteira (pode diferir de amount_cents em promocoes futuras)
    credited_cents      INTEGER,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','paid','overdue','canceled','refunded')),
    provider            TEXT NOT NULL,
    provider_payment_id TEXT,
    provider_url        TEXT,                      -- Pix copia-e-cola/boleto/checkout
    method              TEXT CHECK (method IN ('pix','boleto','credit_card')),
    due_at              TIMESTAMPTZ,
    paid_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_payment_id)
);
CREATE INDEX IF NOT EXISTS idx_payments_org ON payments(organization_id, created_at DESC);
CREATE OR REPLACE TRIGGER trg_payments_updated BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- 4. Livro-razao da carteira (append-only; debito por mensagem, credito por compra)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id                   BIGSERIAL PRIMARY KEY,
    organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind                 TEXT NOT NULL CHECK (kind IN ('credit','debit')),
    amount_cents         INTEGER NOT NULL,          -- sempre positivo; `kind` da o sinal
    balance_after_cents  INTEGER NOT NULL,
    reason               TEXT NOT NULL CHECK (reason IN ('topup','message','refund','adjustment')),
    outbound_message_id  UUID REFERENCES outbound_messages(id) ON DELETE SET NULL,
    wa_message_id        TEXT,                      -- idempotencia do debito por mensagem
    payment_id           UUID REFERENCES payments(id),
    metadata             JSONB NOT NULL DEFAULT '{}',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- trava dupla cobranca do mesmo wa_message_id (reenvio de webhook da Meta)
CREATE UNIQUE INDEX IF NOT EXISTS ux_wallet_tx_org_wamsg_debit
    ON wallet_transactions(organization_id, wa_message_id) WHERE kind = 'debit';
CREATE INDEX IF NOT EXISTS idx_wallet_tx_org ON wallet_transactions(organization_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 5. Eventos de assinatura (auditoria + idempotencia de webhook do provedor)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_events (
    id                BIGSERIAL PRIMARY KEY,
    organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    subscription_id   UUID REFERENCES subscriptions(id),
    event             TEXT NOT NULL,
    provider          TEXT,
    provider_event_id TEXT,
    metadata          JSONB DEFAULT '{}',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_subscription_events_org ON subscription_events(organization_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 6. outbound_messages: captura do custo real (pricing) reportado pela Meta
-- ---------------------------------------------------------------------
ALTER TABLE outbound_messages
    ADD COLUMN IF NOT EXISTS billable             BOOLEAN,
    ADD COLUMN IF NOT EXISTS pricing_category      TEXT,
    ADD COLUMN IF NOT EXISTS pricing_model         TEXT,
    -- guard de idempotencia do debito (setado tanto p/ billable=true quanto false)
    ADD COLUMN IF NOT EXISTS billing_recorded_at   TIMESTAMPTZ;

-- ---------------------------------------------------------------------
-- 7. Backfill: garante uma carteira (saldo 0) para toda organizacao ja
--    existente. Sem isso, o debito de billing cai sempre no ramo "sem
--    carteira provisionada" e nao desconta nada (ver review B1, Fix 2).
--    Idempotente via ON CONFLICT — reaplicar esta migracao e' seguro.
-- ---------------------------------------------------------------------
INSERT INTO wallets (organization_id)
    SELECT id FROM organizations
    ON CONFLICT (organization_id) DO NOTHING;

-- =====================================================================
-- Fim da migracao 004. Proximo passo: `npx prisma generate` apos ajustar
-- prisma/schema.prisma (novos models + colunas de OutboundMessage).
-- =====================================================================

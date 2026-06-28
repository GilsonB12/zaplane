-- =====================================================================
-- Zaplane — Schema inicial (PostgreSQL 15+)
-- Fonte de verdade do modelo de dados. Aplicar com:
--   createdb zaplane && psql -d zaplane -f db/migrations/001_init.sql
-- O Prisma (api-gateway) deve refletir este schema (npx prisma db pull).
-- Convenções: toda tabela de domínio tem organization_id (multi-tenant).
-- Enums representados como TEXT + CHECK para casar facilmente com Prisma/Go/Py.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- updated_at automático -------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- 1. Tenancy: organizações e usuários
-- =====================================================================
CREATE TABLE organizations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    slug          TEXT NOT NULL UNIQUE,
    plan          TEXT NOT NULL DEFAULT 'free'
                  CHECK (plan IN ('free','starter','pro','enterprise')),
    -- limite diário de mensagens (controle de abuso/custo por tenant)
    daily_message_limit INTEGER NOT NULL DEFAULT 1000,
    status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','canceled')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_org_updated BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email           TEXT NOT NULL,
    password_hash   TEXT NOT NULL,                -- Argon2id
    name            TEXT,
    role            TEXT NOT NULL DEFAULT 'operator'
                    CHECK (role IN ('owner','admin','operator','viewer')),
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','disabled')),
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, email)
);
CREATE INDEX idx_users_org ON users(organization_id);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL,                -- hash do refresh token (rotativo)
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);

-- =====================================================================
-- 2. Canais WhatsApp (config da Meta por organização — multi-número)
-- =====================================================================
CREATE TABLE whatsapp_channels (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    label             TEXT NOT NULL,              -- ex.: "Petshop - Atendimento"
    phone_number_id   TEXT NOT NULL,              -- ID do número na Meta
    waba_id           TEXT NOT NULL,              -- WhatsApp Business Account ID
    display_number    TEXT,                       -- número humano (E.164)
    -- token de acesso da Meta — TODO: cifrar em repouso (KMS/secret manager)
    access_token_enc  TEXT NOT NULL,
    quality_rating    TEXT,                       -- GREEN/YELLOW/RED (sync da Meta)
    throughput_limit  INTEGER NOT NULL DEFAULT 80,-- msgs/seg permitido (tier do número)
    status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','disabled')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, phone_number_id)
);
CREATE INDEX idx_channels_org ON whatsapp_channels(organization_id);
CREATE TRIGGER trg_channels_updated BEFORE UPDATE ON whatsapp_channels
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- 3. Contatos (PII) + consentimento (LGPD)
-- =====================================================================
CREATE TABLE contacts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- phone_e164: número usável. TODO produção: cifrar em repouso (AES-256-GCM).
    phone_e164      TEXT NOT NULL,
    -- phone_hash: HMAC-SHA256 do E.164 — permite dedup/busca sem expor o número.
    phone_hash      TEXT NOT NULL,
    name            TEXT,
    country_code    TEXT DEFAULT 'BR',
    ddd             TEXT,                          -- código de área (ex.: 11) p/ segmentar
    region          TEXT,                          -- UF/região inferida do DDD
    tags            TEXT[] NOT NULL DEFAULT '{}',
    attributes      JSONB NOT NULL DEFAULT '{}',   -- campos extras do upload do cliente
    -- consentimento / base legal (LGPD)
    consent_status  TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (consent_status IN ('granted','pending','denied','opted_out','unknown')),
    consent_source  TEXT,                          -- ex.: cadastro_loja, formulario_site
    consent_at      TIMESTAMPTZ,
    opted_out       BOOLEAN NOT NULL DEFAULT FALSE,
    opted_out_at    TIMESTAMPTZ,
    -- soft delete (direito de eliminação trata via privacy)
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, phone_hash)
);
CREATE INDEX idx_contacts_org           ON contacts(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_contacts_org_ddd       ON contacts(organization_id, ddd) WHERE deleted_at IS NULL;
CREATE INDEX idx_contacts_org_consent   ON contacts(organization_id, consent_status) WHERE deleted_at IS NULL;
CREATE INDEX idx_contacts_tags          ON contacts USING GIN (tags);
CREATE TRIGGER trg_contacts_updated BEFORE UPDATE ON contacts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- trilha de auditoria do consentimento (accountability)
CREATE TABLE consent_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    event           TEXT NOT NULL
                    CHECK (event IN ('granted','denied','opted_out','opted_in','imported')),
    source          TEXT,                          -- origem da mudança
    actor_user_id   UUID REFERENCES users(id),
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_consent_contact ON consent_events(contact_id);

-- =====================================================================
-- 4. Listas e segmentos
-- =====================================================================
CREATE TABLE lists (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL DEFAULT 'static'
                    CHECK (type IN ('static','dynamic')),
    -- regra para segmentos dinâmicos, ex.: {"ddd":["11","21"],"tags":["vip"]}
    rule            JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lists_org ON lists(organization_id);
CREATE TRIGGER trg_lists_updated BEFORE UPDATE ON lists
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE list_contacts (
    list_id     UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (list_id, contact_id)
);

-- =====================================================================
-- 5. Templates de mensagem (espelham os templates aprovados na Meta)
-- =====================================================================
CREATE TABLE templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,                 -- nome do template na Meta
    language        TEXT NOT NULL DEFAULT 'pt_BR',
    category        TEXT NOT NULL
                    CHECK (category IN ('MARKETING','UTILITY','AUTHENTICATION')),
    status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('APPROVED','PENDING','REJECTED','DISABLED')),
    body            TEXT,                          -- corpo com {{1}}, {{2}}...
    variables_count INTEGER NOT NULL DEFAULT 0,
    meta_template_id TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name, language)
);
CREATE INDEX idx_templates_org ON templates(organization_id);
CREATE TRIGGER trg_templates_updated BEFORE UPDATE ON templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- 6. Campanhas
-- =====================================================================
CREATE TABLE campaigns (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    channel_id      UUID NOT NULL REFERENCES whatsapp_channels(id),
    template_id     UUID REFERENCES templates(id),
    name            TEXT NOT NULL,
    -- público: referência à lista OU regra inline de segmento
    list_id         UUID REFERENCES lists(id),
    audience_rule   JSONB,
    -- parâmetros default das variáveis do template e mapeamento por contato
    template_params JSONB NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','scheduled','queuing','sending','completed','failed','canceled')),
    scheduled_at    TIMESTAMPTZ,
    -- contadores (atualizados conforme o Dispatcher progride)
    total_recipients INTEGER NOT NULL DEFAULT 0,
    suppressed_count INTEGER NOT NULL DEFAULT 0,   -- opt-out / sem consentimento / inválidos
    sent_count       INTEGER NOT NULL DEFAULT 0,
    delivered_count  INTEGER NOT NULL DEFAULT 0,
    read_count       INTEGER NOT NULL DEFAULT 0,
    failed_count     INTEGER NOT NULL DEFAULT 0,
    cost_estimate_cents BIGINT,                    -- estimativa pré-envio (centavos)
    created_by       UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_campaigns_org ON campaigns(organization_id);
CREATE TRIGGER trg_campaigns_updated BEFORE UPDATE ON campaigns
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- 7. Fila de saída (outbound_messages) — consumida pelo Dispatcher (Go)
--    Padrão de fila: SELECT ... FOR UPDATE SKIP LOCKED
-- =====================================================================
CREATE TABLE outbound_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    campaign_id     UUID REFERENCES campaigns(id) ON DELETE CASCADE,
    channel_id      UUID NOT NULL REFERENCES whatsapp_channels(id),
    contact_id      UUID REFERENCES contacts(id) ON DELETE SET NULL,
    to_phone_e164   TEXT NOT NULL,                 -- destino (snapshot no enfileiramento)
    -- payload pronto para a Meta Cloud API (objeto "messages")
    payload         JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','sending','sent','delivered','read','failed','canceled')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 5,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at       TIMESTAMPTZ,
    locked_by       TEXT,                          -- id do worker que pegou a mensagem
    wa_message_id   TEXT,                          -- id retornado pela Meta
    error_code      TEXT,
    error_detail    TEXT,
    sent_at         TIMESTAMPTZ,
    delivered_at    TIMESTAMPTZ,
    read_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- índice parcial para o poll da fila (mantém o scan barato)
CREATE INDEX idx_outbox_poll ON outbound_messages (next_attempt_at)
    WHERE status = 'queued';
CREATE INDEX idx_outbox_campaign ON outbound_messages (campaign_id);
CREATE INDEX idx_outbox_wamid    ON outbound_messages (wa_message_id);
CREATE TRIGGER trg_outbox_updated BEFORE UPDATE ON outbound_messages
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- 8. Mensagens recebidas (inbound) — webhook da Meta
-- =====================================================================
CREATE TABLE inbound_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    channel_id      UUID REFERENCES whatsapp_channels(id),
    contact_id      UUID REFERENCES contacts(id) ON DELETE SET NULL,
    from_phone_e164 TEXT NOT NULL,
    wa_message_id   TEXT,
    type            TEXT,                          -- text/image/button/...
    body            TEXT,
    raw             JSONB,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_inbound_org ON inbound_messages(organization_id);

-- =====================================================================
-- 9. Auditoria e solicitações LGPD
-- =====================================================================
CREATE TABLE audit_logs (
    id              BIGSERIAL PRIMARY KEY,
    organization_id UUID,
    actor_user_id   UUID,
    action          TEXT NOT NULL,                 -- ex.: campaign.create, lgpd.delete
    resource_type   TEXT,
    resource_id     TEXT,
    ip_address      INET,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_org ON audit_logs(organization_id, created_at DESC);

CREATE TABLE data_subject_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    type            TEXT NOT NULL CHECK (type IN ('export','delete')),
    subject_phone   TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','completed','rejected')),
    result_uri      TEXT,                          -- onde o export ficou disponível
    requested_by    UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
);
CREATE INDEX idx_dsr_org ON data_subject_requests(organization_id);

-- =====================================================================
-- Fim do schema inicial.
-- Próximo passo recomendado em produção: habilitar RLS por organization_id.
-- =====================================================================

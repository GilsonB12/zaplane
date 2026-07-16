-- =====================================================================
-- Zaplane — Cobranca (billing) B2: trava de acesso (assinatura + saldo)
-- Migracao ADITIVA sobre 001..004. Nao editar migracoes ja aplicadas.
-- Ver spec: docs/superpowers/specs/2026-07-16-cobranca-billing.md (§5, B2)
--
-- Contexto:
--   - campaigns.platform_fee_estimate_cents guarda a ESTIMATIVA da taxa
--     Zaplane (elegiveis x BILLING_USAGE_PRICE_CENTS), ao lado de
--     cost_estimate_cents que e o custo estimado da Meta — duas origens,
--     dois numeros distintos.
--   - Assinatura: orgs JA EXISTENTES (antes da B2) sao "grandfathered" como
--     'active' para nao quebrar dev/testes em andamento. Orgs NOVAS (criadas
--     a partir da B2, em auth.service.ts) nascem 'inactive' — precisam
--     assinar. O backfill abaixo e idempotente (ON CONFLICT DO NOTHING):
--     reaplicar esta migracao nao reativa assinaturas ja canceladas/vencidas.
--
-- Aplicar (Windows — acentos corrompem em stdin, sempre rodar via arquivo):
--   set PGCLIENTENCODING=UTF8
--   "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost ^
--     -d zaplane -v ON_ERROR_STOP=1 -f db/migrations/005_billing_gating.sql
-- Depois: atualizar prisma/schema.prisma (campo novo em Campaign) e rodar
-- `npx prisma generate` (EPERM no Windows com o gateway em watch e esperado
-- e inofensivo — o client so e recarregado no proximo restart).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. campaigns: estimativa da taxa Zaplane (separada do custo Meta)
-- ---------------------------------------------------------------------
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS platform_fee_estimate_cents BIGINT;

-- ---------------------------------------------------------------------
-- 2. Backfill: organizacoes existentes antes da B2 sao grandfathered como
--    assinatura 'active' (provider 'manual') — preserva dev/testes em
--    andamento sem exigir integracao Asaas retroativa. Idempotente via
--    ON CONFLICT (organization_id) DO NOTHING: reaplicar e' seguro e nao
--    reativa assinaturas que ja tenham migrado para outro estado.
-- ---------------------------------------------------------------------
INSERT INTO subscriptions (id, organization_id, status, provider, current_period_start, current_period_end)
    SELECT gen_random_uuid(), id, 'active', 'manual', now(), now() + interval '30 days'
    FROM organizations
    ON CONFLICT (organization_id) DO NOTHING;

-- =====================================================================
-- Fim da migracao 005. Proximo passo: prisma/schema.prisma (Campaign.
-- platformFeeEstimateCents) + `npx prisma generate`.
-- =====================================================================

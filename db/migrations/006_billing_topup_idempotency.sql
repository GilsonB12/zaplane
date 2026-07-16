-- =====================================================================
-- Zaplane — Cobranca (billing) B3 review: idempotencia de credito de topup
-- Migracao ADITIVA sobre 001..005. Nao editar migracoes ja aplicadas.
-- Ver: .superpowers/sdd/b3-report.md (Fix I2 do review B3)
--
-- Contexto:
--   - Sem este indice, dois eventos DISTINTOS do Asaas para a MESMA cobranca
--     de credito (ex.: PAYMENT_CONFIRMED e PAYMENT_RECEIVED entregues quase
--     juntos, cada um com provider_event_id proprio — subscription_events
--     so dedupe por provider_event_id, nao por payment_id) poderiam, numa
--     corrida, ambos passar pela trava de linha (SELECT ... FOR UPDATE em
--     payments, billing.service.ts) e inserir duas linhas de credito em
--     wallet_transactions para o mesmo payment_id — dobrando o saldo
--     creditado.
--   - Este indice parcial e a SEGUNDA camada de defesa (a primeira e o
--     SELECT ... FOR UPDATE na linha de payments): garante, no proprio
--     banco, que wallet_transactions nunca tenha mais de uma linha
--     reason='topup' por payment_id, mesmo que a trava de aplicacao falhe
--     por algum motivo. O credito passa a usar
--     INSERT ... ON CONFLICT (payment_id) WHERE reason='topup' DO NOTHING,
--     e so incrementa wallets.balance_cents (de forma RELATIVA) se a linha
--     do livro-razao tiver sido de fato inserida.
--
-- Aplicar (Windows — acentos corrompem em stdin, sempre rodar via arquivo):
--   set PGCLIENTENCODING=UTF8
--   "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost ^
--     -d zaplane -v ON_ERROR_STOP=1 -f db/migrations/006_billing_topup_idempotency.sql
-- =====================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_tx_topup
    ON wallet_transactions(payment_id) WHERE reason = 'topup';

-- =====================================================================
-- Fim da migracao 006.
-- =====================================================================

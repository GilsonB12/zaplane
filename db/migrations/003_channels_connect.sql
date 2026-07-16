-- =====================================================================
-- Zaplane — Fatia 3: "Conectar número" (Embedded Signup + manual)
-- Migração ADITIVA sobre 001_init.sql. Não editar migrações já aplicadas.
--
-- Contexto: hoje um canal (whatsapp_channels) só é criado manualmente via
-- script/seed, sem registrar como foi conectado nem guardar o App Secret
-- próprio do app do cliente (necessário no fluxo manual/concierge para
-- registrar o webhook em nome dele). Esta migração:
--   - app_id / app_secret_enc: credenciais do app Meta do CLIENTE, usadas
--     apenas no caminho "Conectar manualmente" (no Embedded Signup o app
--     é o Zaplane, e a assinatura do webhook usa o secret global do Zaplane).
--   - connected_via: de onde veio a conexão do canal (manual / embedded
--     signup / bootstrap — o valor 'bootstrap' fica disponível para uso
--     futuro; canais já existentes recebem o DEFAULT 'manual', que é
--     aceitável pois foram todos criados via script/seed manual).
-- Aplicar com:
--   psql -U postgres -h localhost -d zaplane -v ON_ERROR_STOP=1 \
--        -f db/migrations/003_channels_connect.sql
-- Depois: atualizar prisma/schema.prisma (3 campos) e rodar `npx prisma generate`.
-- =====================================================================

ALTER TABLE whatsapp_channels
  ADD COLUMN IF NOT EXISTS app_id        TEXT,
  ADD COLUMN IF NOT EXISTS app_secret_enc TEXT,
  ADD COLUMN IF NOT EXISTS connected_via TEXT NOT NULL DEFAULT 'manual'
    CHECK (connected_via IN ('manual','embedded_signup','bootstrap'));

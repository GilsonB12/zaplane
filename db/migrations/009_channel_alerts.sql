-- 009_channel_alerts.sql
--
-- Alertas de conta enviados pela Meta (webhook `account_alerts`).
--
-- Motivação: o Zaplane é Tech Provider, e a Meta NÃO expõe a situação de
-- pagamento da WABA do cliente para esse nível (os campos de faturamento
-- exigem ser Business Solution Provider). O único canal de aviso disponível é
-- o webhook `account_alerts` — no qual o app já estava inscrito, mas cujos
-- eventos eram descartados sem tratamento.
--
-- Guardamos aqui o alerta ATIVO mais recente por canal para que o painel possa
-- avisar o cliente ("cadastre a forma de pagamento na Meta", "qualidade
-- baixa", etc.) em vez de ele descobrir quando os envios pararem.
-- Quando a Meta manda o mesmo alerta com status RESOLVED, os campos são limpos.
--
-- Aditivo e idempotente.

ALTER TABLE whatsapp_channels
  ADD COLUMN IF NOT EXISTS alert_severity TEXT,
  ADD COLUMN IF NOT EXISTS alert_type     TEXT,
  ADD COLUMN IF NOT EXISTS alert_message  TEXT,
  ADD COLUMN IF NOT EXISTS alert_at       TIMESTAMPTZ;

COMMENT ON COLUMN whatsapp_channels.alert_severity IS
  'Severidade do último alerta ATIVO da Meta (CRITICAL/WARNING). NULL = sem alerta pendente.';
COMMENT ON COLUMN whatsapp_channels.alert_message IS
  'Descrição do alerta enviada pela Meta, exibida ao cliente no painel.';

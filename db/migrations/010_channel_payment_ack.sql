-- 010_channel_payment_ack.sql
--
-- Confirmação, feita pelo próprio cliente, de que a forma de pagamento já foi
-- cadastrada na Meta para este canal.
--
-- Por que guardar isso em vez de verificar: a situação de faturamento da WABA
-- do cliente só é legível por Business Solution Provider — um Tech Provider
-- (nosso caso) recebe erro de permissão ao consultar. Então o painel não pode
-- afirmar que está pago; ele lembra do passo e registra quando o cliente diz
-- que resolveu, sumindo com o aviso.
--
-- O webhook `account_alerts` (migração 009) continua sendo a fonte real: se a
-- Meta reclamar de pagamento, o alerta reaparece mesmo com esta confirmação.
--
-- Aditivo e idempotente.

ALTER TABLE whatsapp_channels
  ADD COLUMN IF NOT EXISTS payment_ack_at TIMESTAMPTZ;

COMMENT ON COLUMN whatsapp_channels.payment_ack_at IS
  'Quando o cliente confirmou ter cadastrado a forma de pagamento na Meta. Não é verificação — é reconhecimento do passo (a Meta não expõe isso a Tech Provider).';

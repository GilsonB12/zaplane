-- 008_pricing_and_cleanup.sql
--
-- (A) Novo modelo de preço: cota de mensagens de marketing inclusas na
--     assinatura do primeiro mês. O preço por mensagem passa a variar por
--     CATEGORIA da Meta (utility é ~8x mais barato que marketing na tarifa
--     oficial, então cobrar o mesmo valor pelos dois é injusto e indefensável).
--     A cota é decrementada em webhooks.service.ts::recordPricing quando uma
--     mensagem de marketing é efetivamente tarifada pela Meta.
--
-- (B) Remove o canal placeholder 'LOCAL_DEV' criado no cadastro (auth.service.ts).
--     Ele aparecia como "Ativo" no painel e era elegível para envio — o
--     dispatcher tentava enviar com um token literal 'LOCAL_DEV' e falhava.
--     A criação desse canal foi removida do código no mesmo commit.
--
-- Aditivo e idempotente.

-- (A) cota de marketing gratuito -------------------------------------------
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS free_marketing_remaining INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN subscriptions.free_marketing_remaining IS
  'Mensagens de MARKETING que ainda podem ser enviadas sem debitar a taxa Zaplane (cota inclusa na assinatura). Decrementada a cada mensagem de marketing tarifada pela Meta.';

-- Organizações que já assinaram antes desta migração recebem a cota do 1º mês.
UPDATE subscriptions
   SET free_marketing_remaining = 200
 WHERE free_marketing_remaining = 0
   AND status IN ('active', 'past_due');

-- (B) limpeza do canal placeholder ------------------------------------------
-- Só remove o que é comprovadamente placeholder (nunca um canal real):
-- phone_number_id/waba_id literalmente 'LOCAL_DEV' ou os do seed de exemplo.
DELETE FROM whatsapp_channels
 WHERE phone_number_id IN ('LOCAL_DEV', 'PHONE_NUMBER_ID_AQUI')
    OR waba_id IN ('LOCAL_DEV', 'WABA_ID_AQUI');

-- Plugar credenciais REAIS da Meta no canal (número de TESTE do app "teste").
-- Valores já preenchidos a partir da tela "Configuração da API":
--   Phone Number ID : 1182531791605864
--   WABA ID         : 1585631720233640
--   Número de teste : +1 555 644-1238
-- FALTA só o ACCESS_TOKEN (clique "Gerar token" na Meta e cole abaixo).
--
-- Alvo: org "Teste Local" (teste@local.dev) criada no painel.
-- Rodar:  psql -d zaplane -f scripts/set-channel-meta.sql

UPDATE whatsapp_channels SET
  phone_number_id  = '1182531791605864',
  waba_id          = '1585631720233640',
  access_token_enc = 'COLE_O_ACCESS_TOKEN_AQUI',
  display_number   = '+15556441238',
  status           = 'active'
WHERE organization_id = (SELECT id FROM organizations WHERE slug LIKE 'teste-local%' ORDER BY created_at DESC LIMIT 1);

-- Confirme:
--   psql -d zaplane -c "SELECT o.name, c.phone_number_id, c.waba_id, c.status FROM whatsapp_channels c JOIN organizations o ON o.id=c.organization_id;"

-- Dados de exemplo para desenvolvimento (opcional).
-- Para logar no painel, registre uma organização via POST /auth/register
-- (isso cria org + usuário owner com senha via Argon2id). Este seed apenas
-- popula uma org demo com contatos/template para você ver dados na tela.
--
-- Rode-o DEPOIS de todas as migrações (001 e as `00X_*.sql` seguintes), não
-- logo após a 001: ele grava `templates.meta_name`/`scope`, colunas que a 014
-- acrescenta. Aplicar só a 001 deixa o gateway quebrado de qualquer jeito — o
-- Prisma lista as colunas uma a uma e pede as novas em toda consulta.

INSERT INTO organizations (id, name, slug, plan, daily_message_limit)
VALUES ('00000000-0000-0000-0000-000000000001', 'Petshop Demo', 'petshop-demo', 'pro', 5000)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO whatsapp_channels (id, organization_id, label, phone_number_id, waba_id, display_number, access_token_enc)
VALUES ('00000000-0000-0000-0000-0000000000c1',
        '00000000-0000-0000-0000-000000000001',
        'Petshop - Atendimento', 'PHONE_NUMBER_ID_AQUI', 'WABA_ID_AQUI', '+5511999999999', 'TOKEN_CIFRADO_AQUI')
ON CONFLICT (organization_id, phone_number_id) DO NOTHING;

INSERT INTO contacts (organization_id, phone_e164, phone_hash, name, ddd, region, tags, consent_status, consent_source, consent_at)
VALUES
 ('00000000-0000-0000-0000-000000000001', '+5511988887777', 'hash_demo_1', 'Maria Silva',  '11', 'SP', '{cliente,vip}',   'granted', 'cadastro_loja', now()),
 ('00000000-0000-0000-0000-000000000001', '+5521977776666', 'hash_demo_2', 'João Souza',   '21', 'RJ', '{cliente}',       'granted', 'cadastro_loja', now()),
 ('00000000-0000-0000-0000-000000000001', '+5531966665555', 'hash_demo_3', 'Ana Pereira',  '31', 'MG', '{prospect}',      'unknown', NULL, NULL)
ON CONFLICT (organization_id, phone_hash) DO NOTHING;

-- `name` é o rótulo que o cliente lê; `meta_name` é o nome que existe na Meta,
-- prefixado pelo dono (014). O prefixo é `z` + os 12 primeiros caracteres
-- hexadecimais do id da organização — a mesma regra de `prefixoDaOrg()`, em
-- services/api-gateway/src/templates/meta-nome.ts. Para a org demo
-- (00000000-0000-0000-0000-000000000001) a função devolve `z000000000000`:
-- os hífens não são hexadecimais e saem fora, sobrando 12 zeros. Não são
-- zeros de enfeite — se você trocar o id da org acima, recalcule este valor
-- com `prefixoDaOrg`, senão o `sync()` não reconhece a linha como sendo dela.
INSERT INTO templates (organization_id, name, meta_name, scope, language, category, status, body, variables_count)
VALUES ('00000000-0000-0000-0000-000000000001', 'promo_banho_tosa',
        'z000000000000_promo_banho_tosa', 'org', 'pt_BR', 'MARKETING', 'APPROVED',
        'Olá {{1}}! Esta semana o banho & tosa está com 20% de desconto no Petshop Demo. Responda PARAR para não receber mais.', 1)
ON CONFLICT (organization_id, name, language) DO NOTHING;

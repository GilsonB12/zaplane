-- 014_templates_por_dono.sql
-- Templates deixam de ser visíveis entre organizações que dividem a mesma WABA.
--
-- Dois nomes: `name` é o que o cliente vê; `meta_name` é o que existe na Meta,
-- com prefixo derivado do id da organização. O nome do template é único na
-- WABA (não por organização), então sem o prefixo dois clientes não podem ter
-- "promocao" — e o erro de nome duplicado da Meta entrega que o template do
-- outro existe.

BEGIN;

ALTER TABLE templates ADD COLUMN IF NOT EXISTS meta_name TEXT;
-- os templates que já existem são de WABA dedicada e não têm prefixo:
-- o nome na Meta é o próprio nome local
UPDATE templates SET meta_name = name WHERE meta_name IS NULL;
ALTER TABLE templates ALTER COLUMN meta_name SET NOT NULL;

COMMENT ON COLUMN templates.meta_name IS
  'Nome do template na Meta (com prefixo da organização). É este que vai no envio, nunca o name.';

-- quem precisa ser único por organização e idioma é o meta_name (o que vai
-- para a Meta), não o name (rótulo que o cliente digita). Sem esta trava,
-- dois rótulos diferentes que normalizam para o mesmo meta_name (ex.:
-- "Promoção de Banho" e "PROMOÇÃO DE BANHO!!!") passavam pela checagem em
-- nível de aplicação — que ainda comparava o rótulo — e só colidiam ao
-- chegar na Meta; como a submissão é best-effort, a falha ficava engolida e
-- o segundo rascunho ficava preso em PENDING para sempre, sem rota de saída
-- (não existe DELETE /templates/:id).
ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_organization_id_meta_name_language_key;
ALTER TABLE templates ADD CONSTRAINT templates_organization_id_meta_name_language_key
  UNIQUE (organization_id, meta_name, language);

ALTER TABLE templates ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'org';
ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_scope_check;
ALTER TABLE templates ADD CONSTRAINT templates_scope_check
  CHECK (scope IN ('org','platform'));

-- genérico não tem dono
ALTER TABLE templates ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_escopo_dono_check;
ALTER TABLE templates ADD CONSTRAINT templates_escopo_dono_check CHECK (
  (scope = 'org'      AND organization_id IS NOT NULL) OR
  (scope = 'platform' AND organization_id IS NULL)
);

-- o UNIQUE (organization_id, name, language) não segura os genéricos: no
-- Postgres, NULL é distinto de NULL, então dois genéricos poderiam ter o
-- mesmo nome
CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_plataforma
  ON templates (name, language) WHERE scope = 'platform';

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN users.is_platform_admin IS
  'Operação da Zaplane. O RBAC (role) é por organização; isto é acima dela.';

COMMIT;

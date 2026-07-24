-- 007_org_cpf_cnpj.sql
-- Coleta de CPF/CNPJ do responsável pela cobrança.
--
-- Motivação: o provedor de pagamento (Asaas) EXIGE um CPF/CNPJ válido do
-- pagador ao criar o customer em PRODUÇÃO. Até aqui o código enviava um
-- placeholder de sandbox (asaas.provider.ts), o que funciona em homologação
-- mas falha em produção. Esta coluna guarda o documento por organização; o
-- billing.service valida (dígitos verificadores) e o exige quando
-- NODE_ENV=production antes de criar o customer.
--
-- Aditivo e idempotente (não editar migrações já aplicadas — nova numeração).

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS cpf_cnpj TEXT;

COMMENT ON COLUMN organizations.cpf_cnpj IS
  'CPF (11 díg.) ou CNPJ (14 díg.) do responsável pela cobrança, somente dígitos. Enviado ao provedor de pagamento na criação do customer. Obrigatório em produção.';

-- 011_password_reset.sql
--
-- Recuperação de senha ("esqueci minha senha").
--
-- Antes disto, um cliente que esquecesse a senha ficava trancado para fora sem
-- autoatendimento: só abrindo chamado. Para quem paga mensalidade e usa o
-- painel todo dia, isso é inaceitável — e era um dos achados que bloqueavam a
-- venda na auditoria.
--
-- Decisões de segurança refletidas no schema:
--  - guardamos só o HASH do token (nunca o valor): vazamento do banco não
--    permite redefinir a senha de ninguém;
--  - `used_at` torna o token de uso único — depois de redefinir, o mesmo link
--    de e-mail não funciona de novo;
--  - `expires_at` curto (o serviço usa 1 hora) limita a janela de um e-mail
--    que fique esquecido numa caixa de entrada;
--  - `requested_ip` fica só para auditoria de abuso.
--
-- Aditivo e idempotente.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash    TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    used_at       TIMESTAMPTZ,
    requested_ip  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);
-- busca pelo hash é o caminho quente na hora de redefinir
CREATE UNIQUE INDEX IF NOT EXISTS ux_password_reset_hash ON password_reset_tokens(token_hash);

COMMENT ON TABLE password_reset_tokens IS
  'Tokens de redefinição de senha. Guarda apenas o hash; uso único (used_at) e validade curta (expires_at).';

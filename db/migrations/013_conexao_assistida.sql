-- 013_conexao_assistida.sql
-- Conexão assistida: o número do cliente passa a viver na WABA da Zaplane.
--
-- O estado parcial vive AQUI, não em whatsapp_channels, porque o ClaimBatch do
-- dispatcher faz JOIN naquela tabela sem filtrar status — um canal meia-boca
-- lá seria armadilha na parte mais sensível do sistema. Invariante: linha em
-- whatsapp_channels ⇒ número verificado, registrado e pronto para enviar.

BEGIN;

CREATE TABLE IF NOT EXISTS channel_connection_requests (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    waba_id           TEXT NOT NULL,
    -- PII: número cifrado (AES-GCM) + HMAC para unicidade/cooldown sem expor
    phone_e164_enc    TEXT NOT NULL,
    phone_hash        TEXT NOT NULL,
    -- DDD e 4 últimos em claro: é o mínimo para a UI mascarar na retomada
    -- ((85) 9••••-••99) sem precisar decifrar o número
    phone_ddd         TEXT NOT NULL,
    phone_last4       TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    phone_number_id   TEXT,
    -- PIN de 2 etapas gerado pelo servidor; nunca exibido ao cliente
    register_pin_enc  TEXT,
    status            TEXT NOT NULL DEFAULT 'criando'
                      CHECK (status IN ('criando','aguardando_codigo','concluida','falhou','cancelada')),
    code_requests     INTEGER NOT NULL DEFAULT 0,
    code_attempts     INTEGER NOT NULL DEFAULT 0,
    last_code_sent_at TIMESTAMPTZ,
    -- Momento em que a Meta ACEITOU o código. Sem isso, uma falha transitória
    -- no /register depois de um verify_code bem-sucedido deixa o cliente sem
    -- saída: a única coisa que ele pode fazer é digitar o mesmo código de
    -- novo, a Meta recusa ("número já verificado"), isso conta como código
    -- errado e as 5 tentativas terminam a solicitação em 'falhou' — com a
    -- vaga do número já consumida na WABA, e ela não volta por API.
    code_verified_at  TIMESTAMPTZ,
    error_code        TEXT,
    error_detail      TEXT,
    channel_id        UUID REFERENCES whatsapp_channels(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE channel_connection_requests IS
  'Conexão de número em andamento. O código de 6 dígitos NUNCA é gravado — só contadores e horários.';

-- Idempotência: a tabela acima é criada com IF NOT EXISTS, então numa base que
-- já tenha uma cópia anterior deste arquivo a coluna nova não nasceria.
ALTER TABLE channel_connection_requests
    ADD COLUMN IF NOT EXISTS code_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN channel_connection_requests.code_verified_at IS
  'Quando a Meta aceitou o código. Preenchida ANTES do /register: é o que permite a segunda tentativa pular direto para o registro em vez de reenviar um código que a Meta já não aceita.';

-- no máximo uma solicitação viva por organização
CREATE UNIQUE INDEX IF NOT EXISTS idx_ccr_org_viva
    ON channel_connection_requests (organization_id)
    WHERE status IN ('criando','aguardando_codigo');

-- o mesmo número não pode estar em duas solicitações vivas, de nenhuma org
CREATE UNIQUE INDEX IF NOT EXISTS idx_ccr_phone_viva
    ON channel_connection_requests (phone_hash)
    WHERE status IN ('criando','aguardando_codigo');

-- cooldown de SMS é por número e cross-tenant
CREATE INDEX IF NOT EXISTS idx_ccr_phone_recente
    ON channel_connection_requests (phone_hash, last_code_sent_at);

-- connected_via ganha o valor novo. O CHECK veio da 003 com nome auto-gerado,
-- daí o IF EXISTS: o nome pode divergir entre ambientes.
ALTER TABLE whatsapp_channels
    DROP CONSTRAINT IF EXISTS whatsapp_channels_connected_via_check;
ALTER TABLE whatsapp_channels
    ADD CONSTRAINT whatsapp_channels_connected_via_check
    CHECK (connected_via IN ('manual','embedded_signup','bootstrap','assisted'));

-- a vaga do número na Meta não volta por API (DELETE /{pnid} não é suportado),
-- então a unicidade vale inclusive para canais desconectados
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_pnid_global
    ON whatsapp_channels (phone_number_id);

ALTER TABLE whatsapp_channels
    ADD COLUMN IF NOT EXISTS register_pin_enc TEXT;

COMMENT ON COLUMN whatsapp_channels.register_pin_enc IS
  'PIN de 2 etapas do registro na Meta, cifrado. Necessário para re-registrar ou desregistrar o número.';

COMMIT;

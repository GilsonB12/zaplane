-- 012_queue_resilience.sql
-- Resiliência da fila de envio. Corrige três perdas silenciosas:
--   (a) erro de limite/credencial da Meta queimava a fila inteira como falha
--       definitiva  -> agora o canal é PAUSADO e as mensagens esperam;
--   (b) mensagens presas em 'sending' após queda/deploy do worker nunca
--       voltavam -> o reaper devolve, e precisa de índice p/ não varrer a tabela;
--   (c) a reserva do lote fazia seq scan conforme a tabela cresce.
--
-- Os índices são PARCIAIS de propósito: indexam só as linhas 'queued'/'sending'
-- (fração pequena e que encolhe conforme as mensagens saem), então o custo de
-- INSERT/UPDATE fica baixo — diferente de um índice cheio sobre a fila toda.

BEGIN;

-- (a) pausa do canal -------------------------------------------------------
-- Quando a Meta devolve limite de vazão (131048, 130429, 4, 80007...) ou
-- credencial inválida (190, 200...), o problema é do CANAL e não da mensagem.
-- Pausar evita marretar a Graph API com milhares de envios que já sabemos que
-- vão falhar — o que pioraria o limite e mancharia a qualidade do número.
ALTER TABLE whatsapp_channels
    ADD COLUMN IF NOT EXISTS paused_until  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS paused_reason TEXT;

COMMENT ON COLUMN whatsapp_channels.paused_until IS
    'Enquanto > now(), o dispatcher não reserva mensagens deste canal. Definido ao receber erro de limite ou credencial da Meta.';
COMMENT ON COLUMN whatsapp_channels.paused_reason IS
    'Código/motivo da última pausa automática (ex.: rate_limit:131048, auth:190).';

-- (b) reserva do lote ------------------------------------------------------
-- NÃO criar índice aqui: o `idx_outbox_poll` da 001_init.sql já é
-- (next_attempt_at) WHERE status='queued' — exatamente o WHERE/ORDER BY do
-- ClaimBatch. Um segundo índice idêntico só faria a tabela mais escrita do
-- sistema pagar duas manutenções por INSERT (CLAUDE.md §8).

-- (c) reaper ---------------------------------------------------------------
-- Casa com o WHERE do ReapStale. Em operação normal fica quase vazio.
CREATE INDEX IF NOT EXISTS idx_outbound_presas
    ON outbound_messages (locked_at)
    WHERE status = 'sending';

-- Recuperação imediata: devolve o que já está preso em 'sending' há mais de
-- 10 minutos (resíduo dos deploys anteriores a esta migração).
-- As que ainda têm tentativa sobrando voltam para a fila; as esgotadas viram
-- falha — e aí o contador da campanha precisa acompanhar, senão o painel passa
-- a mostrar um total que não fecha.
WITH mortas AS (
    UPDATE outbound_messages
       SET status       = 'failed',
           locked_by    = NULL,
           locked_at    = NULL,
           error_code   = 'worker_lost',
           error_detail = 'perdida em deploy anterior; tentativas esgotadas (migração 012)',
           updated_at   = now()
     WHERE status = 'sending'
       AND locked_at < now() - interval '10 minutes'
       AND attempts >= max_attempts
    RETURNING campaign_id
)
UPDATE campaigns c
   SET failed_count = c.failed_count + agg.n
  FROM (SELECT campaign_id, count(*) AS n
          FROM mortas WHERE campaign_id IS NOT NULL
         GROUP BY campaign_id) agg
 WHERE c.id = agg.campaign_id;

UPDATE outbound_messages
   SET status          = 'queued',
       locked_by       = NULL,
       locked_at       = NULL,
       next_attempt_at = now(),
       error_code      = 'worker_lost',
       error_detail    = 'devolvida pela migração 012 (worker caiu ou reiniciou durante o envio)',
       updated_at      = now()
 WHERE status = 'sending'
   AND locked_at < now() - interval '10 minutes';

COMMIT;

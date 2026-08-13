package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrChannelNotFound distingue "esse canal não existe" (culpa da mensagem, que
// deve falhar) de "não consegui ler o canal agora" (culpa da infra, que deve
// ser retentada). Tratar os dois igual transformava um blip do Postgres em
// falha definitiva e irrecuperável da mensagem.
var ErrChannelNotFound = errors.New("canal não encontrado")

// ErrPosseperdida indica que a linha já não pertence a este worker: o reaper a
// devolveu à fila e outro worker assumiu. Precisa ser um erro distinto (e não
// um silencioso "0 linhas afetadas") porque no caminho do MarkSent ele é o
// ÚNICO rastro de uma possível entrega duplicada — a Meta aceitou a mensagem,
// mas quem grava o desfecho é outro.
var ErrPosseperdida = errors.New("a mensagem já não pertence a este worker")

type Store struct {
	pool *pgxpool.Pool
}

// Message é uma linha reservada da fila outbound_messages.
type Message struct {
	ID          string
	OrgID       string
	ChannelID   string
	ToPhone     string
	Payload     []byte // JSON pronto p/ a Meta (jsonb)
	Attempts    int
	MaxAttempts int
}

// Channel guarda as credenciais da Meta usadas no envio.
type Channel struct {
	PhoneNumberID  string
	AccessTokenEnc string
	RatePerSec     int
}

func New(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

// VerificarSchema falha se a migração 012 não tiver sido aplicada. Sem esta
// checagem, o ClaimBatch daria erro de coluna inexistente a cada poll e o
// worker trataria como falha transitória: log a cada 750ms, processo vivo,
// healthcheck verde e ZERO mensagem entregue. Melhor não subir.
func (s *Store) VerificarSchema(ctx context.Context) error {
	var ok bool
	err := s.pool.QueryRow(ctx, `
SELECT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'whatsapp_channels'
                  AND column_name = 'paused_until')`).Scan(&ok)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("schema desatualizado: aplique db/migrations/012_queue_resilience.sql ANTES de subir esta versão")
	}
	return nil
}

// ClaimBatch reserva até `limit` mensagens prontas para envio usando
// FOR UPDATE SKIP LOCKED — várias réplicas podem rodar sem conflito.
//
// Canais pausados (paused_until > now()) ficam de fora: quando a Meta diz que
// o canal estourou a cota ou está com credencial inválida, não adianta reservar
// as mensagens dele — só gastaria tentativa e marretaria a Graph API. Elas
// esperam em 'queued' e voltam a fluir sozinhas quando a pausa vence.
//
// O `OF m` no FOR UPDATE é essencial: sem ele o Postgres tentaria travar também
// a linha do canal, e todos os workers passariam a disputar a MESMA linha de
// whatsapp_channels — serializando o que deveria ser paralelo.
func (s *Store) ClaimBatch(ctx context.Context, workerID string, limit int) ([]Message, error) {
	const q = `
UPDATE outbound_messages o
   SET status = 'sending', locked_at = now(), locked_by = $1, attempts = attempts + 1
  FROM (
        SELECT m.id
          FROM outbound_messages m
          JOIN whatsapp_channels c ON c.id = m.channel_id
         WHERE m.status = 'queued'
           AND m.next_attempt_at <= now()
           AND (c.paused_until IS NULL OR c.paused_until <= now())
         ORDER BY m.next_attempt_at
         FOR UPDATE OF m SKIP LOCKED
         LIMIT $2
       ) sub
 WHERE o.id = sub.id
RETURNING o.id, o.organization_id, o.channel_id, o.to_phone_e164, o.payload, o.attempts, o.max_attempts;`

	rows, err := s.pool.Query(ctx, q, workerID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Message
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.OrgID, &m.ChannelID, &m.ToPhone, &m.Payload, &m.Attempts, &m.MaxAttempts); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// RenovarPosse re-carimba locked_at das mensagens que AINDA pertencem a este
// worker e devolve o conjunto das que sobreviveram.
//
// Existe por um motivo específico: o ClaimBatch carimba locked_at UMA vez para
// o lote inteiro. Num lote lento (Meta degradada, timeouts de 20s), a cauda
// envelhece junto com a cabeça e o reaper a recolhe enquanto o worker ainda a
// tem em memória — o worker então envia uma mensagem que outro worker já
// enviou, e o cliente final recebe DUPLICADA. Renovando periodicamente, o
// reaper só encontra o que de fato ficou órfão.
//
// O RETURNING diz exatamente quais continuam nossas: as que faltarem já foram
// para outro worker e não podem ser enviadas por este.
func (s *Store) RenovarPosse(ctx context.Context, workerID string, ids []string) (map[string]bool, error) {
	vivas := make(map[string]bool, len(ids))
	if len(ids) == 0 {
		return vivas, nil
	}
	rows, err := s.pool.Query(ctx,
		`UPDATE outbound_messages SET locked_at = now()
		  WHERE id = ANY($2) AND locked_by = $1 AND status = 'sending'
		RETURNING id`, workerID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		vivas[id] = true
	}
	return vivas, rows.Err()
}

func (s *Store) GetChannel(ctx context.Context, channelID string) (Channel, error) {
	var c Channel
	err := s.pool.QueryRow(ctx,
		`SELECT phone_number_id, access_token_enc, throughput_limit
		   FROM whatsapp_channels WHERE id = $1`, channelID).
		Scan(&c.PhoneNumberID, &c.AccessTokenEnc, &c.RatePerSec)
	if errors.Is(err, pgx.ErrNoRows) {
		return c, ErrChannelNotFound
	}
	return c, err
}

// PauseChannel suspende o consumo da fila deste canal por `secs` segundos.
//
// GREATEST garante que uma pausa curta (limite de vazão) nunca encurte uma
// pausa longa já em vigor (credencial inválida, por exemplo).
//
// Faz mais duas coisas junto, na mesma transação:
//   - empurra o next_attempt_at das mensagens desse canal para o fim da pausa,
//     senão elas ficariam na cabeça da ordenação e todo poll varreria o índice
//     inteiro só para descartá-las;
//   - quando `alerta` vem preenchido, grava nos campos de alerta da migração
//     009, que o painel JÁ exibe — assim o cliente vê "canal pausado: token
//     inválido" em vez de uma campanha parada em 40% sem explicação.
// A pausa em si é gravada e commitada SOZINHA: é a parte crítica e é O(1).
// O empurrão do next_attempt_at pode tocar dezenas de milhares de linhas, e
// juntá-lo na mesma transação faria um estouro de deadline desfazer também a
// pausa — voltando exatamente ao bug que ela corrige (o worker marretando a
// Meta com envios que já sabemos que vão falhar).
func (s *Store) PauseChannel(ctx context.Context, channelID string, secs int, motivo, alerta string) error {
	var pausadoAte time.Time
	var jaEstavaPausado bool

	// O CTE `antes` guarda o valor ANTERIOR de paused_until. Sem ele não dá
	// para saber se o canal já estava pausado: no RETURNING de um UPDATE, as
	// colunas trazem o valor NOVO — que aqui é sempre futuro, e a checagem
	// daria "já pausado" em todas as vezes.
	err := s.pool.QueryRow(ctx,
		`WITH antes AS (
		     SELECT paused_until AS anterior FROM whatsapp_channels WHERE id = $1
		 )
		 UPDATE whatsapp_channels c
		    SET paused_until  = GREATEST(COALESCE(c.paused_until, now()), now() + make_interval(secs => $2)),
		        paused_reason = $3,
		        alert_severity = CASE WHEN $4::text <> '' THEN 'CRITICAL' ELSE c.alert_severity END,
		        alert_type     = CASE WHEN $4::text <> '' THEN 'dispatcher_pause' ELSE c.alert_type END,
		        alert_message  = CASE WHEN $4::text <> '' THEN $4::text ELSE c.alert_message END,
		        alert_at       = CASE WHEN $4::text <> '' THEN now() ELSE c.alert_at END,
		        updated_at    = now()
		   FROM antes
		  WHERE c.id = $1
		RETURNING c.paused_until, (antes.anterior IS NOT NULL AND antes.anterior > now()) AS ja_pausado`,
		channelID, secs, motivo, alerta).Scan(&pausadoAte, &jaEstavaPausado)
	if err != nil {
		return err
	}

	// Só vale empurrar as mensagens na PRIMEIRA pausa. Nas seguintes elas já
	// estão adiadas, e repetir o UPDATE em massa a cada mensagem que falha
	// seria reescrever a fila inteira várias vezes por minuto.
	if jaEstavaPausado {
		return nil
	}
	return s.adiarMensagensDoCanal(channelID, pausadoAte)
}

// adiarMensagensDoCanal empurra as mensagens 'queued' do canal para o fim da
// pausa, para que a reserva pare de varrer o índice só para descartá-las.
// É otimização, não correção: o filtro por paused_until no ClaimBatch já
// garante o comportamento. Por isso roda em contexto próprio e o erro é
// apenas registrado.
func (s *Store) adiarMensagensDoCanal(channelID string, ate time.Time) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	_, err := s.pool.Exec(ctx,
		`UPDATE outbound_messages
		    SET next_attempt_at = GREATEST(next_attempt_at, $2::timestamptz)
		  WHERE channel_id = $1 AND status = 'queued'`, channelID, ate)
	return err
}

// LimparPausasVencidas apaga o alerta sintético que o dispatcher gravou quando
// a pausa já passou. Sem isto o painel mostraria "Envios pausados" em CRITICAL
// para sempre: quem limpa os campos alert_* no gateway é o webhook
// `account_alerts` da Meta com status RESOLVED, e a Meta nunca vai resolver um
// alerta que ela não emitiu.
func (s *Store) LimparPausasVencidas(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE whatsapp_channels
		    SET alert_severity=NULL, alert_type=NULL, alert_message=NULL, alert_at=NULL,
		        paused_reason=NULL, updated_at=now()
		  WHERE alert_type = 'dispatcher_pause'
		    AND (paused_until IS NULL OR paused_until <= now())`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// MarkSent: envio aceito pela Meta (entrega/leitura chegam depois via webhook).
//
// A guarda `locked_by/status` existe para o caso em que a linha já foi devolvida
// à fila pelo reaper e reenviada por outro worker: sem ela, este worker
// sobrescreveria o desfecho do outro e o contador da campanha seria somado duas
// vezes (sent_count + failed_count passando de total_recipients).
func (s *Store) MarkSent(ctx context.Context, id, workerID, waMessageID string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE outbound_messages
		    SET status='sent', wa_message_id=$3, sent_at=now(), locked_by=NULL, updated_at=now()
		  WHERE id=$1 AND locked_by=$2 AND status='sending'`, id, workerID, waMessageID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrPosseperdida
	}
	_, _ = s.pool.Exec(ctx,
		`UPDATE campaigns c SET sent_count = sent_count + 1
		   FROM outbound_messages o
		  WHERE o.id=$1 AND o.campaign_id = c.id`, id)
	return nil
}

// MarkFailed: erro permanente (não retentável) ou tentativas esgotadas.
func (s *Store) MarkFailed(ctx context.Context, id, workerID, code, detail string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE outbound_messages
		    SET status='failed', error_code=$3, error_detail=$4, locked_by=NULL, updated_at=now()
		  WHERE id=$1 AND locked_by=$2 AND status='sending'`, id, workerID, code, detail)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrPosseperdida
	}
	_, _ = s.pool.Exec(ctx,
		`UPDATE campaigns c SET failed_count = failed_count + 1
		   FROM outbound_messages o
		  WHERE o.id=$1 AND o.campaign_id = c.id`, id)
	return nil
}

// Reschedule: erro transitório → volta para a fila com backoff (em segundos).
// Usa make_interval p/ evitar problemas de formato de interval.
func (s *Store) Reschedule(ctx context.Context, id, workerID, code, detail string, backoffSecs int) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE outbound_messages
		    SET status='queued', error_code=$3, error_detail=$4,
		        next_attempt_at = now() + make_interval(secs => $5),
		        locked_by=NULL, locked_at=NULL, updated_at=now()
		  WHERE id=$1 AND locked_by=$2 AND status='sending'`,
		id, workerID, code, detail, backoffSecs)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrPosseperdida
	}
	return nil
}

// ReleaseBatch devolve à fila mensagens que foram reservadas mas nunca chegaram
// a ser enviadas — o caso do shutdown no meio do lote. Como não houve tentativa
// de verdade, o contador de tentativas é desfeito: um deploy não pode consumir
// a cota de retentativas do cliente.
//
// A guarda por locked_by impede devolver linha que já pertence a outro worker.
func (s *Store) ReleaseBatch(ctx context.Context, workerID string, ids []string) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	tag, err := s.pool.Exec(ctx,
		`UPDATE outbound_messages
		    SET status='queued', locked_by=NULL, locked_at=NULL,
		        next_attempt_at = now(), attempts = GREATEST(attempts - 1, 0),
		        updated_at = now()
		  WHERE id = ANY($2) AND locked_by = $1 AND status='sending'`, workerID, ids)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ReapStale devolve à fila mensagens presas em 'sending'. Isso acontece quando
// o worker morre entre reservar e concluir o envio — deploy, OOM, queda da
// máquina. Sem isso elas somem: saem do índice da fila (status != 'queued') e
// ninguém nunca mais olha para elas. Eram até 200 mensagens por deploy,
// silenciosas: sem erro, sem log, sem falha visível para o cliente.
//
// A segurança contra reenvio duplicado vem de RenovarPosse: um worker vivo
// re-carimba locked_at antes de cada envio, então só chega aqui o que
// realmente ficou órfão.
//
// Devolve (devolvidas, falhadas). As que já esgotaram max_attempts viram falha
// definitiva — senão ficariam circulando para sempre.
func (s *Store) ReapStale(ctx context.Context, olderThanSecs int) (int64, int64, error) {
	const detalhe = "worker caiu ou reiniciou durante o envio"

	// (a) esgotadas → falha definitiva, mantendo o contador da campanha coerente
	var falhadas int64
	err := s.pool.QueryRow(ctx, `
WITH mortas AS (
    UPDATE outbound_messages
       SET status='failed', locked_by=NULL, locked_at=NULL,
           error_code='worker_lost',
           error_detail=$2 || '; tentativas esgotadas',
           updated_at=now()
     WHERE status='sending'
       AND locked_at < now() - make_interval(secs => $1)
       AND attempts >= max_attempts
    RETURNING campaign_id
), contadores AS (
    UPDATE campaigns c
       SET failed_count = c.failed_count + agg.n
      FROM (SELECT campaign_id, count(*) AS n
              FROM mortas WHERE campaign_id IS NOT NULL
             GROUP BY campaign_id) agg
     WHERE c.id = agg.campaign_id
    RETURNING 1
)
SELECT count(*) FROM mortas`, olderThanSecs, detalhe).Scan(&falhadas)
	if err != nil {
		return 0, 0, err
	}

	// (b) o resto volta para a fila imediatamente
	tag, err := s.pool.Exec(ctx, `
UPDATE outbound_messages
   SET status='queued', locked_by=NULL, locked_at=NULL,
       next_attempt_at=now(),
       error_code='worker_lost', error_detail=$2, updated_at=now()
 WHERE status='sending'
   AND locked_at < now() - make_interval(secs => $1)`, olderThanSecs, detalhe)
	if err != nil {
		return 0, falhadas, err
	}
	return tag.RowsAffected(), falhadas, nil
}

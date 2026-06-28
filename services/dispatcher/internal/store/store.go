package store

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

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

// ClaimBatch reserva até `limit` mensagens prontas para envio usando
// FOR UPDATE SKIP LOCKED — várias réplicas podem rodar sem conflito.
func (s *Store) ClaimBatch(ctx context.Context, workerID string, limit int) ([]Message, error) {
	const q = `
UPDATE outbound_messages o
   SET status = 'sending', locked_at = now(), locked_by = $1, attempts = attempts + 1
  FROM (
        SELECT id FROM outbound_messages
         WHERE status = 'queued' AND next_attempt_at <= now()
         ORDER BY next_attempt_at
         FOR UPDATE SKIP LOCKED
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

func (s *Store) GetChannel(ctx context.Context, channelID string) (Channel, error) {
	var c Channel
	err := s.pool.QueryRow(ctx,
		`SELECT phone_number_id, access_token_enc, throughput_limit
		   FROM whatsapp_channels WHERE id = $1`, channelID).
		Scan(&c.PhoneNumberID, &c.AccessTokenEnc, &c.RatePerSec)
	return c, err
}

// MarkSent: envio aceito pela Meta (entrega/leitura chegam depois via webhook).
func (s *Store) MarkSent(ctx context.Context, id, waMessageID string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE outbound_messages
		    SET status='sent', wa_message_id=$2, sent_at=now(), locked_by=NULL
		  WHERE id=$1`, id, waMessageID)
	return err
}

// MarkFailed: erro permanente (não retentável) ou tentativas esgotadas.
func (s *Store) MarkFailed(ctx context.Context, id, code, detail string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE outbound_messages
		    SET status='failed', error_code=$2, error_detail=$3, locked_by=NULL
		  WHERE id=$1`, id, code, detail)
	if err == nil {
		_, _ = s.pool.Exec(ctx,
			`UPDATE campaigns c SET failed_count = failed_count + 1
			   FROM outbound_messages o
			  WHERE o.id=$1 AND o.campaign_id = c.id`, id)
	}
	return err
}

// Reschedule: erro transitório → volta para a fila com backoff (em segundos).
// Usa make_interval p/ evitar problemas de formato de interval.
func (s *Store) Reschedule(ctx context.Context, id, code, detail string, backoffSecs int) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE outbound_messages
		    SET status='queued', error_code=$2, error_detail=$3,
		        next_attempt_at = now() + make_interval(secs => $4), locked_by=NULL
		  WHERE id=$1`,
		id, code, detail, backoffSecs)
	return err
}


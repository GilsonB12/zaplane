package worker

import (
	"context"
	"fmt"
	"log"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/zaplane/dispatcher/internal/config"
	"github.com/zaplane/dispatcher/internal/crypto"
	"github.com/zaplane/dispatcher/internal/ratelimit"
	"github.com/zaplane/dispatcher/internal/store"
	"github.com/zaplane/dispatcher/internal/whatsapp"
)

type Worker struct {
	cfg      config.Config
	store    *store.Store
	wa       *whatsapp.Client
	limiters *ratelimit.Registry

	chMu  sync.Mutex
	chche map[string]store.Channel // cache simples de canais

	decFailMu     sync.Mutex
	decFailLogged map[string]bool // canais cuja falha de decrypt já foi logada (1x)
}

func New(cfg config.Config, st *store.Store, wa *whatsapp.Client) *Worker {
	return &Worker{
		cfg:           cfg,
		store:         st,
		wa:            wa,
		limiters:      ratelimit.NewRegistry(cfg.DefaultRatePerSec),
		chche:         make(map[string]store.Channel),
		decFailLogged: make(map[string]bool),
	}
}

// Run sobe N goroutines que consomem a fila independentemente (SKIP LOCKED).
func (w *Worker) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for i := 0; i < w.cfg.Concurrency; i++ {
		wg.Add(1)
		workerID := fmt.Sprintf("w-%d", i)
		go func() {
			defer wg.Done()
			w.loop(ctx, workerID)
		}()
	}
	wg.Wait()
}

func (w *Worker) loop(ctx context.Context, workerID string) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		msgs, err := w.store.ClaimBatch(ctx, workerID, w.cfg.BatchSize)
		if err != nil {
			log.Printf("[%s] erro ao reservar lote: %v", workerID, err)
			time.Sleep(w.cfg.PollInterval)
			continue
		}
		if len(msgs) == 0 {
			time.Sleep(w.cfg.PollInterval) // fila vazia → espera
			continue
		}
		for _, m := range msgs {
			if ctx.Err() != nil {
				return
			}
			w.process(ctx, m)
		}
	}
}

func (w *Worker) process(ctx context.Context, m store.Message) {
	ch, err := w.channel(ctx, m.ChannelID)
	if err != nil {
		_ = w.store.MarkFailed(ctx, m.ID, "channel_lookup", err.Error())
		return
	}

	token := w.resolveToken(ch, m.ChannelID)
	if token == "" {
		_ = w.store.MarkFailed(ctx, m.ID, "no_token", "canal sem access token (configure no banco ou WHATSAPP_ACCESS_TOKEN)")
		return
	}

	// respeita o throughput permitido para o canal
	if err := w.limiters.For(m.ChannelID, ch.RatePerSec).Wait(ctx); err != nil {
		return // ctx cancelado
	}

	res := w.wa.Send(ctx, ch.PhoneNumberID, token, m.Payload)

	switch {
	case res.ErrCode == "": // sucesso
		_ = w.store.MarkSent(ctx, m.ID, res.WAMessageID)
	case res.Retryable && m.Attempts < m.MaxAttempts:
		_ = w.store.Reschedule(ctx, m.ID, res.ErrCode, res.ErrDetail, backoff(m.Attempts))
	default:
		_ = w.store.MarkFailed(ctx, m.ID, res.ErrCode, res.ErrDetail)
	}
}

// resolveToken decide qual access token usar para autenticar na Graph API.
// O valor gravado pelo gateway pode ser: (a) vazio/placeholder → cai no
// fallback do .env (legado/dev); (b) texto puro (canais antigos, ainda sem
// cifragem); ou (c) cifrado no formato ivB64:tagB64:cipherB64 (AES-256-GCM —
// ver internal/crypto e services/api-gateway/src/common/crypto.util.ts).
// Se houver APP_ENCRYPTION_KEY configurada e o valor "parecer" cifrado
// (exatamente 2 ':'), tentamos decifrar; falhando, seguimos com o valor cru
// como texto puro — nunca derruba o envio por causa disso.
func (w *Worker) resolveToken(ch store.Channel, channelID string) string {
	t := ch.AccessTokenEnc
	if t == "" || t == "TOKEN_CIFRADO_AQUI" {
		return w.cfg.FallbackToken
	}

	if w.cfg.EncryptionKey != "" && strings.Count(t, ":") == 2 {
		if plain, err := crypto.Decrypt(t, w.cfg.EncryptionKey); err == nil {
			return plain
		} else {
			w.logDecryptFailureOnce(channelID, err)
		}
	}
	return t
}

// logDecryptFailureOnce registra a falha de decifragem apenas na primeira vez
// por canal (evita poluir o log a cada mensagem da fila). Nunca loga o valor
// cifrado nem a chave — só o erro (que não expõe segredo).
func (w *Worker) logDecryptFailureOnce(channelID string, err error) {
	w.decFailMu.Lock()
	defer w.decFailMu.Unlock()
	if w.decFailLogged[channelID] {
		return
	}
	w.decFailLogged[channelID] = true
	log.Printf("[channel %s] falha ao decifrar access token, seguindo como texto puro: %v", channelID, err)
}

func (w *Worker) channel(ctx context.Context, id string) (store.Channel, error) {
	w.chMu.Lock()
	if c, ok := w.chche[id]; ok {
		w.chMu.Unlock()
		return c, nil
	}
	w.chMu.Unlock()

	c, err := w.store.GetChannel(ctx, id)
	if err != nil {
		return store.Channel{}, err
	}
	w.chMu.Lock()
	w.chche[id] = c
	w.chMu.Unlock()
	return c, nil
}

// backoff exponencial em segundos, com teto de 300s (5 min).
func backoff(attempts int) int {
	secs := int(math.Pow(2, float64(attempts))) // 2,4,8,16...
	if secs < 1 {
		secs = 1
	}
	if secs > 300 {
		secs = 300
	}
	return secs
}

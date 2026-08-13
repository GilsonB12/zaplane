package worker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"math"
	mrand "math/rand"
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

	// identifica ESTE processo. Sem isso, duas réplicas no Railway teriam
	// ambas um worker chamado "w-0" e a checagem de posse (locked_by) daria
	// falso positivo entre elas — justamente o que ela existe para impedir.
	instancia string

	chMu  sync.Mutex
	chche map[string]canalCache // cache de canais, com validade

	decFailMu     sync.Mutex
	decFailLogged map[string]bool // canais cuja falha de decrypt já foi logada (1x)
}

// canalCache guarda o canal com prazo de validade. Sem o prazo, um token
// corrigido no banco nunca chegava ao worker: ele seguia usando o antigo até
// reiniciar, e a fila do cliente não se recuperava sozinha.
type canalCache struct {
	canal store.Channel
	valeI time.Time
}

// tempoLimiteEnvio limita o POST na Graph API mesmo com o contexto do worker
// já cancelado. Precisa ser um pouco maior que o timeout do http.Client
// (20s, ver whatsapp.NewClient) para que o próprio cliente expire primeiro e
// classifique o erro.
const tempoLimiteEnvio = 25 * time.Second

// resultado do processamento de uma mensagem, do ponto de vista do lote.
type resultado int

const (
	resSeguir       resultado = iota // pode continuar o lote
	resCanalPausado                  // o canal saiu do ar: devolver o resto dele
	resInterrompido                  // ctx cancelado (deploy): devolver o lote
)

func New(cfg config.Config, st *store.Store, wa *whatsapp.Client) *Worker {
	return &Worker{
		cfg:           cfg,
		store:         st,
		wa:            wa,
		limiters:      ratelimit.NewRegistry(cfg.DefaultRatePerSec),
		instancia:     idDeInstancia(),
		chche:         make(map[string]canalCache),
		decFailLogged: make(map[string]bool),
	}
}

func idDeInstancia() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("i%d", time.Now().UnixNano())
	}
	return "i" + hex.EncodeToString(b)
}

// Run sobe N goroutines que consomem a fila independentemente (SKIP LOCKED),
// mais o reaper que devolve mensagens órfãs.
func (w *Worker) Run(ctx context.Context) {
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		w.reaper(ctx)
	}()

	for i := 0; i < w.cfg.Concurrency; i++ {
		wg.Add(1)
		workerID := fmt.Sprintf("%s-w%d", w.instancia, i)
		go func() {
			defer wg.Done()
			w.loop(ctx, workerID)
		}()
	}
	wg.Wait()
}

// reaper devolve à fila as mensagens presas em 'sending'. Elas aparecem quando
// o worker morre entre reservar e concluir o envio — deploy, OOM, queda da
// máquina. Sem isso somem em silêncio: com status != 'queued' saem do alcance
// da reserva e ninguém nunca mais olha para elas.
func (w *Worker) reaper(ctx context.Context) {
	w.reapOnce(ctx) // resíduo de quedas anteriores, já na subida

	t := time.NewTicker(w.cfg.ReaperInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			w.reapOnce(ctx)
		}
	}
}

func (w *Worker) reapOnce(ctx context.Context) {
	devolvidas, falhadas, err := w.store.ReapStale(ctx, w.cfg.StuckAfterSecs)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("[reaper] erro ao devolver mensagens presas: %v", err)
		}
	} else if devolvidas > 0 || falhadas > 0 {
		log.Printf("[reaper] presas há mais de %ds: %d devolvida(s) à fila, %d marcada(s) como falha",
			w.cfg.StuckAfterSecs, devolvidas, falhadas)
	}

	// tira do painel o aviso de pausa cuja pausa já venceu
	if n, err := w.store.LimparPausasVencidas(ctx); err != nil {
		if ctx.Err() == nil {
			log.Printf("[reaper] erro ao limpar pausas vencidas: %v", err)
		}
	} else if n > 0 {
		log.Printf("[reaper] %d canal(is) saíram da pausa", n)
	}
}

// limiarRenovacao: de quanto em quanto tempo re-carimbar a posse do lote.
// Precisa ser confortavelmente menor que StuckAfterSecs para que o reaper
// nunca alcance uma mensagem que este worker ainda vai enviar.
func (w *Worker) limiarRenovacao() time.Duration {
	d := time.Duration(w.cfg.StuckAfterSecs) * time.Second / 3
	if d < 10*time.Second {
		d = 10 * time.Second
	}
	return d
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
			if ctx.Err() != nil {
				return
			}
			log.Printf("[%s] erro ao reservar lote: %v", workerID, err)
			time.Sleep(w.cfg.PollInterval)
			continue
		}
		if len(msgs) == 0 {
			time.Sleep(w.cfg.PollInterval) // fila vazia → espera
			continue
		}

		w.processarLote(ctx, workerID, msgs)
	}
}

func (w *Worker) processarLote(ctx context.Context, workerID string, msgs []store.Message) {
	// canais que pausaram no meio deste lote: as mensagens restantes deles já
	// foram devolvidas à fila, então não devem ser processadas aqui.
	pausados := make(map[string]bool)
	// mensagens que deixaram de ser nossas (reaper + outro worker): enviá-las
	// seria entrega duplicada.
	perdidas := make(map[string]bool)

	renovarApos := time.Now().Add(w.limiarRenovacao())

	for i, m := range msgs {
		if ctx.Err() != nil {
			w.devolver(workerID, msgs[i:], "desligamento")
			return
		}
		if pausados[m.ChannelID] || perdidas[m.ID] {
			continue
		}

		// Lote lento: renova a posse do que falta antes que o reaper o recolha.
		if time.Now().After(renovarApos) {
			w.renovarPosse(ctx, workerID, msgs[i:], perdidas)
			renovarApos = time.Now().Add(w.limiarRenovacao())
			if perdidas[m.ID] {
				continue
			}
		}

		switch w.process(ctx, workerID, m) {
		case resInterrompido:
			// inclui a mensagem atual: ela foi reservada mas não enviada
			w.devolver(workerID, msgs[i:], "desligamento")
			return
		case resCanalPausado:
			pausados[m.ChannelID] = true
			w.devolver(workerID, restantesDoCanal(msgs[i+1:], m.ChannelID), "canal pausado")
		}
	}
}

// renovarPosse re-carimba o lote restante e marca em `perdidas` o que já não é
// nosso. Em caso de erro, prefere não enviar nada do lote a arriscar duplicata.
func (w *Worker) renovarPosse(ctx context.Context, workerID string, restantes []store.Message, perdidas map[string]bool) {
	ids := make([]string, 0, len(restantes))
	for _, m := range restantes {
		if !perdidas[m.ID] {
			ids = append(ids, m.ID)
		}
	}

	vivas, err := w.store.RenovarPosse(ctx, workerID, ids)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("[%s] falha ao renovar posse do lote: %v — devolvendo o restante em vez de arriscar envio duplicado", workerID, err)
		}
		// Sem saber de quem é cada linha, não dá para enviar. Mas abandoná-las
		// em 'sending' as deixaria paradas até o reaper (até 5 min) e ainda
		// consumindo uma tentativa; devolver é imediato e refaz o attempts.
		for _, id := range ids {
			perdidas[id] = true
		}
		w.devolver(workerID, restantes, "falha ao renovar posse")
		return
	}

	var roubadas int
	for _, id := range ids {
		if !vivas[id] {
			perdidas[id] = true
			roubadas++
		}
	}
	if roubadas > 0 {
		log.Printf("[%s] %d mensagem(ns) do lote já haviam sido devolvidas à fila e reatribuídas — não serão reenviadas", workerID, roubadas)
	}
}

// restantesDoCanal filtra as mensagens do lote que ainda não foram tocadas e
// pertencem ao canal que acabou de ser pausado.
func restantesDoCanal(msgs []store.Message, channelID string) []store.Message {
	var out []store.Message
	for _, m := range msgs {
		if m.ChannelID == channelID {
			out = append(out, m)
		}
	}
	return out
}

// ctxPersistencia devolve um contexto que sobrevive ao cancelamento do worker.
// As transições finais (enviada/falhou/reagendada) PRECISAM ser gravadas mesmo
// durante o SIGTERM: se a Meta aceitou a mensagem e o UPDATE não acontece, a
// linha fica em 'sending', o reaper a devolve e o cliente recebe duplicada.
func (w *Worker) ctxPersistencia() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), w.cfg.ShutdownGrace)
}

// devolver põe de volta na fila mensagens reservadas que não chegaram a ser
// enviadas. Usa contexto próprio porque o caso mais importante é justamente o
// do ctx já cancelado (SIGTERM do deploy).
func (w *Worker) devolver(workerID string, msgs []store.Message, motivo string) {
	if len(msgs) == 0 {
		return
	}
	ids := make([]string, 0, len(msgs))
	for _, m := range msgs {
		ids = append(ids, m.ID)
	}

	ctx, cancel := w.ctxPersistencia()
	defer cancel()

	n, err := w.store.ReleaseBatch(ctx, workerID, ids)
	if err != nil {
		log.Printf("[fila] FALHA ao devolver %d mensagem(ns) (%s): %v — o reaper recupera em até %ds",
			len(ids), motivo, err, w.cfg.StuckAfterSecs)
		return
	}
	if n > 0 {
		log.Printf("[fila] %d mensagem(ns) devolvida(s) à fila (%s)", n, motivo)
	}
}

func (w *Worker) process(ctx context.Context, workerID string, m store.Message) resultado {
	ch, err := w.channel(ctx, m.ChannelID)
	if err != nil {
		if ctx.Err() != nil {
			return resInterrompido
		}
		return w.tratarErroDeCanal(workerID, m, err)
	}

	token := w.resolveToken(ch, m.ChannelID)
	if token == "" {
		w.marcarFalha(workerID, m, "no_token", "canal sem access token (configure no banco ou WHATSAPP_ACCESS_TOKEN)")
		return resSeguir
	}

	// respeita o throughput permitido para o canal
	if err := w.limiters.For(m.ChannelID, ch.RatePerSec).Wait(ctx); err != nil {
		return resInterrompido // ctx cancelado
	}

	// Último ponto em que devolver a mensagem é COMPROVADAMENTE seguro: nada
	// foi para a rede ainda.
	if ctx.Err() != nil {
		return resInterrompido
	}

	// O envio NÃO usa o ctx cancelável do worker, e isso é deliberado.
	//
	// Se o SIGTERM abortasse um POST já escrito no socket, a Meta teria
	// aceitado e enfileirado a mensagem do lado dela — cancelar pelo cliente
	// não desfaz nada. Nós veríamos "erro de rede", devolveríamos a mensagem à
	// fila e a réplica nova enviaria de novo: o destinatário recebe DUAS vezes
	// e a Meta cobra duas vezes. Deixar o envio terminar e gravar o desfecho
	// (o pctx abaixo sobrevive ao cancelamento) custa no máximo o timeout HTTP
	// no shutdown e elimina a duplicata.
	sctx, cancelSend := context.WithTimeout(context.WithoutCancel(ctx), tempoLimiteEnvio)
	res := w.wa.Send(sctx, ch.PhoneNumberID, token, m.Payload)
	cancelSend()

	pctx, cancel := w.ctxPersistencia()
	defer cancel()

	switch {
	case res.Class == whatsapp.ClassOK:
		if err := w.store.MarkSent(pctx, m.ID, workerID, res.WAMessageID); err != nil {
			// A Meta ACEITOU mas não conseguimos gravar. É o único rastro de
			// uma possível duplicata, então precisa aparecer no log — e a
			// perda de posse é o caso mais preocupante dos dois.
			if errors.Is(err, store.ErrPosseperdida) {
				log.Printf("[msg %s] ATENÇÃO: aceita pela Meta (wamid=%q) mas a linha já pertencia a outro worker — POSSÍVEL ENTREGA DUPLICADA para %s",
					m.ID, res.WAMessageID, m.ToPhone)
			} else {
				log.Printf("[msg %s] ACEITA pela Meta (wamid=%q) mas falhou ao gravar 'sent': %v",
					m.ID, res.WAMessageID, err)
			}
		}
		return resSeguir

	case res.BlocksChannel():
		// O erro é do canal, não da mensagem: limite de vazão estourado,
		// credencial inválida ou cartão recusado na Meta. Pausar impede o pior
		// cenário — 5.000 envios batendo na Meta em minutos, todos falhando,
		// todos virando falha definitiva e ainda piorando o limite e a
		// qualidade do número.
		return w.pausarCanal(pctx, workerID, m, res)

	case res.Class == whatsapp.ClassTransient && m.Attempts < m.MaxAttempts:
		// posse perdida aqui é benigno: outro worker é dono e vai reagendar
		if err := w.store.Reschedule(pctx, m.ID, workerID, res.ErrCode, res.ErrDetail, backoffSecs(m.Attempts)); err != nil &&
			!errors.Is(err, store.ErrPosseperdida) {
			log.Printf("[msg %s] falha ao reagendar: %v", m.ID, err)
		}
		return resSeguir

	default:
		// permanente, ou transitório com tentativas esgotadas
		w.marcarFalha(workerID, m, res.ErrCode, res.ErrDetail)
		return resSeguir
	}
}

// tratarErroDeCanal separa "esse canal não existe" (culpa da mensagem) de "não
// consegui ler o canal agora" (culpa da infra). Antes, qualquer erro virava
// falha DEFINITIVA — um blip do Postgres queimava a mensagem sem volta, já que
// status 'failed' sai do alcance tanto da reserva quanto do reaper.
func (w *Worker) tratarErroDeCanal(workerID string, m store.Message, err error) resultado {
	if errors.Is(err, store.ErrChannelNotFound) {
		w.marcarFalha(workerID, m, "channel_not_found", err.Error())
		return resSeguir
	}

	pctx, cancel := w.ctxPersistencia()
	defer cancel()
	if e := w.store.Reschedule(pctx, m.ID, workerID, "channel_lookup", err.Error(), backoffSecs(m.Attempts)); e != nil {
		// se nem o reagendamento gravar, a linha fica em 'sending' e o reaper
		// a recupera — melhor do que perdê-la como falha definitiva
		log.Printf("[msg %s] falha ao reagendar após erro de leitura do canal: %v", m.ID, e)
	}
	return resSeguir
}

func (w *Worker) marcarFalha(workerID string, m store.Message, code, detail string) {
	pctx, cancel := w.ctxPersistencia()
	defer cancel()
	// posse perdida aqui é benigno: quem é dono da linha grava o desfecho
	if err := w.store.MarkFailed(pctx, m.ID, workerID, code, detail); err != nil &&
		!errors.Is(err, store.ErrPosseperdida) {
		log.Printf("[msg %s] falha ao gravar 'failed' (%s): %v", m.ID, code, err)
	}
}

// pausarCanal tira o canal da fila por um tempo e devolve a mensagem atual.
// A mensagem NÃO gasta tentativa aqui — não foi ela que deu problema.
func (w *Worker) pausarCanal(ctx context.Context, workerID string, m store.Message, res whatsapp.SendResult) resultado {
	segundos := w.cfg.PauseRateLimitSecs
	alerta := "" // limite de vazão se resolve sozinho: não vira alerta no painel

	if res.Class == whatsapp.ClassAuth {
		segundos = w.cfg.PauseAuthSecs
		alerta = alertaLegivel(res)
		// credencial pode ter sido corrigida no banco: descarta o cache para
		// que a próxima tentativa já pegue o token novo.
		w.invalidarCanal(m.ChannelID)
	}

	motivo := fmt.Sprintf("%s:%s", res.Class, res.ErrCode)
	if err := w.store.PauseChannel(ctx, m.ChannelID, segundos, motivo, alerta); err != nil {
		log.Printf("[canal %s] falha ao registrar pausa: %v", m.ChannelID, err)
	}

	// devolve a mensagem para depois da pausa, sem consumir a tentativa
	if _, err := w.store.ReleaseBatch(ctx, workerID, []string{m.ID}); err != nil {
		log.Printf("[canal %s] falha ao devolver a mensagem %s: %v", m.ChannelID, m.ID, err)
	}

	log.Printf("[canal %s] PAUSADO por %ds — %s: %s", m.ChannelID, segundos, motivo, res.ErrDetail)
	return resCanalPausado
}

// alertaLegivel traduz o erro da Meta para uma frase que o cliente entende no
// painel (os campos alert_* da migração 009 já são exibidos lá).
func alertaLegivel(res whatsapp.SendResult) string {
	switch {
	case strings.Contains(res.ErrCode, "131042"):
		return "Envios pausados: a Meta recusou a forma de pagamento desta conta. Regularize o cartão no Gerenciador de Negócios."
	case strings.Contains(res.ErrCode, "190"), strings.Contains(res.ErrCode, "200"), strings.Contains(res.ErrCode, "_10"):
		return "Envios pausados: a credencial deste número expirou ou perdeu permissão. Reconecte o canal."
	case strings.Contains(res.ErrCode, "131031"), strings.Contains(res.ErrCode, "368"):
		return "Envios pausados: a Meta restringiu esta conta. Verifique a qualidade e as políticas no Gerenciador de Negócios."
	case strings.Contains(res.ErrCode, "130497"):
		return "Envios pausados: esta conta não tem permissão da Meta para enviar ao país do destinatário."
	default:
		return "Envios pausados por um problema na conta da Meta: " + res.ErrDetail
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

// channel devolve o canal do cache (validade curta) ou do banco. Se o banco
// falhar mas houver uma cópia vencida em memória, usa a vencida: um blip do
// Postgres não deve interromper o envio de um canal que já conhecemos.
func (w *Worker) channel(ctx context.Context, id string) (store.Channel, error) {
	w.chMu.Lock()
	emCache, temCache := w.chche[id]
	w.chMu.Unlock()

	if temCache && time.Now().Before(emCache.valeI) {
		return emCache.canal, nil
	}

	c, err := w.store.GetChannel(ctx, id)
	if err != nil {
		if temCache && !errors.Is(err, store.ErrChannelNotFound) {
			return emCache.canal, nil // cópia vencida > nenhuma
		}
		return store.Channel{}, err
	}

	w.chMu.Lock()
	w.chche[id] = canalCache{canal: c, valeI: time.Now().Add(w.cfg.ChannelCacheTTL)}
	w.chMu.Unlock()
	return c, nil
}

// invalidarCanal força a próxima leitura a ir ao banco (usado quando a
// credencial em cache pode ter sido trocada pelo operador).
func (w *Worker) invalidarCanal(id string) {
	w.chMu.Lock()
	delete(w.chche, id)
	w.chMu.Unlock()

	w.decFailMu.Lock()
	delete(w.decFailLogged, id)
	w.decFailMu.Unlock()
}

// backoffSecs devolve o intervalo até a próxima tentativa, em segundos.
//
// O backoff antigo (2,4,8,16s) esgotava as 5 tentativas em 30 segundos — meio
// minuto de instabilidade da Meta bastava para marcar tudo como falha
// definitiva. Agora cresce de verdade: 30s → 2min → 8min → 30min (teto),
// cobrindo cerca de 40 minutos de indisponibilidade.
//
// O jitter de ±20% é essencial em massa: sem ele, milhares de mensagens que
// falharam no mesmo segundo voltariam todas no mesmo segundo, recriando o pico
// que causou a falha.
func backoffSecs(attempts int) int {
	base := 30 * math.Pow(4, float64(attempts-1))
	if base > 1800 {
		base = 1800
	}
	if base < 30 {
		base = 30
	}
	jitter := 0.8 + 0.4*mrand.Float64() // 0,8x .. 1,2x
	return int(base * jitter)
}

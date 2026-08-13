package whatsapp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Client struct {
	http         *http.Client
	graphVersion string
}

func NewClient(graphVersion string) *Client {
	return &Client{
		http:         &http.Client{Timeout: 20 * time.Second},
		graphVersion: graphVersion,
	}
}

// Class diz o que fazer com o resultado do envio. A distinção importa porque
// a Meta devolve coisas MUITO diferentes com o mesmo HTTP 400: "esse template
// não existe" (culpa da mensagem, não adianta repetir) e "você estourou o
// limite de vazão" (culpa do momento, repetir mais tarde funciona).
type Class string

const (
	ClassOK        Class = ""          // aceito pela Meta
	ClassPermanent Class = "permanent" // problema da própria mensagem → falha definitiva
	ClassTransient Class = "transient" // instabilidade → repete com backoff
	ClassRateLimit Class = "ratelimit" // cota/vazão do canal → pausa o canal e repete
	ClassAuth      Class = "auth"      // credencial ou conta do canal → pausa e exige operador
)

// Códigos de limite de vazão/cota. A Meta manda como HTTP 400 com o código no
// corpo — por isso olhar só o status HTTP (429) deixava passar quase todos.
// Um cliente novo (limite de 250/dia) que sobe 5.000 contatos bate aqui.
var codesRateLimit = map[int]bool{
	4:      true, // Application request limit reached
	80007:  true, // Rate limit issues (nível da WABA)
	130429: true, // Cloud API message throughput reached
	131048: true, // Spam rate limit hit (limite de qualidade/vazão do número)
}

// Limite do PAR (negócio, destinatário): esse contato específico já recebeu
// mensagens demais nas últimas horas. É problema DA MENSAGEM, não do canal —
// pausar o canal inteiro por causa de um contato congelaria a fila do cliente
// por 15 minutos por conta de um único número que aparece em duas listas.
var codesDestinatario = map[int]bool{
	131056: true, // (Business, Recipient) pair rate limit hit
}

// Credencial ou ESTADO DA CONTA: repetir não resolve, mas a fila NÃO pode ser
// queimada — o operador corrige (troca o token, regulariza o cartão) e as
// mensagens seguem. Por isso pausamos o canal em vez de marcar tudo como falha.
//
// 131042 é o caso mais comum na prática: cartão recusado ou não vinculado à
// WABA faz a Meta recusar TODO envio daquele canal com HTTP 400. Sem estar
// nesta lista, ele cairia em "permanente" e queimaria a fila inteira do
// cliente — exatamente o bug que esta correção existe para eliminar.
var codesAuth = map[int]bool{
	190:    true, // token expirado ou inválido
	200:    true, // permissão faltando
	10:     true, // permissão negada
	131031: true, // conta comercial bloqueada/restrita
	368:    true, // bloqueada temporariamente por violação de política
	131042: true, // problema com a forma de pagamento — bloqueia TODO envio da conta
	130497: true, // WABA restrita para enviar ao país do destinatário
	131045: true, // erro de registro do número (certificado/PIN)
	133010: true, // número não registrado na plataforma
}

// Erro do lado da Meta, sem culpa da mensagem.
var codesTransient = map[int]bool{
	1:      true, // API Unknown — erro interno temporário
	2:      true, // API Service — serviço temporariamente indisponível
	131000: true, // "Something went wrong" — genérico interno da Meta
	131053: true, // falha ao subir mídia
}

// classify decide o destino da mensagem. O código do corpo tem prioridade
// sobre o status HTTP, porque é ele que carrega a informação real.
func classify(status, code int) Class {
	switch {
	case codesRateLimit[code]:
		return ClassRateLimit
	case codesAuth[code]:
		return ClassAuth
	case codesDestinatario[code], codesTransient[code]:
		// retenta com backoff e CONSOME tentativa, sem pausar o canal
		return ClassTransient
	case status == http.StatusTooManyRequests:
		return ClassRateLimit
	case status >= 500:
		return ClassTransient
	case status == http.StatusRequestTimeout:
		return ClassTransient
	default:
		// 4xx sem código conhecido é quase sempre problema da mensagem
		// (template inexistente, parâmetro inválido, número que não recebe).
		// Repetir só gastaria cota; falha definitiva é o certo aqui.
		return ClassPermanent
	}
}

// SendResult resume a resposta da Meta.
type SendResult struct {
	WAMessageID string
	Class       Class
	ErrCode     string
	ErrDetail   string
}

// Retryable diz se a mensagem deve voltar para a fila (em qualquer ritmo).
func (r SendResult) Retryable() bool {
	return r.Class == ClassTransient || r.Class == ClassRateLimit || r.Class == ClassAuth
}

// BlocksChannel diz se o erro é do canal (e não da mensagem) — nesse caso o
// worker pausa o canal para não marretar a Meta com envios que já sabemos que
// vão falhar, o que pioraria o limite e mancharia a qualidade do número.
func (r SendResult) BlocksChannel() bool {
	return r.Class == ClassRateLimit || r.Class == ClassAuth
}

type metaSuccess struct {
	Messages []struct {
		ID string `json:"id"`
	} `json:"messages"`
}

type metaError struct {
	Error struct {
		Message   string `json:"message"`
		Type      string `json:"type"`
		Code      int    `json:"code"`
		Subcode   int    `json:"error_subcode"`
		FBTraceID string `json:"fbtrace_id"`
	} `json:"error"`
}

// Send faz POST /{phone_number_id}/messages na Graph API.
// payload já é o objeto pronto ({messaging_product, to, type, template/text...}).
func (c *Client) Send(ctx context.Context, phoneNumberID, token string, payload []byte) SendResult {
	url := fmt.Sprintf("https://graph.facebook.com/%s/%s/messages", c.graphVersion, phoneNumberID)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return SendResult{Class: ClassPermanent, ErrCode: "build_request", ErrDetail: err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		// erro de rede (inclui timeout) → retentável
		return SendResult{Class: ClassTransient, ErrCode: "network", ErrDetail: err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		var ok metaSuccess
		if err := json.Unmarshal(body, &ok); err == nil && len(ok.Messages) > 0 {
			return SendResult{Class: ClassOK, WAMessageID: ok.Messages[0].ID}
		}
		return SendResult{Class: ClassOK} // aceito, sem id (raro)
	}

	var me metaError
	_ = json.Unmarshal(body, &me)
	return SendResult{
		Class:     classify(resp.StatusCode, me.Error.Code),
		ErrCode:   fmt.Sprintf("http_%d_code_%d", resp.StatusCode, me.Error.Code),
		ErrDetail: me.Error.Message,
	}
}

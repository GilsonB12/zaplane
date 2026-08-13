package whatsapp

import "testing"

// A regra que este teste protege: a Meta manda limite de vazão como HTTP 400
// com o código no CORPO. Olhar só o status (429/5xx), como era antes, fazia
// 4.750 das 5.000 mensagens de um cliente novo virarem falha definitiva em
// minutos. Se alguém voltar a classificar por status, quebra aqui.
func TestClassify(t *testing.T) {
	casos := []struct {
		nome     string
		status   int
		code     int
		esperado Class
	}{
		// limite de vazão chegando como 400 — o caso do bug
		{"spam rate limit em 400", 400, 131048, ClassRateLimit},
		{"throughput da cloud api em 400", 400, 130429, ClassRateLimit},
		{"limite da aplicação em 400", 400, 4, ClassRateLimit},
		{"rate limit da waba em 400", 400, 80007, ClassRateLimit},
		{"429 sem código conhecido", 429, 0, ClassRateLimit},

		// limite do PAR (negócio, destinatário): é da mensagem, não do canal.
		// Se voltar a ser ClassRateLimit, um único contato repetido congela a
		// fila do cliente inteiro por 15 minutos.
		{"par negócio/destinatário NÃO pausa o canal", 400, 131056, ClassTransient},

		// credencial/conta: não pode queimar a fila
		{"token expirado", 400, 190, ClassAuth},
		{"permissão faltando", 403, 200, ClassAuth},
		{"permissão negada", 403, 10, ClassAuth},
		{"conta bloqueada", 400, 131031, ClassAuth},
		{"bloqueio por política", 400, 368, ClassAuth},
		// o caso mais comum na prática: cartão recusado bloqueia TODO envio.
		// Se cair em permanente, queima a fila inteira do cliente.
		{"problema no pagamento da conta", 400, 131042, ClassAuth},
		{"país restrito para a waba", 400, 130497, ClassAuth},
		{"erro de registro do número", 400, 131045, ClassAuth},
		{"número não registrado", 400, 133010, ClassAuth},

		// instabilidade do lado da Meta
		{"erro interno genérico", 400, 131000, ClassTransient},
		{"api unknown", 500, 1, ClassTransient},
		{"api service", 400, 2, ClassTransient},
		{"5xx sem código", 503, 0, ClassTransient},
		{"timeout http", 408, 0, ClassTransient},

		// problema da própria mensagem: repetir só gastaria cota
		{"janela de 24h fechada", 400, 131047, ClassPermanent},
		{"número não recebe", 400, 131026, ClassPermanent},
		{"template inexistente", 400, 132001, ClassPermanent},
		{"parâmetro inválido", 400, 100, ClassPermanent},
		{"4xx desconhecido", 400, 999999, ClassPermanent},
	}

	for _, c := range casos {
		t.Run(c.nome, func(t *testing.T) {
			if got := classify(c.status, c.code); got != c.esperado {
				t.Errorf("classify(%d, %d) = %q; esperado %q", c.status, c.code, got, c.esperado)
			}
		})
	}
}

// Garante a coerência entre a classe e o que o worker faz com ela.
func TestSendResultDecisoes(t *testing.T) {
	casos := []struct {
		classe        Class
		retentavel    bool
		bloqueiaCanal bool
	}{
		{ClassOK, false, false},
		{ClassPermanent, false, false},
		{ClassTransient, true, false},
		{ClassRateLimit, true, true},
		{ClassAuth, true, true},
	}

	for _, c := range casos {
		r := SendResult{Class: c.classe}
		if r.Retryable() != c.retentavel {
			t.Errorf("%q: Retryable() = %v; esperado %v", c.classe, r.Retryable(), c.retentavel)
		}
		if r.BlocksChannel() != c.bloqueiaCanal {
			t.Errorf("%q: BlocksChannel() = %v; esperado %v", c.classe, r.BlocksChannel(), c.bloqueiaCanal)
		}
	}
}

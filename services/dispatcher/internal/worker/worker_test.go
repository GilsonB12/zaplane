package worker

import (
	"testing"

	"github.com/zaplane/dispatcher/internal/store"
)

// O backoff antigo (2,4,8,16s) esgotava as 5 tentativas em 30 segundos: meio
// minuto de instabilidade da Meta bastava para marcar tudo como falha
// definitiva. Este teste fixa a nova escala e, principalmente, garante que a
// soma cubra dezenas de minutos.
func TestBackoffSecs(t *testing.T) {
	faixas := []struct {
		attempts int
		min, max int // com jitter de ±20%
	}{
		{1, 24, 36},     // ~30s
		{2, 96, 144},    // ~2min
		{3, 384, 576},   // ~8min
		{4, 1440, 2160}, // ~30min (teto)
		{5, 1440, 2160}, // teto
	}

	for _, f := range faixas {
		// roda várias vezes: o jitter é aleatório e precisa ficar na faixa sempre
		for i := 0; i < 200; i++ {
			got := backoffSecs(f.attempts)
			if got < f.min || got > f.max {
				t.Fatalf("backoffSecs(%d) = %d; esperado entre %d e %d", f.attempts, got, f.min, f.max)
			}
		}
	}

	// nunca pode devolver algo que faça a mensagem voltar imediatamente
	for _, attempts := range []int{-5, 0, 1, 99} {
		if got := backoffSecs(attempts); got < 20 {
			t.Errorf("backoffSecs(%d) = %d; nunca pode ser quase zero", attempts, got)
		}
	}
}

// O jitter existe para que milhares de mensagens que falharam no mesmo segundo
// não voltem todas no mesmo segundo, recriando o pico que causou a falha.
// Se alguém remover o jitter, este teste quebra.
func TestBackoffTemJitter(t *testing.T) {
	vistos := make(map[int]bool)
	for i := 0; i < 100; i++ {
		vistos[backoffSecs(3)] = true
	}
	if len(vistos) < 5 {
		t.Errorf("backoffSecs(3) devolveu só %d valor(es) distinto(s) em 100 chamadas — jitter sumiu", len(vistos))
	}
}

func TestRestantesDoCanal(t *testing.T) {
	msgs := []store.Message{
		{ID: "a", ChannelID: "canal-1"},
		{ID: "b", ChannelID: "canal-2"},
		{ID: "c", ChannelID: "canal-1"},
		{ID: "d", ChannelID: "canal-3"},
	}

	got := restantesDoCanal(msgs, "canal-1")
	if len(got) != 2 || got[0].ID != "a" || got[1].ID != "c" {
		t.Fatalf("esperava as mensagens a e c do canal-1; veio %+v", got)
	}

	// canal sem mensagens restantes não pode devolver lixo
	if got := restantesDoCanal(msgs, "canal-inexistente"); len(got) != 0 {
		t.Errorf("esperava vazio; veio %+v", got)
	}
	if got := restantesDoCanal(nil, "canal-1"); len(got) != 0 {
		t.Errorf("esperava vazio para lote nil; veio %+v", got)
	}
}

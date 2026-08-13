package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	DatabaseURL       string
	GraphVersion      string
	FallbackToken     string
	EncryptionKey     string
	Concurrency       int
	BatchSize         int
	PollInterval      time.Duration
	DefaultRatePerSec int

	// Resiliência da fila ----------------------------------------------------
	// ReaperInterval: de quanto em quanto tempo procurar mensagens presas.
	ReaperInterval time.Duration
	// StuckAfterSecs: tempo em 'sending' a partir do qual a mensagem é dada
	// como órfã. Precisa ser maior que o pior caso legítimo de um envio
	// (espera do rate limiter + timeout HTTP de 20s), com folga.
	StuckAfterSecs int
	// PauseRateLimitSecs: quanto o canal fica fora da fila após a Meta acusar
	// limite de vazão/cota. Curto — o limite costuma liberar sozinho.
	PauseRateLimitSecs int
	// PauseAuthSecs: idem para credencial/conta inválida. Mais longo, porque
	// só volta a funcionar com ação do operador (trocar o token, por exemplo).
	PauseAuthSecs int
	// ChannelCacheTTL: validade do cache de canal em memória. Sem TTL, um token
	// corrigido no banco nunca chegava ao worker — ele seguia usando o antigo
	// para sempre, e a fila nunca se recuperava.
	ChannelCacheTTL time.Duration
	// ShutdownGrace: janela para gravar o desfecho e devolver à fila o lote
	// ainda não enviado quando chega SIGTERM (deploy). Precisa ser MAIOR que o
	// timeout do envio (25s): durante o shutdown ainda pode haver um POST em
	// voo cujo resultado precisa ser gravado, senão a mensagem volta para a
	// fila e é entregue duas vezes.
	ShutdownGrace time.Duration
}

func Load() Config {
	return Config{
		DatabaseURL:       env("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/zaplane"),
		GraphVersion:      env("WHATSAPP_GRAPH_API_VERSION", "v21.0"),
		FallbackToken:     env("WHATSAPP_ACCESS_TOKEN", ""),
		EncryptionKey:     env("APP_ENCRYPTION_KEY", ""),
		Concurrency:       envInt("WORKER_CONCURRENCY", 4),
		BatchSize:         envInt("BATCH_SIZE", 50),
		PollInterval:      time.Duration(envInt("POLL_INTERVAL_MS", 750)) * time.Millisecond,
		DefaultRatePerSec: envInt("DEFAULT_RATE_PER_SEC", 20),

		ReaperInterval:     time.Duration(envInt("REAPER_INTERVAL_SEC", 60)) * time.Second,
		StuckAfterSecs:     envInt("STUCK_AFTER_SEC", 300),
		PauseRateLimitSecs: envInt("PAUSE_RATE_LIMIT_SEC", 900),
		PauseAuthSecs:      envInt("PAUSE_AUTH_SEC", 1800),
		ChannelCacheTTL:    time.Duration(envInt("CHANNEL_CACHE_TTL_SEC", 60)) * time.Second,
		ShutdownGrace:      time.Duration(envInt("SHUTDOWN_GRACE_SEC", 30)) * time.Second,
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

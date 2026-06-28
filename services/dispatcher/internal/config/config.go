package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	DatabaseURL      string
	GraphVersion     string
	FallbackToken    string
	Concurrency      int
	BatchSize        int
	PollInterval     time.Duration
	DefaultRatePerSec int
}

func Load() Config {
	return Config{
		DatabaseURL:       env("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/zaplane"),
		GraphVersion:      env("WHATSAPP_GRAPH_API_VERSION", "v21.0"),
		FallbackToken:     env("WHATSAPP_ACCESS_TOKEN", ""),
		Concurrency:       envInt("WORKER_CONCURRENCY", 4),
		BatchSize:         envInt("BATCH_SIZE", 50),
		PollInterval:      time.Duration(envInt("POLL_INTERVAL_MS", 750)) * time.Millisecond,
		DefaultRatePerSec: envInt("DEFAULT_RATE_PER_SEC", 20),
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

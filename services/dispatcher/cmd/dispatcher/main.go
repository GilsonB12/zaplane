package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/joho/godotenv"

	"github.com/zaplane/dispatcher/internal/config"
	"github.com/zaplane/dispatcher/internal/store"
	"github.com/zaplane/dispatcher/internal/whatsapp"
	"github.com/zaplane/dispatcher/internal/worker"
)

func main() {
	_ = godotenv.Load()
	cfg := config.Load()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	st, err := store.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("falha ao conectar no banco: %v", err)
	}
	defer st.Close()

	wa := whatsapp.NewClient(cfg.GraphVersion)
	w := worker.New(cfg, st, wa)

	// shutdown gracioso
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		log.Println("encerrando dispatcher...")
		cancel()
	}()

	log.Printf("[zaplane] dispatcher iniciado (concorrência=%d, lote=%d)", cfg.Concurrency, cfg.BatchSize)
	w.Run(ctx)
	log.Println("dispatcher finalizado.")
}

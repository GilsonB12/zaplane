package ratelimit

import (
	"sync"

	"golang.org/x/time/rate"
)

// Registry mantém um limiter (token bucket) por canal, respeitando o
// throughput permitido pela Meta para cada número.
type Registry struct {
	mu         sync.Mutex
	limiters   map[string]*rate.Limiter
	defaultRPS int
}

func NewRegistry(defaultRPS int) *Registry {
	return &Registry{limiters: make(map[string]*rate.Limiter), defaultRPS: defaultRPS}
}

func (r *Registry) For(channelID string, rps int) *rate.Limiter {
	r.mu.Lock()
	defer r.mu.Unlock()
	if l, ok := r.limiters[channelID]; ok {
		return l
	}
	if rps <= 0 {
		rps = r.defaultRPS
	}
	l := rate.NewLimiter(rate.Limit(rps), rps) // burst = rps
	r.limiters[channelID] = l
	return l
}

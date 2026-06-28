# Roadmap — Zaplane

## Fase 0 — Scaffold (este entregável) ✅
Estrutura de microsserviços, schema com LGPD, endpoints principais esboçados, worker de
disparo e importador funcionando como esqueleto. Roda local, sem Docker.

## Fase 1 — MVP funcional ponta a ponta
- [ ] Auth completo (registro/login/refresh) + seed de organização.
- [ ] Import real CSV/JSON/XLSX → contatos no banco com consentimento.
- [ ] Criação de campanha → enfileiramento → Dispatcher envia via Meta (sandbox).
- [ ] Webhook de status atualizando entregas; opt-out funcionando.
- [ ] Tela única (do design do Claude) ligada ao gateway.

## Fase 2 — Produto
- [ ] Segmentos dinâmicos (DDD/região/tags), agendamento de campanha.
- [ ] Estimativa de custo por categoria/país antes do envio.
- [ ] Painel de progresso em tempo real (SSE/WebSocket).
- [ ] Gestão de templates sincronizada com a Meta.
- [ ] Billing (Stripe ou Asaas/Pagar.me) + planos e limites.

## Fase 3 — Escala & operação
- [ ] Docker + docker-compose; depois Kubernetes (quando você liberar).
- [ ] Trocar fila Postgres por Redis Streams/RabbitMQ se o volume exigir.
- [ ] Observabilidade (Prometheus/Grafana/OTel), alertas de quality rating.
- [ ] Multi-número/multi-WABA por tenant, balanceamento e aquecimento automático.
- [ ] CI/CD, testes de carga, pen-test, certificações.

## Fase 4 — Diferenciais
- [ ] Fluxos/automação (respostas, chatbots simples), mídia (imagem/PDF/áudio).
- [ ] Relatórios e analytics de engajamento.
- [ ] Inbox compartilhada para conversas dentro da janela de 24h.

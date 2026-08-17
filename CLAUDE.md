# CLAUDE.md — Contexto do projeto Zaplane

> Este arquivo é lido automaticamente pelo Claude Code no início de cada sessão.
> Ele resume **o que é o projeto, as decisões já tomadas, o estado atual e as regras**.
> Leia também os docs em `docs/` e o README de cada serviço antes de mudanças grandes.

## 1. O que é

**Zaplane** é uma plataforma web **multi-tenant (SaaS)** para **envio de mensagens em massa
pelo WhatsApp** usando a **API Oficial da Meta (WhatsApp Cloud API)**. O cliente faz
**upload de contatos** (CSV/JSON/XLSX), paga pelo uso e dispara mensagens com controle fino:
adicionar/remover números, enviar para um número específico, ou segmentar por **região/DDD**.
Tudo com **conformidade LGPD** embutida (consentimento, opt-out, supressão, auditoria).

Casos de uso que guiam o produto:
- **Petshop** (gerente fala com seus próprios clientes — base com relação prévia). ✅ defensável.
- **Consórcio** (vendedor quer 1.000+/dia). ⚠️ disparo frio em massa **viola a política da
  Meta e a LGPD** e derruba o número. O sistema **suprime** quem não tem base legal.

## 2. Estado atual (snapshot)

**Pronto e verificado (scaffold funcional):**
- `services/api-gateway` (NestJS/TS): auth JWT+Argon2+RBAC, contatos (CRUD + import + opt-out),
  listas, templates, campanhas (resolve público → suprime → enfileira), envio avulso,
  webhook da Meta (verificação de assinatura + opt-out), endpoints LGPD (export/delete).
- `services/dispatcher` (Go): worker que consome a fila (`SKIP LOCKED`), envia via Meta,
  rate-limit por canal, retries com backoff, atualização de status.
- `services/importer` (Python/FastAPI): parse CSV/JSON/XLSX, normalização E.164, DDD→UF,
  dedup. **Testado funcionalmente.**
- `db/migrations/001_init.sql`: schema Postgres multi-tenant com consentimento/opt-out/
  auditoria/fila. **Validado contra a gramática real do PostgreSQL.**
- `services/web` (Vite + React + Tailwind): painel (UI gerada no design do Claude). **Roda
  com dados mock**; camada de API pronta em `src/api/`. App compila ponta a ponta.

**Mock / stub / TODO (ainda não implementado de verdade):**
- Telas do painel usam **dados mock** — falta ligar mock→live (`src/api/endpoints.js` pronto).
- Faltam endpoints no gateway p/ o painel: **`GET /campaigns`** (listar), **`GET /channels`**,
  membros da equipe.
- `templates.sync` é stub (deve puxar `message_templates` da Meta).
- **Cifragem real de PII** (`phone_e164`/token do canal) é TODO — hoje há `phone_hash` (HMAC)
  e util AES-GCM, mas a coluna ainda é texto. Ver `docs/SECURITY-LGPD.md`.
- Cobrança/billing, agendamento de campanha, segmentos dinâmicos avançados: não feitos.

## 3. Decisões já tomadas — NÃO relitigar sem o usuário pedir

1. **Envio:** API **Oficial da Meta (Cloud API)**. **Nunca** usar automação não-oficial
   (Baileys/whatsapp-web.js) — viola ToS e bane o número.
2. **Linguagem-mãe:** **NestJS (Node/TypeScript)**. **Go** para o worker de disparo (caminho
   quente). **Python/FastAPI** para parsing/validação de contatos.
3. **Banco:** **PostgreSQL único**, que também é a **fila** via `SELECT ... FOR UPDATE SKIP
   LOCKED`. Sem Redis/RabbitMQ por enquanto.
4. **Infra agora:** **100% local, SEM Docker e SEM AWS.** Postgres/Node/Go/Python nativos.
   Só adicionar Docker/compose, CI/CD e nuvem **quando o usuário disser que está pronto**.
5. **AWS (futuro):** PostgreSQL gerenciado — **RDS** no início, **Aurora PostgreSQL
   I/O-Optimized** depois. **NÃO usar Aurora DSQL** (sem triggers/FKs/extensions/SKIP LOCKED).
   Em escala, mover só a fila p/ **SQS** atrás da interface `store` do Go. Ver `docs/AWS-DATABASE.md`.
6. **Versão do Graph API:** parametrizada por env (`WHATSAPP_GRAPH_API_VERSION`, default
   `v21.0`). Mantê-la configurável — a Meta lança versão nova a cada poucos meses.
7. **Pricing Meta:** por **mensagem de template entregue** (desde 01/07/2025), por categoria
   (Marketing/Utility/Authentication) e país. Mensagens de serviço (janela 24h) são grátis.

## 4. Arquitetura (resumo)

```
Navegador (services/web, :5173)
        │  /api → proxy
        ▼
API Gateway (NestJS, :3000) ── HTTP ──> Importer (Python, :8000)  [parse/valida contatos]
        │ enfileira (INSERT em outbound_messages)
        ▼
   PostgreSQL (:5432)  ── SKIP LOCKED ──>  Dispatcher (Go)  ── HTTPS ──> graph.facebook.com
        ▲                                                                      │ status/inbound
        └──────────────── webhook (status + opt-out) ◀───────────────────────┘
```

- **Por que poliglota:** NestJS p/ produtividade e webhooks; Go p/ concorrência barata no
  envio; Python pelo ecossistema de parsing (phonenumbers/pandas). Cada um onde rende mais.
- Contrato entre serviços = o **schema SQL** (`db/migrations/001_init.sql`). É a fonte de
  verdade. Prisma (gateway) e SQL cru (Go/Python) devem refletir esse schema.

## 5. Stack & versões

- Node 20+ / NestJS 10 / Prisma 5 / TypeScript 5.
- Go 1.22+ / pgx v5 / golang.org/x/time/rate.
- Python 3.10+ / FastAPI / phonenumbers / pandas / openpyxl.
- PostgreSQL 15+.
- Web: Vite 5 / React 18 / Tailwind 3 / lucide-react / recharts.

## 6. Estrutura do repositório

```
db/migrations/        001_init.sql (schema, fonte de verdade) + 002_seed_dev.sql
docs/                 ARCHITECTURE, SECURITY-LGPD, AWS-DATABASE, ROADMAP, CLAUDE-DESIGN-PROMPT
services/api-gateway/ NestJS (src/: auth, contacts, lists, templates, campaigns, messages,
                      webhooks, privacy, prisma, common, config) + prisma/schema.prisma
services/dispatcher/  Go (cmd/dispatcher, internal/: config, store, whatsapp, ratelimit, worker)
services/importer/    FastAPI (app/: main, parser, normalize, ddd)
services/web/         Vite+React (src/Zaplane.jsx + src/api/) — README próprio
scripts/              sample-contacts.csv / .json
```

## 7. Como rodar local (sem Docker)

Pré-requisitos via winget: PostgreSQL 15, Node LTS, Go, Python 3.12. Depois:

```bash
# Banco DO ZERO: aplica TODAS as migrações em ordem (001, 003, 004 … 014). Os
# arquivos são numerados com 3 dígitos, então a ordem do glob é a ordem certa e
# migração nova entra no laço sozinha. O 002 é PULADO: é seed, não schema. Em
# banco que já existe, aplique só os arquivos novos — a 001 não é idempotente.
createdb zaplane
for f in db/migrations/*.sql; do
  case "$f" in */002_seed_dev.sql) continue;; esac
  echo "== $f"; psql -d zaplane -v ON_ERROR_STOP=1 -f "$f" || break
done

# Dados de exemplo (opcional). Vai por ÚLTIMO: o seed grava colunas que só
# existem depois da 014. Não quer dado de exemplo? Basta não rodar esta linha.
psql -d zaplane -v ON_ERROR_STOP=1 -f db/migrations/002_seed_dev.sql

# API Gateway (:3000)
cd services/api-gateway && cp .env.example .env && npm install && npx prisma generate && npm run start:dev

# Importer (:8000)
cd services/importer && python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && uvicorn app.main:app --reload --port 8000

# Dispatcher
cd services/dispatcher && cp .env.example .env && go mod tidy && go run ./cmd/dispatcher

# Web (:5173)
cd services/web && npm install && npm run dev
```

Sem credenciais da Meta dá p/ usar tudo menos o **envio real** (registro/login, import,
campanhas, fila). O envio precisa de `WHATSAPP_ACCESS_TOKEN`/`PHONE_NUMBER_ID` (ou por canal
no banco). Ver `docs/ARCHITECTURE.md §5` para configurar a Meta.

## 8. Convenções e padrões

- **Multi-tenancy:** TODA tabela de domínio tem `organization_id`; todo acesso filtra por ele.
  O `organizationId` vem do JWT (`req.user`), nunca do body.
- **LGPD é first-class:** contatos têm `consent_status` + `opted_out`; campanhas de Marketing
  **só** disparam p/ `granted`; opt-out (palavras PARAR/SAIR/STOP...) suprime sempre. Registrar
  mudanças em `consent_events`. Ações sensíveis em `audit_logs`.
- **Segurança:** JWT (access+refresh) + RBAC (`owner/admin/operator/viewer`); senhas Argon2id;
  webhook valida `X-Hub-Signature-256` (corpo cru); telefone tem `phone_hash` (HMAC) p/ dedup.
- **Fila:** `outbound_messages` é a fila. Enfileirar = INSERT (status `queued`). O Go reserva
  com `FOR UPDATE SKIP LOCKED`. Não criar índices extras na fila (penaliza INSERT/UPDATE).
- **Prisma vs SQL cru:** o gateway usa Prisma para os modelos mapeados; tabelas sem model
  (list_contacts, consent_events, inbound_messages, audit_logs) são acessadas via `$queryRaw`/
  `$executeRaw`. Após mudar o SQL, rodar `npx prisma db pull` + `prisma generate`.
- **Idioma:** mensagens de usuário, comentários e docs em **português**.

## 9. Regras para o agente (guardrails)

- **Não introduzir Docker, AWS, Redis ou Kafka** sem o usuário pedir — o foco agora é local.
- **Manter schema ↔ Prisma ↔ Go em sincronia.** `db/migrations/*.sql` é a fonte de verdade.
- **Não hardcodar a versão do Graph API nem segredos.** Tudo via `.env` (que é gitignored).
- **Não adicionar o caminho não-oficial do WhatsApp.**
- **Preservar a conformidade:** qualquer fluxo novo de envio deve respeitar opt-out e base legal.
- Migrações são **aditivas** (novos arquivos `00X_*.sql`), não editar as já aplicadas.
- Validar antes de concluir: TS compila, Go `go vet`/build, Python importa, SQL aplica.

## 10. Próximos passos (backlog priorizado)

1. Ligar o painel (mock→live): login → contatos → import → campanhas/templates.
2. Adicionar endpoints faltantes no gateway: `GET /campaigns`, `GET /channels`, membros.
3. Implementar `templates.sync` (puxar da Meta) e estimativa de custo real por categoria/país.
4. Cifragem real de PII + rotação de chave; habilitar RLS no Postgres.
5. Agendamento de campanha, segmentos dinâmicos, progresso em tempo real (SSE).
6. Testes (unit/integração) e, só quando o usuário pedir: Docker, CI/CD, AWS.

## 11. Documentos de referência

- `docs/ARCHITECTURE.md` — arquitetura completa + contrato REST (§4) + setup Meta (§5).
- `docs/SECURITY-LGPD.md` — segurança e conformidade, checklist pré-produção.
- `docs/AWS-DATABASE.md` — banco/fila na AWS (decisão e tuning).
- `docs/ROADMAP.md` — fases. `docs/CLAUDE-DESIGN-PROMPT.md` — prompt do design.
- README de cada serviço em `services/*/README.md` e o `README.md` raiz.

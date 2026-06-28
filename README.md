# Zaplane — Plataforma de Envio de Mensagens em Massa via WhatsApp (Meta Cloud API)

Plataforma web multi-tenant (SaaS) que permite a empresas enviar mensagens em massa
pelo **WhatsApp**, usando a **API Oficial da Meta (WhatsApp Cloud API)**, com upload de
contatos por arquivo (CSV/JSON/XLSX), segmentação, controle de opt-out e conformidade
com a **LGPD**.

> **Nome de trabalho:** `Zaplane`. Troque livremente — não há acoplamento ao nome no código.

---

## Por que esse projeto existe

Pequenas e médias empresas (petshops, vendedores de consórcio, clínicas, lojas) querem
falar com **todos os seus clientes** pelo WhatsApp sem construir uma integração própria.
A plataforma resolve isso: o cliente **faz upload da lista de números**, paga pelo uso e
dispara mensagens — com controle fino (remover/adicionar números, enviar para um número
específico, ou só para uma região/DDD).

## Arquitetura em uma frase

Microsserviços com **NestJS (Node/TypeScript)** como serviço principal ("linguagem-mãe"),
**Go** para o worker de disparo de alta vazão e **Python (FastAPI)** para o importador/
validador de contatos. Banco **PostgreSQL** único, que também funciona como **fila de
trabalho** (padrão `SELECT ... FOR UPDATE SKIP LOCKED`) — sem Docker e sem Redis na fase
local.

```
                          ┌───────────────────────────┐
   Navegador (SPA)  ──────►   API Gateway (NestJS/TS)  │  :3000
                          │   auth, contatos, listas,  │
                          │   campanhas, webhooks,LGPD │
                          └─────┬───────────────┬──────┘
                                │ HTTP          │ enfileira (INSERT)
                  parse/validar │               ▼
                    ┌───────────▼──────┐   ┌─────────────────────┐
                    │ Importer (Python)│   │   PostgreSQL        │
                    │ CSV/JSON/XLSX,   │   │  (dados + fila)     │
                    │ E.164, dedup     │   └─────────┬───────────┘
                    └──────────────────┘             │ SKIP LOCKED (poll)
                                                      ▼
                                          ┌──────────────────────┐
                                          │  Dispatcher (Go)     │
                                          │  envia p/ Meta API,  │
                                          │  rate-limit, retries │
                                          └──────────┬───────────┘
                                                     │ HTTPS
                                                     ▼
                                         graph.facebook.com (Meta Cloud API)
                                                     │  status/inbound
                                                     ▼  (webhook) → API Gateway
```

Detalhes completos em [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## ⚠️ Antes de tudo: conformidade (leia)

Enviar mensagem em massa no WhatsApp **não é "spam liberado"**. A própria Meta e a LGPD
impõem regras. O projeto já nasce com os mecanismos de conformidade embutidos, mas a
**responsabilidade de uso correto é do cliente da plataforma**:

- **Consentimento (opt-in):** mensagens de marketing exigem base legal — idealmente
  consentimento. O caso do **petshop falando com seus próprios clientes** é defensável.
  O caso de **disparo frio para 1.000+ desconhecidos/dia** (consórcio) é de **alto risco**:
  fere a *WhatsApp Business Messaging Policy* e a LGPD, e leva a **banimento do número** e
  multas. A plataforma rastreia consentimento e suprime quem não tem base legal.
- **Opt-out:** toda mensagem de marketing deve permitir descadastro. O sistema detecta
  palavras como "PARAR/SAIR/STOP" no webhook e marca o contato como `opted_out`.
- **Templates aprovados:** para iniciar conversa (fora da janela de 24h), a Meta exige
  **templates pré-aprovados** por categoria (Marketing/Utility/Authentication).
- **Pricing:** desde **01/07/2025** a Meta cobra **por mensagem de template entregue**
  (não mais por conversa). Mensagens de serviço dentro da janela de 24h são gratuitas.

Veja [`docs/SECURITY-LGPD.md`](docs/SECURITY-LGPD.md) para o detalhamento.

---

## Serviços

| Serviço        | Pasta                     | Stack                | Porta | Papel |
|----------------|---------------------------|----------------------|-------|-------|
| API Gateway    | `services/api-gateway`    | NestJS + Prisma (TS) | 3000  | Núcleo: auth, CRUD, campanhas, webhook, LGPD |
| Dispatcher     | `services/dispatcher`     | Go                   | —     | Worker que consome a fila e envia via Meta |
| Importer       | `services/importer`       | FastAPI (Python)     | 8000  | Parse/validação/normalização de contatos |
| Web (painel)   | `services/web`            | Vite + React + Tailwind | 5173  | Painel do usuário (SPA) |
| Banco          | `db/migrations`           | PostgreSQL 15+       | 5432  | Persistência + fila de mensagens |

---

## Rodando localmente (sem Docker)

> Alvo desta fase: **tudo local, sem Docker**. Você instala Postgres, Node, Go e Python
> nativamente. Quando você disser que está pronto, adicionamos Docker/compose e CI/CD.

### 1. Pré-requisitos (Windows via winget)

```powershell
winget install PostgreSQL.PostgreSQL.15
winget install OpenJS.NodeJS.LTS          # Node 20+ (testado com 22)
winget install GoLang.Go                  # Go 1.22+
winget install Python.Python.3.12
```
(macOS: `brew install postgresql@15 node go python`. Linux: use o gerenciador da distro.)

### 2. Banco de dados

```bash
# cria o banco e aplica o schema
createdb zaplane
psql -d zaplane -f db/migrations/001_init.sql
psql -d zaplane -f db/migrations/002_seed_dev.sql   # dados de exemplo (opcional)
```

### 3. API Gateway (NestJS) — :3000

```bash
cd services/api-gateway
cp .env.example .env          # preencha DATABASE_URL e credenciais da Meta
npm install
npx prisma generate
npm run start:dev
```

### 4. Importer (Python) — :8000

```bash
cd services/importer
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### 5. Dispatcher (Go)

```bash
cd services/dispatcher
cp .env.example .env          # mesmas credenciais da Meta + DATABASE_URL
go mod tidy
go run ./cmd/dispatcher
```

Veja o passo-a-passo de credenciais da Meta em [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#configurando-a-meta-cloud-api).

---

## Frontend / Design

O design do painel web é gerado separadamente. O prompt pronto para o **Claude (design)**
está em [`docs/CLAUDE-DESIGN-PROMPT.md`](docs/CLAUDE-DESIGN-PROMPT.md). Depois de gerar a
UI, conectamos os componentes aos endpoints do API Gateway (contrato REST documentado na
arquitetura).

> ✅ A UI já foi gerada (no design do Claude) e vive em `services/web` (Vite + React + Tailwind). Rode com `npm install && npm run dev` — veja `services/web/README.md`.

## Roadmap

Fases de evolução (MVP → produção) em [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Licença

Proprietário (a definir). Este repositório é um scaffold inicial para evolução.

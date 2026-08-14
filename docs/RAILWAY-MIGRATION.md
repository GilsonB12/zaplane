# Migração do Zaplane para o Railway — guia para o Igor

> Este guia assume que você (Igor) já tem acesso ao repositório
> `github.com/GilsonB12/zaplane` e vai executar os passos você mesmo.
> Onde este doc pede um "valor real" (senha, chave, token), **nunca** cole
> esse valor num arquivo do repositório — ele é só para colar direto no
> painel do Railway (variáveis de ambiente).

## 0. Visão geral do que vai mudar

Hoje a produção roda 100% num PC Ubuntu (self-hosted): Postgres + os 3
serviços (gateway/dispatcher/importer) rodando via `systemd`, expostos por
um túnel nomeado do Cloudflare em `https://zaplane.com.br`.

Depois da migração:

```
zaplane.com.br         (Railway: serviço "web", React estático)
api.zaplane.com.br     (Railway: serviço "api-gateway", NestJS)
                             │
                             ├──> Railway Postgres (plugin gerenciado)
                             ├──> Railway "dispatcher" (Go, sem domínio público — só lê o banco)
                             └──> Railway "importer" (FastAPI, sem domínio público — rede interna)
```

Duas coisas importantes que **facilitam** essa migração:

- O CORS do gateway já está totalmente aberto (`app.enableCors({ origin: true })`
  em `services/api-gateway/src/main.ts`), então o frontend pode chamar a API
  num domínio diferente (`api.zaplane.com.br`) sem precisar mexer em código.
- A URL da API no frontend já é configurável em tempo de build
  (`VITE_API_URL`, em `services/web/src/api/client.js`) — não hardcoded.

Ou seja: dá pra migrar **sem alterar uma linha de código**, só configuração
de infraestrutura.

## 1. Pré-requisitos

1. Você (Igor) precisa estar como **colaborador** do repo
   `github.com/GilsonB12/zaplane` (o Gilson te convida em
   Settings → Collaborators, você aceita o convite por e-mail).
2. Criar conta em [railway.com](https://railway.com) (dá pra logar com o
   GitHub — recomendado, facilita conectar o repo).
3. Ter o chip/número e as credenciais da Meta que já usamos (isso não muda).

## 2. Instalar o Claude Code (pra você poder mexer no projeto com IA)

1. Instale o Node.js LTS, se ainda não tiver: https://nodejs.org
2. No terminal:
   ```
   npm install -g @anthropic-ai/claude-code
   ```
3. Clone o repositório:
   ```
   git clone https://github.com/GilsonB12/zaplane.git
   cd zaplane
   ```
4. Rode `claude` dentro da pasta do projeto e faça login com sua conta
   Anthropic (assinatura Pro/Max, ou uma chave de API do console.anthropic.com)
   quando ele pedir.
5. Pronto — o Claude Code já lê o `CLAUDE.md` da raiz do projeto
   automaticamente e tem o contexto todo do Zaplane.

Guia oficial, caso algo mude: https://docs.claude.com/claude-code

## 3. Criar o projeto no Railway

1. Railway → **New Project** → **Deploy from GitHub repo** → escolhe
   `GilsonB12/zaplane`.
2. Railway vai tentar detectar um serviço sozinho — **cancele/apague** esse
   serviço automático, vamos criar os 4 manualmente com o *root directory*
   certo (o repo tem múltiplos serviços em `services/*`, não um só na raiz).
3. **Add** → **Database** → **PostgreSQL** (plugin gerenciado do Railway).
   Guarda a `DATABASE_URL` que ele gera (fica em Variables do plugin).

## 4. Aplicar o schema no banco novo

O projeto **não** usa `prisma migrate` — o SQL em `db/migrations/*.sql` é a
fonte de verdade (Prisma só gera o client via `db pull`). Aplique os arquivos
**na ordem**, direto no Postgres do Railway:

```bash
# pega a connection string externa em Postgres → Connect → "Public Network"
export PGURL="postgresql://postgres:SENHA@HOST.railway.app:PORTA/railway"

psql "$PGURL" -f db/migrations/001_init.sql
psql "$PGURL" -f db/migrations/003_channels_connect.sql
psql "$PGURL" -f db/migrations/004_billing.sql
psql "$PGURL" -f db/migrations/005_billing_gating.sql
psql "$PGURL" -f db/migrations/006_billing_topup_idempotency.sql
psql "$PGURL" -f db/migrations/007_org_cpf_cnpj.sql
psql "$PGURL" -f db/migrations/008_pricing_and_cleanup.sql
psql "$PGURL" -f db/migrations/009_channel_alerts.sql
psql "$PGURL" -f db/migrations/010_channel_payment_ack.sql
psql "$PGURL" -f db/migrations/011_password_reset.sql
psql "$PGURL" -f db/migrations/012_queue_resilience.sql
```

> **Não** rode `002_seed_dev.sql` — é dado de exemplo, não produção.

> ⚠️ **O SQL vai ANTES do código.** As migrações são aplicadas à mão, então
> subir o serviço antes do `psql` deixa o código pedindo coluna que não existe.
> O dispatcher agora se recusa a iniciar nesse caso (em vez de ficar vivo,
> logando erro e sem entregar nada) — se o deploy dele falhar com
> *"schema desatualizado"*, é isto: rode a migração que falta e redeploy.

> 📌 Ao adicionar uma migração nova, **acrescente a linha aqui também** — esta
> lista já ficou desatualizada uma vez e quem seguisse o passo a passo montaria
> um ambiente sem as colunas mais recentes.

## 5. Os 4 serviços

Pra cada um: **New** → **GitHub Repo** (o mesmo repo) → em **Settings**,
define o **Root Directory** e as variáveis abaixo. O Railway detecta a
linguagem sozinho (Nixpacks) a partir do root directory — não precisa de
Dockerfile.

### 5.1 `api-gateway` (NestJS)
- **Root directory:** `services/api-gateway`
- **Build command:** `npm install && npx prisma generate && npm run build`
- **Start command:** `npm run start:prod`
- **Domínio público:** sim → depois vamos apontar `api.zaplane.com.br` aqui.
- **Variáveis** (copie os VALORES reais do `.env` atual no servidor —
  não invente novos, principalmente `APP_ENCRYPTION_KEY` e as chaves da
  Meta/Asaas, que precisam ser **idênticas** às de produção):
  ```
  NODE_ENV=production
  PORT=(o Railway injeta automaticamente $PORT — não sobrescreva)
  API_PREFIX=api/v1
  DATABASE_URL=<a do Postgres do Railway>
  JWT_ACCESS_SECRET=<mesmo valor do servidor atual>
  JWT_REFRESH_SECRET=<mesmo valor do servidor atual>
  JWT_ACCESS_TTL=900
  JWT_REFRESH_TTL=2592000
  IMPORTER_URL=http://importer.railway.internal:8000
  WHATSAPP_GRAPH_API_VERSION=v21.0
  WHATSAPP_WEBHOOK_VERIFY_TOKEN=<mesmo valor do servidor atual>
  WHATSAPP_APP_SECRET=<mesmo valor do servidor atual>
  WHATSAPP_ACCESS_TOKEN=<token do System User da Zaplane — obrigatório para a
                          CONEXÃO ASSISTIDA (adicionar/verificar/registrar
                          número na WABA da Zaplane); mesmo valor do servidor
                          atual. Sem ele a conexão assistida falha por
                          autenticação para todo mundo>
  APP_ENCRYPTION_KEY=<MESMO valor do servidor atual — trocar quebra a
                       descriptografia dos tokens de canal já salvos>
  BILLING_USAGE_PRICE_CENTS=43
  BILLING_SUBSCRIPTION_PRICE_CENTS=13500
  PAYMENT_PROVIDER=asaas
  ASAAS_BASE_URL=<mesmo valor do servidor atual>
  ASAAS_API_KEY=<mesmo valor do servidor atual>
  ASAAS_WEBHOOK_TOKEN=<mesmo valor do servidor atual>
  WEBHOOK_PUBLIC_URL=https://api.zaplane.com.br
  ZAPLANE_FB_APP_ID=<mesmo valor do servidor atual>
  ZAPLANE_FB_APP_SECRET=<mesmo valor do servidor atual>
  ZAPLANE_ES_CONFIG_ID=<mesmo valor do servidor atual>
  ```
  Pra ver os valores atuais sem digitar de cabeça: `ssh` no servidor Ubuntu e
  `cat services/api-gateway/.env` — copie e cole direto no Railway, nunca num
  arquivo do git.

### 5.2 `dispatcher` (Go)
- **Root directory:** `services/dispatcher`
- **Build command:** `go build -o dispatcher ./cmd/dispatcher`
- **Start command:** `./dispatcher`
- **Domínio público:** **não** precisa (ele só lê a fila do Postgres e chama
  a Meta diretamente).
- **Variáveis:**
  ```
  DATABASE_URL=<a mesma do Postgres do Railway>
  WHATSAPP_GRAPH_API_VERSION=v21.0
  WORKER_CONCURRENCY=4
  BATCH_SIZE=50
  POLL_INTERVAL_MS=750
  DEFAULT_RATE_PER_SEC=20
  ```
  (`WHATSAPP_ACCESS_TOKEN` fica vazio — os tokens reais são por canal, vêm
  cifrados do banco.)

### 5.3 `importer` (FastAPI)
- **Root directory:** `services/importer`
- **Build command:** `pip install -r requirements.txt`
- **Start command:** `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- **Domínio público:** **não** — só é chamado pelo gateway via rede interna.
- **Variáveis:** nenhuma obrigatória.
- Tem um endpoint `/health` — útil se o Railway pedir um healthcheck path.

### 5.4 `web` (React/Vite)
- **Root directory:** `services/web`
- **Build command:** `npm install && npm run build`
- **Start command:** um servidor estático simples, ex.: `npx serve -s dist -l $PORT`
  (ou configure o "Static Site" do Railway se ele oferecer essa opção pro
  root directory).
- **Domínio público:** sim → depois vamos apontar `zaplane.com.br` +
  `www.zaplane.com.br` aqui.
- **Variáveis** (aplicadas em **build time**, então precisam existir antes
  de rodar o build):
  ```
  VITE_API_URL=https://api.zaplane.com.br/api/v1
  VITE_FB_APP_ID=<mesmo ZAPLANE_FB_APP_ID do gateway>
  VITE_ES_CONFIG_ID=<mesmo ZAPLANE_ES_CONFIG_ID do gateway>
  ```

## 6. Rede interna entre serviços

O Railway dá um hostname interno pra cada serviço dentro do mesmo projeto:
`<nome-do-serviço>.railway.internal`. É esse hostname que usamos em
`IMPORTER_URL` no gateway (`http://importer.railway.internal:8000`) — não
precisa expor o importer publicamente.

## 7. Testar ANTES de trocar o domínio

Cada serviço com domínio público ganha uma URL tipo
`https://web-production-xxxx.up.railway.app`. **Teste tudo por essa URL
temporária primeiro** (login, contatos, campanhas, billing) — só depois de
confirmar que está tudo funcionando é que fazemos o corte de DNS.

## 8. Domínio customizado + DNS (Cloudflare)

1. No serviço `api-gateway` do Railway: **Settings → Networking → Custom
   Domain** → digita `api.zaplane.com.br` → ele te dá um **CNAME** pra
   cadastrar.
2. No serviço `web`: mesma coisa, com `zaplane.com.br` e
   `www.zaplane.com.br` (ele pode pedir um registro **A/ALIAS** pra raiz do
   domínio — segue o que a tela do Railway indicar).
3. No **Cloudflare** (dash.cloudflare.com → zaplane.com.br → DNS):
   - Adiciona o CNAME de `api` apontando pro valor que o Railway deu.
   - **Ainda não mexe** no CNAME de `zaplane.com.br`/`www` que hoje aponta
     pro túnel do Cloudflare — isso só muda no corte final (passo 10).
   - Recomendação do Railway: deixar esses registros novos como **"DNS
     only"** (nuvem cinza, não laranja) pra validação do certificado SSL
     funcionar direto. Depois, se quiser, pode reativar o proxy.

## 9. Atualizar o webhook da Meta

Isso é só um campo de configuração — **não** dispara nova análise do App
Review:

1. `developers.facebook.com` → app Zaplane → **Casos de uso → Personalizar
   → Conectar no WhatsApp → Configuração básica → Etapa 2 → Configurar
   webhooks**.
2. Troca a **URL de callback** para:
   ```
   https://api.zaplane.com.br/api/v1/webhooks/whatsapp
   ```
3. **Verificar e salvar** (o token continua o mesmo,
   `WHATSAPP_WEBHOOK_VERIFY_TOKEN`).

## 10. Migrar os dados reais + corte final

1. **Dump mais recente possível** do Postgres atual (no servidor Ubuntu):
   ```bash
   ssh gilson@192.168.18.172
   pg_dump -Fc -U postgres zaplane > zaplane_prod.dump
   ```
2. Copie o arquivo pro seu computador (`scp`) e restaure no Postgres do
   Railway:
   ```bash
   pg_restore -d "$PGURL" --clean --if-exists zaplane_prod.dump
   ```
3. Confirme no painel Railway (ou via `psql`) que os dados batem (contagem
   de organizações, contatos, campanhas).
4. **Corte de DNS:** no Cloudflare, edita o CNAME de `zaplane.com.br` e
   `www` — troca o alvo do túnel do Cloudflare pelo valor que o Railway
   pediu no passo 8.2.
5. Espera propagar (minutos) e testa tudo de novo em `https://zaplane.com.br`.
6. **Só depois de confirmar** que está tudo funcionando na URL real: pare os
   serviços no Ubuntu (`sudo systemctl stop zaplane-gateway zaplane-dispatcher
   zaplane-importer zaplane-tunnel`) — mas **não desinstale nada ainda**.
   Deixe uns dias como plano B: se algo no Railway falhar, é só reverter o
   CNAME de volta e reiniciar os serviços do Ubuntu.

## 11. Checklist final

- [ ] Login funciona em `https://zaplane.com.br`
- [ ] Contatos, Conversas, Campanhas, Templates carregam com dados reais
- [ ] Consegue disparar uma campanha de teste e o dispatcher processa
- [ ] Webhook da Meta valida (`GET .../webhooks/whatsapp?hub.verify_token=...`
      devolve o challenge)
- [ ] Billing (Asaas) segue funcionando — teste um evento de webhook
- [ ] `WEBHOOK_PUBLIC_URL` no gateway aponta pra `api.zaplane.com.br`
- [ ] Ubuntu mantido de standby por alguns dias antes de desligar de vez

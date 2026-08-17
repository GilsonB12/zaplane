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
psql "$PGURL" -f db/migrations/013_conexao_assistida.sql
psql "$PGURL" -f db/migrations/014_templates_por_dono.sql
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

### 4.1 Ordem do deploy da conexão assistida (leia antes de dar `git push`)

**A migração `013` vai ANTES do código. Não é recomendação, é ordem obrigatória
— e desta vez o estrago não fica na feature nova, fica na plataforma inteira.**

Por quê: o Prisma **nunca faz `SELECT *`**, ele lista as colunas uma a uma na
consulta. O `services/api-gateway/prisma/schema.prisma` já declara colunas que
só existem depois da `013` — principalmente `register_pin_enc` em
`whatsapp_channels`. Resultado: com o código novo no ar e a `013` não aplicada,
**toda** consulta a `whatsapp_channels` morre com *"column
whatsapp_channels.register_pin_enc does not exist"*. Isso é a listagem de
canais, a criação de campanha, o envio, o webhook de status — para **todos os
clientes**, inclusive os que já pagam e nem sabem que existe conexão assistida.
Não é uma feature quebrada; é o produto fora do ar.

Sequência certa, na ordem:

1. **Aplique a `013` com o código ANTIGO ainda rodando.** Ela é aditiva: cria
   `channel_connection_requests` (tabela nova), acrescenta colunas opcionais e
   troca o `CHECK` de `connected_via` por um que aceita mais um valor. O código
   antigo continua funcionando normalmente com ela já aplicada — é por isso que
   essa é a ordem segura, e não o contrário.
   ```bash
   psql "$PGURL" -f db/migrations/013_conexao_assistida.sql
   ```
2. **Confira** que aplicou (o `psql` não deve ter impresso `ERROR`):
   ```bash
   psql "$PGURL" -c "\d channel_connection_requests" -c "\d whatsapp_channels"
   ```
3. **Só então** `git push` — o Railway rebuilda `zaplane-gateway` e
   `zaplane-dispatcher`.
4. **Depois** ligue a feature, definindo `ZAPLANE_WABA_ID` **e**
   `WHATSAPP_ACCESS_TOKEN` (ver §5.1 e §5.2).

> Já deu `git push` antes da migração? Não precisa reverter nada: aplique a
> `013` **agora**. Ela não depende do código novo, e assim que ela entra as
> consultas voltam a funcionar (o Prisma não guarda cache de schema).

**As duas variáveis da feature entram no MESMO deploy — nunca só a WABA.**
O gateway trata os dois casos de propósito, e de formas diferentes:

- `ZAPLANE_WABA_ID` **ausente** → a conexão assistida fica **desligada**. O boot
  é normal (a API sobe, campanhas e cobrança seguem funcionando) e as rotas
  `/channels/assisted` respondem **503** com texto honesto. É o estado em que a
  produção está hoje, e é seguro.
- `ZAPLANE_WABA_ID` **definido** com `WHATSAPP_ACCESS_TOKEN` **vazio** → feature
  ligada pela metade, que é o estado perigoso: toda chamada à Meta falharia por
  autenticação e o cliente leria *"Estamos com a capacidade cheia"*, que é
  mentira. Por isso o gateway **recusa iniciar** em produção nesse caso — o
  deploy falha na cara do operador em vez de mentir para o cliente.

Na prática, no Railway: use o **Raw Editor** das Variables para colar as duas de
uma vez, para que um único redeploy carregue as duas. Se você salvar só a WABA,
o serviço reinicia e **não sobe** até o token entrar.

### 4.2 Ordem do deploy do isolamento de templates por dono (leia antes de dar `git push`)

**A migração `014` também vai ANTES do código — mesmo motivo da `013` (§4.1),
mas desta vez quem quebra é o LOGIN, para todo mundo. Não é "o envio para de
funcionar por alguns minutos": é o produto inteiro parado, e ninguém consegue
nem entrar no painel para descobrir o que houve.**

Por quê: a `014` acrescenta `meta_name` e `scope` à tabela `templates` (o
prefixo por dono que isola quem divide a WABA da Zaplane — ver
`docs/superpowers/specs/2026-08-17-templates-por-dono-design.md`) **e
`is_platform_admin` à tabela `users`**, e
`services/api-gateway/prisma/schema.prisma` já declara as três colunas
novas. Como o Prisma **nunca faz `SELECT *`** (lista as colunas uma a uma),
com o código novo no ar e a `014` não aplicada toda consulta a essas duas
tabelas morre com *"column ... does not exist"*. O alcance, do pior para o
menos grave:

- **Login, registro, refresh de token e recuperação de senha.**
  `services/api-gateway/src/auth/auth.service.ts` consulta `users` **sem
  `select`** (linhas ~41, ~94, ~140 e ~263), então o Prisma pede
  `users.is_platform_admin` em toda autenticação e recebe
  *"column users.is_platform_admin does not exist"*. **Ninguém entra no
  painel** — nem para ver relatório, nem para pagar, nem para abrir chamado.
  Quem já está com sessão aberta cai no primeiro refresh.
- **Envio avulso e campanha.**
  `services/api-gateway/src/messages/messages.service.ts` (linha ~38) busca o
  template antes de enfileirar, e
  `services/api-gateway/src/campaigns/campaigns.service.ts` faz a mesma busca
  antes de criar a campanha. As duas quebram com
  *"column templates.meta_name does not exist"*.
- **A tela de templates**, pelo mesmo motivo.

Isso vale para **toda organização**, inclusive quem nunca ouviu falar de
conexão assistida nem de template genérico. Não existe "empurro agora e migro
em cinco minutos": cinco minutos de envio parado se explica ao cliente, cinco
minutos de login parado em produção com cliente pagante, não.

O **dispatcher não protege contra isto** — o aviso do §4 acima ("o dispatcher
se recusa a iniciar") é sobre a coluna da `012`
(`whatsapp_channels.paused_until`, em `internal/store/store.go`); o
dispatcher nunca consulta as tabelas `templates` nem `users`, então não tem
como perceber que a `014` está faltando. Se você esquecer esta migração, o
sintoma não é um serviço que se recusa a subir — é **500 no gateway** já na
tela de login.

Sequência certa, na ordem:

1. **Aplique a `014` com o código ANTIGO ainda rodando.** Ela é aditiva:
   acrescenta `meta_name`/`scope` a `templates` (com os índices únicos por
   dono e por genérico da plataforma) e `is_platform_admin` a `users`. Login,
   campanha e envio continuam normais com ela já aplicada — o cliente Prisma
   antigo só pede as colunas antigas. **Uma exceção:** o `create()` antigo faz
   `INSERT` em `templates` sem `meta_name`, que passa a ser `NOT NULL` sem
   default, então **não crie template (nem rode o sync antigo) entre este
   passo e o passo 3** — dá 500. A janela é de minutos.
   ```bash
   psql "$PGURL" -v ON_ERROR_STOP=1 -f db/migrations/014_templates_por_dono.sql
   ```
   O `-v ON_ERROR_STOP=1` faz o `psql` sair com status ≠ 0 no primeiro erro;
   sem ele, ele sai com 0 e o `ERROR` só passa rolando na tela.
2. **Confira** que aplicou:
   ```bash
   psql "$PGURL" -c "\d templates" -c "\d users"
   ```
   `meta_name` NOT NULL, `scope` NOT NULL DEFAULT `'org'`, `organization_id`
   **nullable**, `users.is_platform_admin` presente.
3. **Só então** `git push`. Primeiro teste de fumaça: **fazer login** — é o
   que a coluna de `users` derruba.

**Rollback:** `git revert` do merge **e**
`ALTER TABLE templates ALTER COLUMN meta_name DROP NOT NULL;`. Sem o segundo,
o código antigo volta com a criação de template quebrada (mesmo motivo do
passo 1). Não tente dropar as colunas se já existir alguma linha
`scope = 'platform'`.

> Já deu `git push` antes da migração? Aplique a `014` **agora** — ela não
> depende do código novo, e assim que ela entra as consultas voltam a
> funcionar (o Prisma não guarda cache de schema).

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

#### Variáveis da conexão assistida

Todas saem de `src/config/configuration.ts` (bloco `assisted`) e estão
comentadas em `services/api-gateway/.env.example`. **Só as duas primeiras
precisam de valor real**; as outras já têm default embutido no código e só
existem para você poder apertar ou afrouxar um limite sem novo deploy de código.

```
ZAPLANE_WABA_ID=<ID da WABA da Zaplane, no WhatsApp Manager>
WHATSAPP_ACCESS_TOKEN=<System User da Zaplane — já está na lista acima>
ZAPLANE_WABA_PHONE_CAP=20
ORG_MAX_CHANNELS=1
ORG_DAILY_MESSAGE_QUOTA=200
ORG_MAX_CONNECT_ATTEMPTS_24H=5
ORG_MAX_BURNED_SLOTS_24H=2
META_HTTP_TIMEOUT_MS=15000
```

O que cada uma faz e **o que acontece se faltar**:

- **`ZAPLANE_WABA_ID`** (default: vazio) — a WABA da Zaplane que recebe os
  números dos clientes. **Faltando:** a conexão assistida fica desligada; as
  rotas `/channels/assisted` respondem 503 e o roteamento de alertas da Meta
  deixa de distinguir a WABA compartilhada da plataforma (um alerta de conta
  passa a ser espalhado para todos os canais daquela WABA). O boot é normal.
- **`WHATSAPP_ACCESS_TOKEN`** (default: vazio) — o System User da Zaplane, o
  único token que fala com essa WABA. **Faltando** *com a WABA definida:* o
  gateway **recusa iniciar em produção** (ver §4.1). Se essa checagem não
  existisse, o cliente receberia "capacidade cheia" para sempre.
- **`ZAPLANE_WABA_PHONE_CAP`** (default: `20`) — quantos números cabem na WABA.
  É o teto que a Meta impõe (2 sem empresa verificada, 20 depois da
  verificação), repetido aqui para o gateway recusar **antes** de gastar a
  chamada. **Faltando:** assume 20 — se a WABA real ainda for de 2, o cliente
  chega até a Meta e leva o erro de lá, gastando uma tentativa à toa.
- **`ORG_MAX_CHANNELS`** (default: `1`) — canais ativos por organização.
  **Faltando:** assume 1, que é o plano vendido hoje.
- **`ORG_DAILY_MESSAGE_QUOTA`** (default: `200`) — destinatários por
  organização em 24h. O limite de mensagens da Meta é do **portfólio**, ou seja,
  compartilhado por todos os números da plataforma. **Faltando:** assume 200; se
  você aumentar demais, um cliente sozinho consome a capacidade de todos.
- **`ORG_MAX_CONNECT_ATTEMPTS_24H`** (default: `5`) — tentativas de conexão por
  organização em 24h, contadas **no banco** (o rate limit por usuário do
  controller não segura isso: dois usuários da mesma empresa somam baldes
  separados). **Faltando:** assume 5.
- **`ORG_MAX_BURNED_SLOTS_24H`** (default: `2`) — **a trava mais importante do
  fluxo.** Conta *vagas queimadas*: solicitações em que a Meta já aceitou o
  número (a vaga foi consumida) e que não terminaram conectadas. A vaga **não
  volta por API** — a baixa é manual, no WhatsApp Manager. **Faltando:** assume
  2, o que limita o estrago diário de uma única organização a ~10% da
  capacidade da WABA inteira. Não aumente sem entender isso.
- **`META_HTTP_TIMEOUT_MS`** (default: `15000`) — timeout de cada chamada à
  Graph API neste fluxo. **Faltando:** assume 15s. Valor inválido (texto, zero)
  também cai no default — sem timeout, uma chamada pendurada travaria a
  requisição do cliente com a vaga já consumida.

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
  WHATSAPP_ACCESS_TOKEN=<MESMO token do gateway — OBRIGATÓRIO, ver abaixo>
  APP_ENCRYPTION_KEY=<MESMO valor do gateway>
  WORKER_CONCURRENCY=4
  BATCH_SIZE=50
  POLL_INTERVAL_MS=750
  DEFAULT_RATE_PER_SEC=20
  ```

  > ⚠️ **`WHATSAPP_ACCESS_TOKEN` deixou de ser opcional aqui.** Versões
  > anteriores deste guia mandavam deixar vazio, e estava certo enquanto cada
  > cliente trazia o próprio token — o gateway gravava esse token cifrado na
  > linha do canal e o worker usava ele.
  >
  > Na **conexão assistida** o número vive na WABA da própria Zaplane, e o token
  > que fala com ela é o da plataforma. O gateway, de propósito, **grava o campo
  > de token do canal vazio** (`access_token_enc = ''`) para não copiar o
  > segredo da Zaplane em cada linha; o worker então cai no fallback do
  > ambiente, que é justamente esta variável (`resolveToken`, em
  > `internal/worker/worker.go`).
  >
  > Com ela vazia, **toda** mensagem desses canais falha com `no_token` — e
  > falha *depois* de o cliente ter visto "Número conectado" na tela. Ele acha
  > que está tudo pronto e nada sai.
  >
  > Use o **mesmo valor** do gateway. Se o token da plataforma for rotacionado,
  > troque nos dois serviços.

  > `APP_ENCRYPTION_KEY` também é necessária aqui, pelo motivo oposto: os canais
  > **antigos** (`connected_via` = `manual` ou `embedded_signup`) guardam o token
  > do cliente cifrado no banco, e sem a chave o worker manda o texto cifrado
  > para a Meta como se fosse token — todo envio desses clientes falha por
  > autenticação. Tem de ser exatamente a mesma chave do gateway.

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
- [ ] Migração `013` aplicada **antes** do push do código (§4.1)
- [ ] Migração `014` aplicada **antes** do push do código (§4.2) — sem ela,
      envio avulso e campanha quebram para **toda** organização
- [ ] `ZAPLANE_WABA_ID` e `WHATSAPP_ACCESS_TOKEN` definidos **juntos** no gateway
- [ ] `WHATSAPP_ACCESS_TOKEN` e `APP_ENCRYPTION_KEY` definidos também no
      dispatcher (§5.2) — sem eles o envio falha depois de o cliente ver
      "Número conectado"
- [ ] Ubuntu mantido de standby por alguns dias antes de desligar de vez

## 12. Diagnóstico: "não consigo conectar meu número"

O erro real da Meta **não** aparece para o cliente, de propósito: se aparecesse,
a rota viraria um oráculo de enumeração — bastaria tentar números alheios e ler
a resposta para descobrir quem já é cliente da plataforma. "Número em uso",
"número inválido" e "número com WhatsApp ativo" devolvem todos o mesmo texto
(`src/channels/assisted/erros.ts`).

O contrapeso é o rastro do lado de dentro: o **código numérico** da Meta vai
para `audit_logs` e para o log do gateway no Railway (logger
`ConexaoAssistida`). As consultas abaixo são o jeito de ler esse rastro — sem
elas, o suporte fica sem nada para olhar.

Rode tudo com o `$PGURL` do §4 (`psql "$PGURL"`). **São consultas de leitura**;
nenhuma altera dado.

### 12.1 Chegando na solicitação (e no `phone_hash`)

`audit_logs.resource_id` guarda o **hash** do telefone, nunca o número — é um
HMAC-SHA256 com a `APP_ENCRYPTION_KEY` (`phoneHash`, em
`src/common/crypto.util.ts`). Você **não** consegue calcular esse hash na mão, e
não deve tentar: a chave não sai do painel de variáveis. O caminho é o inverso —
ache a solicitação pelos campos em claro e **leia o hash dela**.

O que fica legível em `channel_connection_requests`: a organização, o DDD, os 4
últimos dígitos e o nome do negócio. O número inteiro fica cifrado.

```sql
-- 1) do e-mail do cliente para a organização
SELECT o.id AS organization_id, o.name, u.email, u.role
  FROM organizations o
  JOIN users u ON u.organization_id = o.id
 WHERE lower(u.email) = lower('cliente@exemplo.com');
```

```sql
-- 2) as solicitações dessa organização — a última linha é a que ele está
--    tentando agora. É daqui que sai o phone_hash usado no resto.
SELECT id,
       created_at, updated_at,
       status,
       '(' || phone_ddd || ') ' || '••••-' || phone_last4 AS numero,
       display_name,
       phone_number_id,          -- preenchido = a Meta ACEITOU o número (vaga consumida)
       code_requests,            -- quantos SMS/ligações já pediu (teto 3 em 24h)
       code_attempts,            -- quantos códigos errados (5 = solicitação morre)
       code_verified_at,         -- preenchido = código já aceito; falta só o registro
       error_code,
       error_detail,
       phone_hash
  FROM channel_connection_requests
 WHERE organization_id = '<organization_id do passo 1>'
 ORDER BY created_at DESC
 LIMIT 20;
```

Como ler o `status`: `criando` (número ainda não aceito pela Meta),
`aguardando_codigo` (SMS enviado), `concluida`, `falhou`, `cancelada`.
`error_code` traz **ou** o código numérico da Meta em texto, **ou** um motivo
nosso: `codigo_esgotado` (5 erros de código), `numero_de_outra_org` (o número já
pertence a outro cliente), `pnid_de_outra_org` (registrou na Meta mas o canal já
existia em outra organização — precisa de baixa manual), `canal_nao_criado`
(falha nossa depois do registro; a solicitação continua retomável).

### 12.2 Histórico completo daquela solicitação

```sql
SELECT created_at, action, actor_user_id, metadata
  FROM audit_logs
 WHERE resource_type = 'channel_connection'
   AND resource_id = '<phone_hash da consulta 2>'
 ORDER BY created_at;
```

As ações que este fluxo grava, em ordem de acontecimento:

| `action`                          | significa                                              | `metadata`                          |
|-----------------------------------|--------------------------------------------------------|-------------------------------------|
| `channel.connect.requested`       | o cliente pediu a conexão                               | `{}`                                |
| `channel.connect.sms_sent`        | a Meta aceitou o número e o SMS saiu                    | `{}`                                |
| `channel.connect.resend_failed`   | falhou reenviar o código                                | `{ metodo, codigoMeta }`            |
| `channel.connect.verify_failed`   | código recusado pela Meta                               | `{ tentativas, codigoMeta }`        |
| `channel.connect.register_failed` | código OK, mas o registro na Meta falhou                | `{ codigoMeta }`                    |
| `channel.connect.channel_failed`  | registrou na Meta e o canal não nasceu no nosso banco   | `{ motivo }`                        |
| `channel.connect.registered`      | conectado (`reaproveitado` = a retentativa reaproveitou o canal) | `{ canalId, reaproveitado? }` |
| `channel.connect.cancelled`       | o cliente cancelou                                      | `{}`                                |

Sem `sms_sent`, o número nunca chegou a ser aceito — o problema é anterior ao
SMS. Com `sms_sent` e vários `verify_failed`, o cliente está digitando o código
errado (ou o SMS chegou para outro aparelho). Com `register_failed` e
`code_verified_at` preenchido, o código já está aceito: o cliente só precisa
apertar **"Concluir conexão"** no painel, sem digitar nada.

> ⚠️ A gravação da auditoria é **best-effort** — se o INSERT falhar, o fluxo do
> cliente continua (era isso ou fazer o cliente queimar outra vaga por um erro
> nosso) e fica só um `ERROR` no log do gateway. Ausência de linha aqui não é
> prova de que nada aconteceu: confira também o `error_code` da consulta 12.1 e
> os logs do `zaplane-gateway` no Railway.

### 12.3 Os códigos de erro da Meta que ficaram registrados

```sql
SELECT created_at,
       action,
       metadata->>'codigoMeta'  AS codigo_meta,
       metadata->>'tentativas'  AS tentativa,
       metadata->>'metodo'      AS metodo,
       metadata->>'motivo'      AS motivo
  FROM audit_logs
 WHERE resource_type = 'channel_connection'
   AND resource_id = '<phone_hash>'
   AND action LIKE 'channel.connect.%failed'
 ORDER BY created_at;
```

`codigo_meta` é o número que a Meta devolveu — é ele que se procura na
documentação de erros da Cloud API. Os mais comuns neste fluxo: `133005` (PIN de
duas etapas incorreto), `133006` (número precisa ser verificado antes de
registrar), `136008`/`136024` (problema com o número), `100` (parâmetro
inválido) e `4`/`80007` (limite de vazão — vale tentar mais tarde).

### 12.4 Quantas conexões falharam no período

```sql
-- panorama por dia (últimos 7 dias)
SELECT date_trunc('day', created_at)::date            AS dia,
       count(*)                                        AS tentativas,
       count(*) FILTER (WHERE status = 'concluida')    AS conectadas,
       count(*) FILTER (WHERE status = 'falhou')       AS falhadas,
       count(*) FILTER (WHERE status = 'cancelada')    AS canceladas,
       count(*) FILTER (WHERE phone_number_id IS NOT NULL
                          AND status <> 'concluida')   AS vagas_queimadas
  FROM channel_connection_requests
 WHERE created_at >= now() - interval '7 days'
 GROUP BY 1
 ORDER BY 1 DESC;
```

`vagas_queimadas` é a coluna para vigiar: cada linha aí é uma vaga da WABA da
Zaplane consumida **sem** virar cliente conectado, e essa vaga **não volta por
API** — a baixa é manual, no WhatsApp Manager (a rota
`GET /channels/assisted/orphans`, restrita a `owner`, lista os números órfãos).

```sql
-- por que falharam, agrupado (últimos 7 dias)
SELECT coalesce(error_code, '(sem código)') AS motivo,
       count(*)                             AS ocorrencias,
       max(created_at)                      AS mais_recente
  FROM channel_connection_requests
 WHERE created_at >= now() - interval '7 days'
   AND status <> 'concluida'
 GROUP BY 1
 ORDER BY 2 DESC;
```

```sql
-- os códigos da Meta mais frequentes no período, olhando a auditoria
SELECT metadata->>'codigoMeta' AS codigo_meta,
       count(*)                AS ocorrencias,
       min(created_at)         AS primeira,
       max(created_at)         AS ultima
  FROM audit_logs
 WHERE resource_type = 'channel_connection'
   AND action LIKE 'channel.connect.%failed'
   AND created_at >= now() - interval '7 days'
 GROUP BY 1
 ORDER BY 2 DESC;
```

Um mesmo código repetido em organizações diferentes quase nunca é problema do
cliente: é token expirado, WABA lotada ou mudança de versão da Graph API. Nesse
caso, olhe o log do `zaplane-gateway` (as falhas de `contarNumeros` e
`inscreverWebhook` só existem lá) antes de responder ao cliente.

### 12.5 Templates genéricos da plataforma

Depois que o número é registrado, a conexão assistida chama `templates.sync`
sozinha, em best-effort: se ela não rodar, fica um `WARN` no log do gateway —
`falhou` (exceção, logger `ConexaoAssistida`) ou `não rodou` (o caso mais
provável: sem credencial, ou a Graph API respondeu erro; nesse caminho o
`sync` devolve `{ synced: false, note }` em vez de lançar). Os dois casos
aparecem no log; o cliente não vê erro nem perde a conexão, porque a vaga já
foi consumida naquele ponto. É esse sync que importa, para a organização
recém-conectada, os templates com o prefixo dos genéricos da plataforma
(`zaplane_...`), para o cliente conseguir disparar já no primeiro dia em vez
de esperar a análise da Meta.

Note que o prefixo `zaplane_` só é reconhecido como genérico **quando a WABA
sincronizada é a da plataforma**. Um cliente legado que criar um
`zaplane_qualquer_coisa` na WABA dele não cria template de plataforma nenhum:
o sync dele ignora o nome, como ignora qualquer template que não carregue o
prefixo da própria organização.

Quem pode **criar** um template genérico novo (`POST /templates/platform`)
precisa estar marcado como operador da plataforma — um nível acima do `role`
por organização (owner/admin/operator/viewer), na coluna
`users.is_platform_admin` (migração `014`).

> **Pré-condição, e ela não é opcional.** A submissão do genérico à Meta usa a
> WABA da organização **de quem chamou** a rota. Se o usuário marcado estiver
> numa organização **sem canal ativo na WABA da plataforma**, o template nasce
> `PENDING`, sem `meta_template_id`, **nunca submetido** — e não há como
> consertar pelo app: não existe rota de reenvio nem `DELETE /templates/:id`,
> recriar o mesmo nome toma 409, e a linha **já aparece na lista de todo
> cliente assistido**. Só sai por SQL direto no banco. Escolha um usuário de
> uma organização que tenha número na WABA da Zaplane, e confira antes:

```sql
-- 1) qual é a organização do usuário
SELECT u.email, u.organization_id, o.name
  FROM users u JOIN organizations o ON o.id = u.organization_id
 WHERE u.email = 'operador@zaplane.com.br';

-- 2) essa organização tem canal ATIVO na WABA da plataforma?
--    (precisa devolver ao menos uma linha; o waba_id abaixo é o valor da
--     variável ZAPLANE_WABA_ID do gateway — confira lá antes de copiar)
SELECT id, waba_id, connected_via, status
  FROM whatsapp_channels
 WHERE organization_id = '<a organization_id do passo 1>'
   AND status = 'active'
   AND (connected_via = 'assisted' OR waba_id = '<ZAPLANE_WABA_ID>');
```

Só depois de o passo 2 devolver linha:

```sql
UPDATE users SET is_platform_admin = true WHERE email = 'operador@zaplane.com.br';
```

Se um genérico morto já tiver sido criado, ele é reconhecido assim (e a
remoção é por SQL, na mesma linha):

```sql
SELECT id, name, meta_name, category, status, meta_template_id
  FROM templates WHERE scope = 'platform' AND meta_template_id IS NULL;
```

> A WABA da plataforma (`1972668750117567`) já tem dois templates aprovados,
> `zaplane_teste_entrega` e `zaplane_conexao_confirmada`, criados em teste
> manual antes desta mudança existir. Como os dois já carregam o prefixo dos
> genéricos, o primeiro `sync` depois do deploy os adota automaticamente como
> templates de plataforma — sem migração especial, sem recriar nada. Se eles
> aparecerem sozinhos na lista de templates de um cliente recém-conectado, é
> esperado, não bug.

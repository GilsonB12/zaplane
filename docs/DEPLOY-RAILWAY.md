# Deploy no Railway — Zaplane

> Runbook para subir o backend do Zaplane no Railway como um **projeto separado**,
> na mesma conta que já roda outros apps. Build via **Nixpacks** (sem Docker), respeitando
> o guardrail do projeto (nada de Docker/AWS). O schema SQL continua sendo a fonte de verdade.

## 0. Pré-requisitos

- Conta Railway com plano ativo (Hobby serve).
- **Usage Limit configurado** no workspace antes de subir (evita surpresa na fatura) —
  ver `railway.com/account/usage`. Lembre: o limite é **global do workspace**, soma todos
  os projetos.
- Repo no GitHub (o Railway builda direto do GitHub).
- (Opcional) Railway CLI: `npm i -g @railway/cli` + `railway login`.

## 1. Criar o projeto e o Postgres

1. Railway → **New Project** → dê o nome `zaplane`.
2. Dentro dele: **+ New → Database → PostgreSQL**.
3. O serviço `Postgres` nasce com as variáveis `DATABASE_URL` (privada) e uma URL pública
   em **Variables / Connect** (para rodar a migration de fora).

## 2. Rodar a migration (passo manual, uma vez)

O gateway usa Prisma só como client; o schema é **SQL cru**. O build **não** aplica migration.
Pegue a **DATABASE_URL pública** do Postgres do Railway e rode localmente:

```bash
PGURL="postgresql://postgres:SENHA@HOST-PUBLICO.railway.app:PORTA/railway"

# aplica TODAS as migrações em ordem (001, 003, 004 … 014)
for f in db/migrations/*.sql; do
  # o 002 é seed de desenvolvimento: fora do laço, e NÃO vai para produção
  case "$f" in */002_seed_dev.sql) continue;; esac
  echo "== $f"
  psql "$PGURL" -v ON_ERROR_STOP=1 -f "$f" || break
done
```

Aplicar só a `001_init.sql` não basta — o gateway usa Prisma, que lista as colunas uma a
uma e pede as das migrações seguintes em toda consulta.

O laço acima é para banco **novo, do zero**: a `001_init.sql` cria as tabelas sem
`IF NOT EXISTS`, então rodá-la de novo num banco que já a tem falha (e o `|| break`
interrompe ali). Num banco que já está em produção, aplique **só os arquivos novos**, um a
um — migrações futuras são **aditivas** (`00X_*.sql`) e numeradas com 3 dígitos, então a
ordem alfabética é a ordem de aplicação. Ver `docs/RAILWAY-MIGRATION.md` para a ordem de
deploy de cada migração em relação ao código, que às vezes importa.

> `002_seed_dev.sql` é **dado de exemplo, não produção** — por isso ele fica fora do laço.
> Num banco descartável de teste, rode-o **por último**, depois de todas as migrações: ele
> grava colunas que só existem a partir da `014`.

## 3. Criar os 3 serviços a partir do monorepo

Para **cada** serviço: **+ New → GitHub Repo → (este repo)**, e em
**Settings → Root Directory** aponte para a pasta. O Railway lê o `railway.json` de cada pasta.

| Serviço            | Root Directory            | Domínio público? |
|--------------------|---------------------------|------------------|
| `zaplane-gateway`  | `services/api-gateway`    | **Sim** (Generate Domain) |
| `zaplane-importer` | `services/importer`       | Não (só interno) |
| `zaplane-dispatcher` | `services/dispatcher`   | Não (worker, sem porta) |

Os `railway.json` já definem build/start:
- **gateway**: `npm ci --include=dev && npx prisma generate && npm run build` → `npm run start:prod`
  (o `--include=dev` é obrigatório: `@nestjs/cli` e `typescript` são devDependencies).
- **importer**: Nixpacks instala `requirements.txt` → `uvicorn app.main:app --host 0.0.0.0 --port $PORT`.
- **dispatcher**: `go build -o app ./cmd/dispatcher` → `./app`.

## 4. Variáveis de ambiente por serviço

Use **Reference Variables** para o banco: no gateway e no dispatcher, defina
`DATABASE_URL = ${{Postgres.DATABASE_URL}}` (o Railway resolve para a URL privada).

### `zaplane-gateway` (obrigatórias)
| Variável | Valor |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `NODE_ENV` | `production` |
| `API_PREFIX` | `api/v1` |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | segredos fortes (você gera) |
| `WHATSAPP_GRAPH_API_VERSION` | `v21.0` |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | token que você inventa (usado na verificação Meta) |
| `WHATSAPP_APP_SECRET` | App Secret do app Meta (assinatura do webhook) |
| `APP_ENCRYPTION_KEY` | chave base64 de 32 bytes |
| `IMPORTER_URL` | `http://zaplane-importer.railway.internal:8000` |
| `WEBHOOK_PUBLIC_URL` | `https://<seu-gateway>.railway.app` (após gerar o domínio) |

> `PORT` o Railway injeta sozinho — o gateway já lê `process.env.PORT`. Não fixe.

### `zaplane-gateway` (opcionais — billing/Embedded Signup, só se for usar)
`PAYMENT_PROVIDER`, `ASAAS_BASE_URL`, `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`
(troque o placeholder — o app recusa iniciar em produção com o valor default),
`BILLING_USAGE_PRICE_CENTS`, `BILLING_SUBSCRIPTION_PRICE_CENTS`,
`ZAPLANE_FB_APP_ID`, `ZAPLANE_FB_APP_SECRET`, `ZAPLANE_ES_CONFIG_ID`.

### `zaplane-importer`
| Variável | Valor |
|---|---|
| `DEFAULT_COUNTRY` | `BR` |
| `MAX_ROWS` | `200000` |

> `PORT` é injetado pelo Railway e o `startCommand` usa `$PORT`. Não fixe.

### `zaplane-dispatcher`
| Variável | Valor |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `WHATSAPP_GRAPH_API_VERSION` | `v21.0` |
| `WHATSAPP_ACCESS_TOKEN` | token da Meta (fallback dev; em produção vem cifrado por canal) |
| `WORKER_CONCURRENCY` | `4` |
| `BATCH_SIZE` | `50` |
| `POLL_INTERVAL_MS` | `750` |
| `DEFAULT_RATE_PER_SEC` | `20` |

## 5. Dispatcher é worker (sem porta)

O dispatcher não abre porta HTTP (faz `SKIP LOCKED` + polling). Em **Settings**:
- **não** gere domínio;
- se o Railway reclamar de healthcheck / "no open ports", deixe o **Healthcheck Path vazio**.

O `restartPolicyType: ON_FAILURE` no `railway.json` reinicia em caso de erro.

## 6. Registrar o webhook na Meta

Depois que o gateway tiver domínio público:

- **Callback URL**: `https://<seu-gateway>.railway.app/api/v1/webhooks/whatsapp`
  (confirme o path exato em `services/api-gateway/src/webhooks/`).
- **Verify Token**: o mesmo valor de `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
- A Meta dispara o desafio (`hub.challenge`) → o gateway responde → verificação passa.
- O `X-Hub-Signature-256` é validado com `WHATSAPP_APP_SECRET` (corpo cru já preservado
  via `rawBody: true` no `main.ts`).

## 7. Caminho mínimo (só destravar a Meta)

Para validar o webhook sem gastar com o resto: suba **apenas `Postgres` + `zaplane-gateway`**.
O `dispatcher` e o `importer` só são necessários para disparo real e import de contatos —
crie/ligue esses dois depois. Entre sessões de teste, pausar/remover serviços ≈ custo zero.

## 8. Deploy automático via GitHub (recomendado)

Depois do primeiro deploy manual, conecte cada serviço ao repo para deployar a cada push:

1. Serviço → **Settings → Source → Connect Repo** → instalar o GitHub App do Railway
   (o repo é `GilsonB12/zaplane` — o dono do repo precisa autorizar o app) → branch `main`.
2. **Root Directory** = a pasta do serviço (ex.: `services/api-gateway`). Obrigatório no
   monorepo: sem isso o builder analisa a raiz e falha com "could not determine how to build".
3. **Watch Paths** = `services/api-gateway/**` (idem p/ os outros) — evita redeploy de um
   serviço quando o commit só tocou outro.

## 9. Gotchas (lições do primeiro deploy real, 2026-07)

- **`railway up` em monorepo**: o CLI sobe o diretório do *link*, não o cwd. Ou se linka
  a pasta do serviço (`cd services/api-gateway && railway link -p zaplane -s zaplane-gateway`)
  ou se passa caminho **absoluto** (`railway up /caminho/completo` — o relativo tem bug
  "prefix not found" no CLI 5.28).
- **`npm ci` × cache do Nixpacks**: o mount de cache em `node_modules/.cache` causa
  `EBUSY: resource busy` no `npm ci`. Fix: variável `NIXPACKS_NO_CACHE=1` no serviço.
- **Build preso em "scheduling build"**: instabilidade do builder do Railway — re-disparar
  o deploy resolve.
- **Debug de webhook**: `railway logs --http --service zaplane-gateway --lines N` mostra
  cada request com método/rota/status — é a prova de que um POST da Meta chegou, mesmo
  quando o app não loga nada (evento de canal desconhecido é descartado em silêncio).

## 10. Outros gotchas

- **npm ci sem devDeps**: já tratado com `--include=dev`. Se ainda falhar `nest build`,
  confirme que `NODE_ENV` não está forçando produção durante o build.
- **Migration esquecida**: gateway sobe mas quebra em runtime (tabelas inexistentes). Rode o
  passo 2 antes de bater nas rotas.
- **Rede interna**: use os hosts `*.railway.internal` (não os domínios públicos) para
  gateway↔importer — mais rápido e não sai pra internet.
- **Preços mudam**: confira Usage/Billing no painel; o Usage Limit global é sua rede de segurança.

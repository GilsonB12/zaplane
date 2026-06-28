# Arquitetura — Zaplane

## 1. Objetivos e princípios

1. **Multi-tenant SaaS**: várias empresas (tenants) isoladas no mesmo cluster.
2. **Alta vazão de envio**: suportar milhares de mensagens/dia por tenant com throttle e
   retries, respeitando os limites da Meta.
3. **Conformidade desde o design** (privacy/security by design): consentimento, opt-out,
   minimização de dados, auditoria, direitos do titular (LGPD).
4. **Poliglota por necessidade, não por moda**: cada serviço usa a linguagem onde ela
   rende mais. NestJS para produtividade e domínio; Go para o caminho quente de I/O de
   rede; Python para o ecossistema de parsing/validação de dados.
5. **Simplicidade operacional na fase local**: 1 banco, sem Docker, sem Redis. O Postgres
   também é a fila (SKIP LOCKED). Trocamos por Redis/RabbitMQ/Kafka quando o volume pedir.

## 2. Componentes

### 2.1 API Gateway — NestJS (TypeScript) — "linguagem-mãe"
Responsável pela superfície de negócio e por toda a escrita "de domínio" no banco:
- **Auth**: registro/login, JWT (access + refresh), RBAC (`owner`, `admin`, `operator`,
  `viewer`), escopo por organização.
- **Organizations**: tenant, planos, limites de uso, billing (stub).
- **Contacts**: CRUD, import (delega parsing ao Importer), tags, status de consentimento,
  opt-out, soft-delete.
- **Lists/Segments**: listas estáticas e segmentos dinâmicos (ex.: `ddd IN (11,21)`).
- **Templates**: cadastro e sincronização dos templates aprovados na Meta.
- **Campaigns**: cria a campanha, resolve o público (lista/segmento), **enfileira**
  mensagens (uma linha por destinatário em `outbound_messages`).
- **Webhooks**: recebe callbacks da Meta (status de entrega + mensagens inbound),
  **verifica a assinatura** `X-Hub-Signature-256`, processa opt-out.
- **Privacy (LGPD)**: exportação e exclusão de dados do titular, registro de consentimento.

Por que NestJS: arquitetura modular opinativa (módulos, providers, guards, pipes),
validação com `class-validator`, ótimo para webhooks e I/O assíncrono, e Prisma para um
acesso a dados tipado.

### 2.2 Dispatcher — Go — worker de disparo
O **caminho quente**. Um ou mais processos Go que:
1. fazem *poll* da tabela `outbound_messages` com `FOR UPDATE SKIP LOCKED` (várias
   réplicas sem pisar uma na outra);
2. aplicam **rate limiting** por número/WABA (token bucket) para não estourar os limites
   da Meta;
3. enviam via **Meta Cloud API** (`POST /{phone_number_id}/messages`);
4. tratam **retries com backoff exponencial** e erros recuperáveis vs. permanentes;
5. atualizam `status` (`queued → sending → sent → delivered → read | failed`).

Por que Go: concorrência barata (goroutines), baixo consumo, latência previsível e
excelente para muitos pedidos HTTP simultâneos com controle fino de taxa.

### 2.3 Importer — Python (FastAPI)
Recebe o arquivo enviado pelo cliente e devolve **contatos normalizados + estatísticas**:
- formatos: **CSV, JSON, XLSX** (extensível para TSV, vCard);
- normalização de telefone para **E.164** via `phonenumbers` (port do libphonenumber),
  inferência de país (default BR), extração de **DDD/região**;
- **deduplicação**, detecção de linhas inválidas, mapeamento flexível de colunas
  (`nome/name`, `telefone/phone/celular/whatsapp`...).

Por que Python: `phonenumbers`, `pandas` e `openpyxl` tornam parsing e validação de dados
triviais e robustos.

### 2.4 PostgreSQL — dados + fila
Fonte única de verdade. Esquema multi-tenant com `organization_id` em todas as tabelas de
domínio. A tabela `outbound_messages` é a fila: o Go consome com SKIP LOCKED. Índices
parciais mantêm o poll barato.

## 3. Fluxos principais

### 3.1 Import de contatos
```
Cliente → POST /contacts/import (multipart) → API Gateway
   → encaminha arquivo p/ Importer (POST /parse)
   → Importer devolve {valid[], invalid[], stats}
   → Gateway insere/atualiza contatos (consent_source, consent_at) em transação
   → responde com resumo (importados, duplicados, inválidos)
```

### 3.2 Disparo de campanha
```
Cliente → POST /campaigns {template, audience: lista/segmento, params}
   → Gateway valida saldo/limites e template aprovado
   → resolve público (aplica supressão: opted_out, sem consentimento, inválidos)
   → INSERT em outbound_messages (status=queued) — uma linha por destinatário
   → responde 202 com campaign_id
Dispatcher (Go) → poll SKIP LOCKED → envia → atualiza status
Meta → webhook de status → Gateway atualiza delivered/read/failed
```

### 3.3 Inbound + opt-out
```
Usuário responde "PARAR" no WhatsApp
   → Meta → webhook → Gateway verifica assinatura
   → registra mensagem inbound; se for palavra de opt-out → contato.opted_out=true
   → futuras campanhas suprimem esse contato automaticamente
```

## 4. Contrato REST (resumo)

Base: `http://localhost:3000/api/v1`. Todas as rotas (exceto auth e webhook) exigem
`Authorization: Bearer <access_token>` e operam no escopo da organização do token.

```
POST   /auth/register                 cria org + usuário owner
POST   /auth/login                    → { accessToken, refreshToken }
POST   /auth/refresh

GET    /contacts                      ?search=&ddd=&tag=&consent=&page=
POST   /contacts                      cria 1 contato
PATCH  /contacts/:id                  edita
DELETE /contacts/:id                  remove (soft-delete)
POST   /contacts/import               multipart (CSV/JSON/XLSX) → resumo
POST   /contacts/:id/opt-out          marca opt-out manual

GET    /lists                         listas e segmentos
POST   /lists                         { name, type: static|dynamic, rule? }
POST   /lists/:id/contacts            adiciona contatos a uma lista estática

GET    /templates                     templates sincronizados da Meta
POST   /templates/sync                puxa status de aprovação da Meta

POST   /campaigns                     cria + enfileira disparo
GET    /campaigns/:id                 progresso (queued/sent/delivered/failed)
POST   /campaigns/:id/cancel          cancela mensagens ainda na fila

POST   /messages/send                 envio avulso p/ 1 número (atalho)

POST   /webhooks/whatsapp             (Meta) recebe status + inbound
GET    /webhooks/whatsapp             (Meta) verificação do webhook (hub.challenge)

POST   /privacy/data-requests         { type: export|delete, subjectPhone }
GET    /privacy/data-requests/:id     status da solicitação LGPD
```

## 5. Configurando a Meta Cloud API

1. Crie um app no **Meta for Developers** e adicione o produto **WhatsApp**.
2. Obtenha: `WABA_ID`, `PHONE_NUMBER_ID`, um **token de acesso** (gere um *System User
   token* permanente para produção) e defina um **verify token** para o webhook.
3. Configure o webhook para `https://SEU_DOMINIO/api/v1/webhooks/whatsapp` e assine os
   campos `messages`. Em dev, exponha o gateway com um túnel (ex.: `cloudflared`/`ngrok`).
4. Cadastre e **aprove templates** (Marketing/Utility/Authentication) no painel da Meta.
5. Preencha o `.env` dos serviços `api-gateway` e `dispatcher`:
   ```
   WHATSAPP_GRAPH_API_VERSION=v21.0     # bump conforme a Meta avança (v22/v23...)
   WHATSAPP_PHONE_NUMBER_ID=...
   WHATSAPP_WABA_ID=...
   WHATSAPP_ACCESS_TOKEN=...
   WHATSAPP_APP_SECRET=...               # p/ verificar assinatura do webhook
   WHATSAPP_WEBHOOK_VERIFY_TOKEN=...
   ```

> A **versão do Graph API** é parametrizada via env justamente porque a Meta lança uma
> nova a cada poucos meses. Mantenha em `v21.0` (estável) e suba quando validar a próxima.

## 6. Pricing (modelo atual — desde 01/07/2025)

A Meta cobra **por mensagem de template entregue**, por **categoria** e por **código de
país** do destinatário:
- **Marketing** e **Authentication**: cobradas por mensagem entregue.
- **Utility**: cobrada por mensagem, mas **gratuita dentro da janela de atendimento de 24h**.
- Mensagens de **serviço** (resposta dentro da janela de 24h, sem template): **gratuitas**.

Implicação de produto: a plataforma deve estimar custo **antes** do disparo (nº de
destinatários × tarifa da categoria × país) e expor isso ao cliente. Há um `cost_estimate`
no fluxo de criação de campanha (stub a evoluir com a tabela de tarifas da Meta).

## 7. Por que Postgres como fila (e quando trocar)

`SELECT ... FOR UPDATE SKIP LOCKED` dá uma fila transacional, durável e sem componente
extra — ideal para a fase local e para volumes de milhares–dezenas de milhares/dia.
**Sinais para migrar** para Redis Streams / RabbitMQ / Kafka: necessidade de >~50–100k
msgs/min sustentadas, fan-out para muitos consumidores, ou prioridade/dead-letter
sofisticadas. A interface do `store` no Go isola isso — trocar a fila não toca o resto. Recomendação de banco/fila na AWS: `docs/AWS-DATABASE.md`.

## 8. Observabilidade e operação (planejado)

- **Logs estruturados** (pino no Node, slog no Go, structlog no Python) com `request_id`
  e `organization_id` correlacionados.
- **Métricas** Prometheus: profundidade da fila, taxa de envio, erros por código da Meta,
  latência p95. Painel Grafana.
- **Health checks**: `/health` em cada serviço.
- **Tracing** opcional via OpenTelemetry.

## 9. Decisões em aberto (a confirmar com você)

- Provedor de billing (Stripe vs. gateway nacional como Pagar.me/Asaas) — relevante para BR.
- Armazenamento de mídia das mensagens (S3/MinIO) quando suportarmos imagens/PDF.
- Estratégia de criptografia de PII (campo a campo vs. TDE) — ver `SECURITY-LGPD.md`.

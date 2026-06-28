# Spec — Fatia 1: ligar o painel (mock→live) + criar template

> Data: 2026-06-26 · Status: aprovado para implementação · Origem: backlog CLAUDE.md §10 item 1
> Escopo de uma fatia vertical: **login → contatos → import → campanhas → templates (+ criar template)**.

## 1. Objetivo

Tirar o painel (`services/web`) do modo 100% mock e ligá-lo à API real do gateway,
entregando um fluxo ponta a ponta utilizável **100% local, sem Docker e sem AWS**, sem
credenciais da Meta obrigatórias (o envio real continua atrás do env-gate existente).

Resultado esperado: um usuário registra uma conta, importa contatos de um CSV, vê seus
contatos reais, **cria um template**, cria uma campanha e acompanha o detalhe — tudo contra
o Postgres local via gateway.

## 2. Escopo

### Entra (vai live nesta fatia)
- **Auth**: tela de Login (login + criar conta), token persistido, portão de autenticação.
- **Contatos**: listar/filtrar (busca, DDD, tag, consentimento), editar, excluir (soft), opt-out.
- **Import**: upload de arquivo → resumo (importados/duplicados/inválidos/total).
- **Templates**: galeria (listar) **+ criar template** (corpo + variáveis `{{n}}`).
- **Campanhas**: grid (listar), wizard de criação, tela de detalhe/progresso.
- **Dashboard**: parcial-live — contagem de contatos + últimas campanhas reais; cards de
  KPI agregado e saúde do número ficam como *placeholders* rotulados.

### Fica para a Fatia 2 (fora desta fatia)
- Configurações: **Conexão Meta**, **Equipe (RBAC)**, **Billing** — seguem em mock com selo
  visível "dados de exemplo".
- Endpoints adiados: `GET /channels`, `GET /organizations/members` (+ convite),
  `GET /organizations` (billing/uso), `GET /dashboard/stats` (KPIs agregados).
- `POST /auth/refresh` (há tabela `refresh_tokens` no schema, mas nenhum endpoint usa) —
  fica como dívida conhecida; nesta fatia o token de acesso + localStorage bastam.
- Builder de template com **header/footer/botões** (exige migração aditiva) — a v1 só cobre
  corpo + variáveis.
- Atualização em tempo real do detalhe da campanha (SSE/polling) — o detalhe carrega sob
  demanda e tem botão "atualizar"; a animação ao vivo do mock é removida.

## 3. Decisões de arquitetura (já aprovadas)

1. **Frontend: refatoração incremental.** Quebrar o monólito `Zaplane.jsx` (~750 linhas)
   extraindo **uma tela por vez** conforme a ligação, em vez de wiring no lugar.
2. **Backend: fatia central.** Apenas leitura nova (`GET /campaigns`) + 1 escrita nova
   (`POST /templates`) + enriquecer `GET /campaigns/:id`. **Sem migração de banco.**
3. **Criar template: rascunho-local-primeiro, submissão à Meta env-gated.** Sempre grava o
   rascunho local; só submete à Meta quando houver canal ativo com WABA/token configurados.
4. **Adaptação de shapes numa camada única** (`src/api/adapters.js`) — a UI mantém os nomes
   pt-BR que já usa; o adapter traduz o schema real (em inglês) para esses nomes/rótulos.
5. **Sem framework de teste** nesta fatia (conforme CLAUDE.md §10/§9). Validação por
   build/typecheck + smoke manual.

## 4. Backend (services/api-gateway)

Tudo dentro dos módulos `campaigns` e `templates`. Prefixo global: `/api/v1`.

### 4.1 `GET /campaigns` (novo) — listar campanhas
- **Rota**: `GET /api/v1/campaigns` em `campaigns.controller.ts`. Guard: `JwtAuthGuard`
  (leitura; sem `@Roles`).
- **Query** (novo DTO `QueryCampaignsDto`): `page=1`, `pageSize=20` (máx 100), `status?`.
- **Service** `campaigns.service.list(orgId, q)`: `findMany` com `where {organizationId,
  status?}`, `orderBy createdAt desc`, paginado; `include { template: {select name,
  category}, channel: {select label} }`; `count` em paralelo.
- **Resposta**: `{ items: CampaignRow[], total, page, pageSize }` (mesmo envelope de
  `/contacts`), onde `CampaignRow = { id, name, status, template{name,category}|null,
  channel{label}, totalRecipients, suppressedCount, sentCount, deliveredCount, readCount,
  failedCount, costEstimateCents, scheduledAt, createdAt }`.
  - `costEstimateCents` é `BigInt` no Prisma → serializar como `Number` na resposta.

### 4.2 Enriquecer `GET /campaigns/:id`
- Hoje `progress()` retorna só `{id,status,total,suppressed,sent,delivered,read,failed}`.
- Passar a incluir `name`, `template{name,category}`, `channel{label}`, `scheduledAt`,
  `createdAt`, `costEstimateCents` (via `include`), para a tela de detalhe ficar live.

### 4.3 Relations Prisma (correção — sem migração)
As FKs já existem no SQL (`db/migrations/001_init.sql:193-194`: `campaigns.channel_id →
whatsapp_channels`, `campaigns.template_id → templates`), mas o `schema.prisma` **não
declara** essas relations no model `Campaign`. Adicionar:
- Em `Campaign`: `channel WhatsappChannel @relation(fields:[channelId], references:[id])`
  e `template Template? @relation(fields:[templateId], references:[id])`.
- Back-relations: `campaigns Campaign[]` em `WhatsappChannel` e em `Template`.
- Como as colunas/FKs já existem no banco, isto é declaração Prisma pura — **nenhuma
  migração nova**. Mantém o guardrail CLAUDE.md §9 (schema ↔ Prisma em sincronia).
- Após editar: `npx prisma generate`.

### 4.4 `POST /templates` (novo) — criar template
- **Rota**: `POST /api/v1/templates` em `templates.controller.ts`. Guards:
  `JwtAuthGuard, RolesGuard` com `@Roles('owner','admin','operator')` (escrita). Hoje o
  controller só tem `JwtAuthGuard` — adicionar `RolesGuard` para a rota de criação.
- **DTO** `CreateTemplateDto`:
  - `name`: string, obrigatório, regex `^[a-z0-9_]+$` (regra de nome da Meta: minúsculas,
    dígitos, underscore).
  - `category`: `@IsIn(['MARKETING','UTILITY','AUTHENTICATION'])`.
  - `language?`: string, default `pt_BR`.
  - `body`: string, obrigatório, não vazio.
- **Service** `templates.service.create(orgId, dto)`:
  1. `variablesCount` = contagem de placeholders `{{n}}` distintos no `body`.
  2. Checar unicidade `(organizationId, name, language)` → `ConflictException` se já existe.
  3. Criar a linha local com `status: 'PENDING'` (enum existente; representa "aguardando
     aprovação" tanto para rascunho local quanto submetido).
  4. **Env-gate (best-effort)**: buscar canal ativo do org (`whatsappChannel.findFirst
     status:'active'`); se existir token/WABA utilizáveis e `WHATSAPP_GRAPH_API_VERSION`
     configurado, chamar `POST {graph}/{waba_id}/message_templates` montando `components`
     a partir do `body`+exemplos; gravar `metaTemplateId` retornado. Envolver em try/catch:
     **falha na Meta não desfaz o rascunho local** — retorna o template com um aviso.
  5. Retornar a linha criada.
- **Limitação v1 conhecida**: a Meta exige *example values* para variáveis na submissão;
  a v1 gera exemplos placeholder e registra aviso se a Meta recusar. Refino fica para
  quando houver credenciais reais para testar ponta a ponta.

> `templates.sync` (stub atual) continua sendo o caminho que, no futuro, reconcilia
> `PENDING → APPROVED/REJECTED` puxando da Meta. Fora do escopo desta fatia implementar.

## 5. Frontend (services/web)

### 5.1 Estrutura-alvo (extração incremental de `Zaplane.jsx`)
```
src/
  auth/AuthContext.jsx      # token em localStorage; login/register/logout; usuário atual; 401→logout
  hooks/useResource.js      # GET: {data, loading, error, reload}; mutações: {run, pending, error}
  api/client.js             # (ajuste) token lido/gravado em localStorage; 401 limpa sessão
  api/endpoints.js          # (+) listCampaigns(query), createTemplate(dto)
  api/adapters.js           # (novo) API→UI: nomes de campo + rótulos pt-BR dos enums
  screens/Login.jsx         # form login + alternar "criar conta" (register → org+owner)
  screens/Dashboard.jsx     # parcial-live
  screens/Contatos.jsx      # lista/filtros/ações + ImportModal
  screens/Campanhas.jsx     # grid + NovaCampanha (wizard) + CampanhaDetalhe
  screens/Templates.jsx     # galeria + NovoTemplateModal
  screens/Configuracoes.jsx # mock + selo "dados de exemplo" (Fatia 2)
  Zaplane.jsx               # shell: sidebar + navegação por estado + portão de auth
```
- **Navegação**: mantém a navegação por estado/abas já existente; **sem** adicionar
  `react-router` (YAGNI). Portão de auth = render condicional: sem token → `Login`;
  com token → shell.

### 5.2 Auth e sessão
- `AuthContext` guarda `accessToken` em `localStorage` (persiste entre refreshes). Aceito o
  trade-off de XSS para dev local; nota para migrar a cookie httpOnly + refresh na Fatia 2.
- `client.js`: inicializa `token` a partir do `localStorage`; `setToken` grava lá; em
  resposta **HTTP 401**, limpa o token e o `AuthContext` redireciona ao `Login`.
- Seed **não cria usuário** → a tela traz **criar conta** (register cria org+owner). Sem
  usuário de dev no seed (default escolhido).

### 5.3 Camada adaptadora (`api/adapters.js`)
Traduz o schema real para o que a UI já espera, num único lugar:
- **Contato**: `name→nome`, `phoneE164→tel`, `region→regiao`, `tags→tag`, `consentStatus→consent`.
  Rótulos consent: `granted→consentido`, `pending→pendente`, `denied→negado`,
  `opted_out→optout`, `unknown→desconhecido`.
- **Campanha**: status `draft→rascunho`, `scheduled→agendada`, `queuing→enfileirando`,
  `sending→enviando`, `completed→concluida`, `failed→falha`, `canceled→cancelada`;
  contadores `sentCount→enviadas`, `deliveredCount→entregues`, `readCount→lidas`,
  `failedCount→falhas`, `totalRecipients→total`.
- **Template**: `category` `MARKETING→Marketing`/`UTILITY→Utility`/`AUTHENTICATION→Authentication`;
  `status` `APPROVED→aprovado`/`PENDING→em_analise`/`REJECTED→rejeitado`/`DISABLED→desativado`;
  `language→idioma`, `body→corpo`. **`botoes`: vazio** (schema não guarda botões na v1) —
  o preview sinaliza ausência de botões.

### 5.4 Telas (ligação)
- **Dashboard**: contagem de contatos (`GET /contacts?pageSize=1` → `total`) + últimas
  campanhas (`GET /campaigns?pageSize=5`). KPIs agregados e card de saúde do número ficam
  como placeholders rotulados "em breve".
- **Contatos**: `GET /contacts` com filtros via query; ações `PATCH`/`DELETE`/opt-out.
  Paginação real (estado de página). **ImportModal**: `POST /contacts/import` (multipart
  file + consentStatus + consentSource + defaultCountry) → mostra `{imported, duplicates,
  invalid, total}`.
- **Templates**: `GET /templates` na galeria; botão **"Novo template"** abre modal (nome
  com validação `^[a-z0-9_]+$`, categoria, idioma default pt_BR, corpo com dica `{{1}}` e
  preview do balão). Submit → `createTemplate` → recarrega; novo aparece como "Em análise".
- **Campanhas**: grid via `GET /campaigns`; **NovaCampanha** (wizard) usa `GET /lists` +
  `GET /templates` (aprovados) e `POST /campaigns`; **CampanhaDetalhe** via
  `GET /campaigns/:id` + `POST /campaigns/:id/cancel`.

### 5.5 Loading / erro / vazio
Padrão único via `useResource`: skeleton/spinner ao carregar; banner de erro (usa a
mensagem que `client.js` já formata: `HTTP <status> — <detalhe>`) com "tentar de novo";
estado vazio explícito ("nenhum contato ainda"). Mutações desabilitam o botão e mostram
erro inline.

## 6. Contratos relevantes (referência, conforme código atual)

```
POST /api/v1/auth/register {organizationName,name,email,password} → {accessToken,refreshToken,user{id,email,role,organizationId}}
POST /api/v1/auth/login    {email,password}                       → idem
GET  /api/v1/contacts?search&ddd&tag&consent&page&pageSize        → {items,total,page,pageSize}
POST /api/v1/contacts/import (multipart: file,consentStatus,consentSource,defaultCountry) → {imported,duplicates,invalid,total,consentSource}
GET  /api/v1/lists                                                → [List]
GET  /api/v1/templates                                            → [Template]
POST /api/v1/templates {name,category,language?,body}             → Template (status PENDING)        [NOVO]
POST /api/v1/campaigns {name,channelId,templateId,listId?|audienceRule?,templateParams?,scheduledAt?} → {campaignId,totalRecipients,suppressed,costEstimateCents,status}
GET  /api/v1/campaigns?page&pageSize&status                       → {items,total,page,pageSize}      [NOVO]
GET  /api/v1/campaigns/:id                                        → {id,name,status,template,channel,total,suppressed,sent,delivered,read,failed,costEstimateCents,createdAt,scheduledAt}  [ENRIQUECIDO]
POST /api/v1/campaigns/:id/cancel                                 → {canceled}
```

## 7. Verificação (sem framework de teste)

Pré-requisitos do smoke: Postgres local com `001_init.sql` aplicado, gateway (`:3000`) e
importer (`:8000`) rodando, web (`:5173`).

1. `cd services/api-gateway && npx prisma generate && npm run build` (TS compila, client ok).
2. `cd services/web && npm run build` (front compila).
3. **Smoke manual** ponta a ponta:
   - Registrar conta nova → cair no painel autenticado (token persiste no refresh).
   - Importar `scripts/sample-contacts.csv` → ver resumo e os contatos na lista.
   - Filtrar contatos por DDD/consentimento; editar e opt-out de um contato.
   - **Criar um template** (corpo com `{{1}}`) → aparece como "Em análise".
   - Criar uma campanha pelo wizard → ver detalhe com contadores e custo.
4. 401 expirado → volta ao Login.

## 8. Decisões resolvidas / defaults

- **Usuário de dev no seed**: NÃO (registro cria a conta).
- **Teste e2e do `GET /campaigns`**: NÃO (só smoke manual, conforme CLAUDE.md).
- **react-router**: NÃO (navegação por estado existente).
- **Persistência de token**: `localStorage` (dev local).

## 9. Riscos e mitigação

- **Submissão Meta sem credenciais**: env-gate garante que a ausência de creds não quebra a
  criação local (try/catch; rascunho sempre salvo).
- **BigInt na serialização** (`costEstimateCents`): converter para `Number` antes de retornar.
- **Mismatch de shape**: centralizado em `adapters.js` — um único ponto a manter quando o
  schema mudar.
- **Monólito durante a transição**: extrair tela a tela mantém o app sempre compilando;
  cada tela ligada remove seu bloco de mock correspondente.

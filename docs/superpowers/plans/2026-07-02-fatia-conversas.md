# Fatia Conversas (inbox 1:1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
> Steps use checkbox (`- [ ]`) syntax.

**Goal:** Tela de Conversas (inbox 1:1) com janela de 24h visível e composer inteligente,
sobre os dados que o webhook já grava (`inbound_messages`) + fila (`outbound_messages`).

**Architecture:** Módulo novo `conversations` no gateway (3 rotas GET, leitura pura, SQL
cru parametrizado — `inbound_messages` não tem model Prisma). Frontend: tela nova de duas
colunas com polling de 5 s; badges de janela no modal de mensagem e na lista de Contatos.
Nenhum endpoint novo de escrita (responder usa `/messages/text` e `/messages/send`).

**Tech Stack:** NestJS 10 + Prisma ($queryRawUnsafe posicional) · React 18 + Vite.

## Global Constraints

- Multi-tenancy: `organizationId` do JWT; TODO SQL cru filtra por `organization_id = $1`
  com parâmetros posicionais — NUNCA interpolar telefone/valores na string SQL.
- Sem migração de banco. Sem framework de teste (verificação = build + curl + smoke SQL).
- Sem libs novas no front. Strings/comentários em português. Prefixo `/api/v1`.
- Janela: `windowExpiresAt = MAX(inbound.received_at) + 24h`; `windowOpen = expiresAt > now`.
- Preview de outbound (payload JSONB): `COALESCE(payload->'text'->>'body',
  '[template] ' || (payload->'template'->>'name'), '[mensagem]')`.
- `:phone` nas rotas = E.164 SEM `+` (só dígitos); servidor normaliza para `+` + dígitos.

---

### Task A1: Módulo `conversations` no gateway

**Files:**
- Create: `services/api-gateway/src/conversations/conversations.service.ts`
- Create: `services/api-gateway/src/conversations/conversations.controller.ts`
- Create: `services/api-gateway/src/conversations/conversations.module.ts`
- Modify: `services/api-gateway/src/app.module.ts` (registrar o módulo)

**Interfaces (Produces):**
- `GET /api/v1/conversations` → `{ items: [{ phone, name, contactId, lastMessage: { direction:'in'|'out', preview, at }, lastInboundAt, windowOpen, windowExpiresAt }] }` (ordem: última atividade desc, LIMIT 100)
- `GET /api/v1/conversations/:phone/messages` → `{ contact: {id,name}|null, windowOpen, windowExpiresAt, items: [{ id, direction, body, type, status, at }] }` (asc; últimas 200 — buscar DESC LIMIT 200 e inverter no TS)
- `GET /api/v1/conversations/windows` → `{ items: [{ phone, lastInboundAt, windowExpiresAt }] }`

- [ ] **Step 1: Service com 3 métodos usando `$queryRawUnsafe` posicional** (padrão de
  `campaigns.service.resolveAudience`). SQL da lista:

```sql
WITH msgs AS (
  SELECT from_phone_e164 AS phone, body AS preview, 'in' AS direction, received_at AS at
    FROM inbound_messages WHERE organization_id = $1
  UNION ALL
  SELECT to_phone_e164 AS phone,
         COALESCE(payload->'text'->>'body', '[template] ' || (payload->'template'->>'name'), '[mensagem]') AS preview,
         'out' AS direction, created_at AS at
    FROM outbound_messages WHERE organization_id = $1
), last_msg AS (
  SELECT DISTINCT ON (phone) phone, preview, direction, at FROM msgs ORDER BY phone, at DESC
), last_in AS (
  SELECT from_phone_e164 AS phone, MAX(received_at) AS last_inbound_at
    FROM inbound_messages WHERE organization_id = $1 GROUP BY 1
)
SELECT lm.phone, lm.preview, lm.direction, lm.at, li.last_inbound_at, c.id AS contact_id, c.name
  FROM last_msg lm
  LEFT JOIN last_in li ON li.phone = lm.phone
  LEFT JOIN contacts c ON c.organization_id = $1 AND c.phone_e164 = lm.phone AND c.deleted_at IS NULL
 ORDER BY lm.at DESC LIMIT 100;
```

  Thread (`$2` = telefone normalizado `+dígitos`): UNION dos dois lados com
  `ORDER BY at DESC LIMIT 200`, invertido no TS; campos `id::text, direction, body
  (inbound.body | preview do payload), type (inbound.type | payload->>'type'),
  status (NULL | outbound.status), at`. Janela/contato calculados no TS
  (consultas auxiliares: MAX(received_at) e contato por phone). Windows: o SQL de
  `last_in` sozinho. Cálculo da janela em helper único
  `janela(lastInboundAt): { windowOpen, windowExpiresAt }` (+24h; null se nunca).

- [ ] **Step 2: Controller** `@Controller('conversations')` + `@UseGuards(JwtAuthGuard)`;
  rotas `@Get()`, `@Get('windows')` (ANTES de `:phone` p/ não colidir),
  `@Get(':phone/messages')` com normalização `'+' + phone.replace(/\D/g,'')`.
- [ ] **Step 3: Module + registro** no `app.module.ts` (imports).
- [ ] **Step 4: Verificar** `npm run build`; com o gateway dev no ar, `curl` das 3 rotas
  com token (org de teste) — sem inbound ainda, `GET /conversations` deve listar as
  conversas dos envios feitos (outbound) com `windowOpen:false`.
- [ ] **Step 5: Commit** (mensagem pt-BR + trailer Co-Authored-By padrão do repo).

---

### Task B1: Tela Conversas + navegação + endpoints do front

**Files:**
- Modify: `services/web/src/api/endpoints.js` (+3 funções)
- Create: `services/web/src/screens/Conversas.jsx`
- Modify: `services/web/src/components/ui.jsx` (NAV + ícone `MessagesSquare`)
- Modify: `services/web/src/Zaplane.jsx` (TITLES + render da tela)

**Interfaces:**
- Consumes: rotas da A1; `sendText` existente; `EnviarMensagemModal` existente.
- Produces: `listConversations()`, `getConversation(phone)` (phone SEM `+` na URL:
  `encodeURIComponent(tel.replace(/\D/g,""))`), `getWindows()`; tela `Conversas`
  (default export) com props `{}` (autossuficiente).

- [ ] **Step 1: endpoints.js** — `listConversations()`, `getConversation(phone)`,
  `getWindows()`.
- [ ] **Step 2: Conversas.jsx** — duas colunas (lista 320px / thread flex):
  - Polling: `const [tick,setTick]=useState(0)` + `setInterval 5000` em `useEffect`
    (com clearInterval no unmount); `useResource(() => listConversations(), [tick])` e
    `useResource(() => sel ? getConversation(sel) : Promise.resolve(null), [sel, tick])`.
    Renderizar a partir de `data` (que persiste entre reloads) — spinner SÓ quando
    `!data && loading` (evita flicker do polling).
  - Lista: avatar iniciais, nome (ou telefone), prévia truncada, horário relativo,
    selo 🟢/⚪ (countdown "expira em Xh Ym" de `windowExpiresAt`).
  - Thread: bolhas `direction==='in'` à esquerda (fundo claro) / `'out'` à direita
    (verde WhatsApp, como o `WhatsAppBubble` mas simplificado inline), horário
    pequeno; outbound mostra status (`sent/delivered/read/failed`) discreto.
  - Composer: `windowOpen` → textarea + botão enviar → `sendText({phone: conv.phone,
    text})` → limpa e `setTick(k=>k+1)`; `!windowOpen` → banner "Janela fechada —
    inicie com um template" + botão que abre `EnviarMensagemModal`
    (`contato={{nome, tel: conv.phone, ...}}`).
  - Vazio: "Nenhuma conversa ainda — dispare um template para começar."
- [ ] **Step 3: NAV/shell** — `ui.jsx`: item `{ id:"conversas", label:"Conversas",
  icon: MessagesSquare }` após Contatos (importar ícone). `Zaplane.jsx`: TITLES
  `conversas: ["Conversas","Responda na janela de 24h ou inicie com template"]` +
  `{screen==="conversas" && <Conversas />}` + import.
- [ ] **Step 4: Verificar** `npm run build` verde.
- [ ] **Step 5: Commit.**

---

### Task B2: Janela nos pontos de envio (modal + Contatos)

**Files:**
- Modify: `services/web/src/components/EnviarMensagemModal.jsx`
- Modify: `services/web/src/screens/Contatos.jsx`

**Interfaces:** Consumes `getWindows()` (B1) — array `{phone,lastInboundAt,windowExpiresAt}`.

- [ ] **Step 1: Modal** — ao abrir, `useResource(() => getWindows(), [])`; localizar o
  telefone do contato (comparar dígitos); se janela aberta: `useEffect` inicial seta
  `modo="texto"` e mostra selo 🟢 no cabeçalho ("janela aberta — expira em Xh Ym");
  fechada: mantém `modo="template"` + selo ⚪. NÃO travar o usuário: as abas continuam
  clicáveis (só muda o padrão).
- [ ] **Step 2: Contatos** — buscar `getWindows()` uma vez por carga
  (`useResource(..., [reloadKey])`); mapa `dígitos(phone) → windowExpiresAt`; na linha,
  badge 🟢 pequeno ao lado do telefone quando aberta (title com o countdown).
- [ ] **Step 3: Verificar** `npm run build`; **Step 4: Commit.**

---

### Task C1: Smoke com inbound simulado (controlador executa)

- [ ] INSERT via psql em `inbound_messages` (org de teste, from `+5585992999777`,
  body "oi, quero saber mais", received_at now()).
- [ ] `curl` `GET /conversations` → conversa com `windowOpen:true`; `GET
  /conversations/5585992999777/messages` → thread com inbound + outbound históricos.
- [ ] Painel: tela Conversas mostra a conversa 🟢; composer em texto livre; enviar
  texto → nova linha `queued` em `outbound_messages` (com token expirado o envio à
  Meta falha depois — esperado; o smoke valida o ENFILEIRAMENTO).
- [ ] Modal do contato pré-seleciona "Texto livre"; Contatos mostra badge 🟢.
- [ ] Builds finais verdes.

## Notas de execução
- Ordem: A1 → B1 → B2 → C1 (B2 depende de B1; tudo depende de A1).
- Webhook real (túnel + Meta) fica FORA do plano de código: runbook pendente do token
  de System User do usuário.

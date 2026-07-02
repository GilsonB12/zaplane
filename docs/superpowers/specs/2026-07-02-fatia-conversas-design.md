# Spec — Fatia Conversas (inbox 1:1)

> Data: 2026-07-02 · Status: aprovado pelo usuário · Origem: necessidade de texto livre
> ("não quero depender da janela") — a janela é regra da Meta; esta fatia a torna
> visível e utilizável. Metade já existe: o webhook grava tudo em `inbound_messages`.

## 1. Objetivo

Transformar o Zaplane de via de mão única (só dispara) em plataforma de conversa:
ver respostas dos contatos, saber quando a janela de 24h está aberta, e responder
com texto livre (grátis) ou template (curinga) sem o usuário ter que pensar na regra.

Ciclo destravado: template abre a conversa → contato responde (webhook grava; janela
abre) → conversa livre pela tela Conversas → cada resposta renova as 24h.

## 2. Escopo

### Entra
1. **Tela "Conversas"** (novo item na sidebar, entre Contatos e Nova campanha):
   duas colunas — lista de conversas à esquerda (contato/telefone + prévia da última
   mensagem + horário + selo da janela), thread à direita estilo WhatsApp
   (recebidas à esquerda, enviadas à direita, com horário e, nas enviadas, status).
   **Composer inteligente** no rodapé: janela aberta → textarea de texto livre
   (envia via `POST /messages/text`); janela fechada → aviso + atalho para enviar
   template (abre o `EnviarMensagemModal` no modo template).
2. **Indicador de janela de 24h**: `🟢 aberta — expira em Xh Ym` / `⚪ fechada`.
   Regra: `expiresAt = MAX(inbound.received_at) + 24h`; aberta se `expiresAt > now`.
   Aparece: na lista/thread de Conversas, na lista de Contatos (badge discreto) e no
   `EnviarMensagemModal` (que passa a **pré-selecionar o modo** conforme a janela).
3. **Atualização quase-real**: polling (5 s) na tela de Conversas (lista + thread
   aberta). SSE fica para depois (backlog CLAUDE.md item 5).
4. **Webhook (pré-requisito operacional)**: religar túnel + configurar na Meta.
   Runbook, não código — depende do token do usuário. Para desenvolvimento/smoke,
   inbound pode ser simulado por INSERT em `inbound_messages`.

### Fica de fora
- SSE/tempo real de verdade; mídia (imagem/áudio) na thread (mostra `[tipo]`);
  busca dentro da conversa; múltiplos atendentes/atribuição; notificações.

## 3. Backend (gateway) — módulo novo `conversations`

`inbound_messages` NÃO tem model Prisma (convenção do projeto: `$queryRaw`).
Conversa = telefone E.164 distinto na união inbound/outbound do org.

Rotas (todas `JwtAuthGuard`; org do JWT):
1. **`GET /conversations`** — lista agregada por telefone:
   `[{ phone, name (do contacts por phone, senão null), contactId?,
   lastMessage { direction: 'in'|'out', preview, at }, lastInboundAt,
   windowOpen, windowExpiresAt }]`, ordenada por última atividade desc, limite 100.
   SQL: UNION de inbound (from_phone_e164, body, received_at) e outbound
   (to_phone_e164, preview do payload, created_at) agrupado por telefone.
2. **`GET /conversations/:phone/messages`** — thread (asc, últimas 200):
   `[{ id, direction, body, type, status?, at }]`. `:phone` = E.164 **sem** o `+`
   (só dígitos; normalizado no servidor). Preview/body do outbound extraído do
   payload JSONB: `text.body` quando type=text; senão `[template] {name}`.
   Resposta inclui também `{ windowOpen, windowExpiresAt, contact? }`.
3. **`GET /conversations/windows`** — mapa leve p/ badges em lote:
   `[{ phone, lastInboundAt, windowExpiresAt }]` (uma linha por telefone com inbound).

Responder = endpoints existentes (`POST /messages/text`, `POST /messages/send`) —
nenhum endpoint novo de escrita.

## 4. Frontend

- `screens/Conversas.jsx`: duas colunas; seleção de conversa; polling 5 s
  (lista + thread ativa; `useResource` com `reloadKey` de intervalo); composer
  inteligente; estado vazio ("Nenhuma conversa ainda — dispare um template…").
- `components/ui.jsx`: item **Conversas** no `NAV` (ícone `MessagesSquare`).
- `Zaplane.jsx`: rota/título da nova tela.
- `components/EnviarMensagemModal.jsx`: consulta `GET /conversations/windows`
  (ou o item do telefone) e pré-seleciona o modo; selo da janela no cabeçalho.
- `screens/Contatos.jsx`: badge 🟢 discreto na linha quando a janela do contato
  está aberta (dados de `GET /conversations/windows`, 1 chamada por carga).
- `api/endpoints.js`: `listConversations()`, `getConversation(phone)`,
  `getWindows()`.

## 5. Verificação (sem framework de teste)

Builds verdes (gateway + web). Smoke com inbound simulado por SQL:
INSERT em `inbound_messages` para o contato de teste → conversa aparece na tela,
janela 🟢 com countdown, texto livre enfileira em `outbound_messages`,
modal pré-seleciona "Texto livre"; sem inbound → janela ⚪ e modal em "Template".
Webhook real: runbook (túnel + Meta) quando o usuário fornecer o token.

## 6. Riscos e decisões

- **Sem model Prisma p/ inbound**: SQL cru parametrizado (`$queryRaw` com
  placeholders) — nunca interpolar telefone na string.
- **Payload variado no outbound**: extração defensiva do preview (text.body →
  template.name → `[mensagem]`).
- **Polling**: 5 s só com a tela aberta; para ao desmontar (clearInterval).
- **Telefones sem contato** (inbound de desconhecido): conversa aparece com o
  número como título — não cria contato automaticamente (fica para depois).

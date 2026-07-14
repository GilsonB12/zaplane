# Spec — Fatia 3: "Conectar número" (Embedded Signup + manual)

> Data: 2026-07-10 · Status: aprovado pelo usuário · Pré-requisitos concluídos:
> empresa verificada na Meta ✅ · app de produção "Zaplane" criado (ID 1014019114699465) ✅ ·
> configuração de Embedded Signup criada (config_id 1749172849496870, token 60 dias,
> tarefas completas) ✅ · permissões `whatsapp_business_*` "Pronto para teste" (dev mode) ✅.

## 1. Objetivo

Tornar o Zaplane autônomo: o próprio cliente conecta o número WhatsApp dele pela tela
Configurações → Conexão, por dois caminhos — **Embedded Signup** (popup oficial da Meta,
zero credencial manual; padrão da indústria: Wati/360dialog/AiSensy) e **manual
(concierge)** (colar credenciais, com validação e automação do webhook). Este fluxo é
também o material exigido pelo App Review (vídeo demonstrando as permissões em uso).

## 2. Escopo

### Entra
1. **Tela Configurações → Conexão Meta live**: lista de canais do org (número, nome,
   via de conexão, status, qualidade), desconectar (com confirmação), botão
   **"Conectar WhatsApp"** (ES) e **"Conectar manualmente"** (modal).
2. **Backend `channels`**: GET (mascarado), POST manual (pipeline), POST es/exchange,
   DELETE (desativa).
3. **Cifragem em repouso** de `access_token_enc` e `app_secret_enc` (AES-256-GCM,
   util existente) — Node cifra ao gravar; Node e **Go** decifram com fallback para
   texto puro (legado continua funcionando).
4. **Webhook com assinatura por canal** (multi-cliente).
5. **Migração aditiva 003** em `whatsapp_channels`.

### Fica fora
- Renovação automática do token de 60 dias do ES (Fatia 4 — via
  `/{business}/system_user_access_tokens` + `appsecret_proof`, doc já mapeada).
- Seletor de canal no wizard de campanha (envio segue usando o 1º canal ativo).
- Registro/verificação de número por PIN via API (`/{phone}/register`) — o ES cuida
  do registro no próprio popup; modal manual documenta como pré-requisito.
- Billing/linha de crédito (modelo Solution Partner).

## 3. Banco — migração `003_channels_connect.sql` (aditiva)

```sql
ALTER TABLE whatsapp_channels
  ADD COLUMN IF NOT EXISTS app_id        TEXT,
  ADD COLUMN IF NOT EXISTS app_secret_enc TEXT,
  ADD COLUMN IF NOT EXISTS connected_via TEXT NOT NULL DEFAULT 'manual'
    CHECK (connected_via IN ('manual','embedded_signup','bootstrap'));
```
Canais existentes ficam `connected_via='manual'` (aceitável). Após aplicar: atualizar
`schema.prisma` (3 campos) + `prisma generate`. Regra do CLAUDE.md: migração é aditiva,
schema SQL é a fonte de verdade.

## 4. Cifragem ponta a ponta

- `APP_ENCRYPTION_KEY` (base64, 32 bytes) passa a ser obrigatória nos `.env` do
  gateway **e do dispatcher** (mesma chave). Gerada nesta fatia.
- **Node**: `encrypt()` (crypto.util, formato `ivB64:tagB64:cipherB64`) aplicado ao
  gravar canal (token e app secret). Leituras usam o padrão `readToken` já existente
  (tenta decifrar; se falhar, usa como texto puro — legado).
- **Go (dispatcher)**: `resolveToken` aprende AES-256-GCM: se o valor tem formato
  `a:b:c` base64 e a chave está no env, decifra; senão comporta-se como hoje
  (texto puro / fallback env). Falha de decrypt → fallback texto puro (não derruba envio).
- Canal de teste atual será **re-cifrado** na validação (T7) para provar o ciclo.

## 5. Backend — módulo `channels`

Rotas (JwtAuthGuard; escrita com `@Roles('owner','admin')`):

1. **`GET /channels`** → `{ items: [{ id, label, displayNumber, phoneNumberId, wabaId,
   connectedVia, status, qualityRating, createdAt }] }` — **nunca** retorna token/secret
   (nem mascarado: simplesmente omitidos).
2. **`POST /channels/manual`** — body `{ label, phoneNumberId, wabaId, accessToken,
   appId, appSecret }`. Pipeline com erro claro por etapa (resposta inclui `etapas:
   [{passo, ok, detalhe?}]`):
   a. `debug_token` na Graph: token válido? escopos contêm `whatsapp_business_messaging`
      e `_management`? `expires_at` (0 = ok; >0 → aceita com aviso `tokenExpiraEm`).
   b. `GET /{wabaId}?fields=id,name` com o token → acesso à WABA confirmado.
   c. `GET /{phoneNumberId}?fields=id,display_phone_number,quality_rating` → número
      pertence/acessível; captura display e qualidade.
   d. Webhook do app do cliente: `POST /{appId}/subscriptions` (token `appId|appSecret`)
      com `object=whatsapp_business_account`, `callback_url` = URL pública do gateway
      (`WEBHOOK_PUBLIC_URL` no env; ex.: https://ruckus-daylong-pushpin.ngrok-free.dev
      /api/v1/webhooks/whatsapp), `verify_token` = `whatsapp.webhookVerifyToken`,
      `fields=messages`. (A Meta faz o handshake GET na hora.)
   e. `POST /{wabaId}/subscribed_apps` com o token do cliente.
   f. Grava canal: token e appSecret **cifrados**, `connected_via='manual'`,
      `status='active'`, display/quality do passo c.
   g. Dispara `templates.sync` (best-effort; falha não desfaz o canal).
3. **`POST /channels/es/exchange`** — body `{ code, wabaId, phoneNumberId }` (vindos do
   popup). Pipeline:
   a. `GET /oauth/access_token?client_id={ZAPLANE_FB_APP_ID}&client_secret=
      {ZAPLANE_FB_APP_SECRET}&code={code}` → business token do cliente.
   b. Passos b/c do manual (validar WABA/número com o token novo).
   c. `POST /{wabaId}/subscribed_apps` com o business token (inscreve NOSSO app; o
      webhook do app Zaplane é global — configurado uma vez no painel/API, não por
      cliente).
   d. Grava canal cifrado: `connected_via='embedded_signup'`, `app_id=ZAPLANE_FB_APP_ID`,
      `app_secret_enc=null` (assinatura valida com o secret global do Zaplane).
   e. `templates.sync` best-effort.
4. **`DELETE /channels/:id`** → `status='disabled'` (histórico preservado). Não
   remove inscrição na Meta (decisão: desconectar do Zaplane ≠ desconfigurar a conta
   do cliente; documentado na UI).

Env novos (gateway): `ZAPLANE_FB_APP_ID` ✅, `ZAPLANE_FB_APP_SECRET` (pendente do
usuário — bloqueia só o teste do ES, não a construção), `ZAPLANE_ES_CONFIG_ID` ✅,
`WEBHOOK_PUBLIC_URL`, `APP_ENCRYPTION_KEY`.

## 6. Webhook — assinatura por canal

`validSignature` (webhooks.service) vira duas fases:
1. Tenta o secret global (`whatsapp.appSecret` — cobre canais ES e legado). Bater → ok.
2. Falhou: parseia o body (JSON já disponível cru), extrai
   `entry[].changes[].value.metadata.phone_number_id`, busca canal com `app_secret_enc`
   preenchido, decifra e valida contra ele. Sem match → 403 (como hoje).
Cache simples em memória (Map phone_number_id → secret decifrado, TTL 5 min) para não
decifrar a cada evento.

## 7. Frontend

- **`screens/Configuracoes.jsx`** — aba Conexão live: `useResource(listChannels)`;
  cards com número/label/via/status/qualidade; desconectar com `window.confirm`;
  banner "dados de exemplo" REMOVIDO da aba Conexão (Equipe/Billing continuam mock).
- **Modal "Conectar manualmente"** (`components/ConectarManualModal.jsx`): 6 campos +
  guia passo a passo colapsável de onde tirar cada valor; submit mostra o pipeline
  por etapa (validando token… ✓ · conferindo WABA… ✓ · configurando webhook… ✗ msg);
  sucesso → recarrega lista.
- **Botão "Conectar WhatsApp"** (`components/ConectarWhatsAppButton.jsx`): carrega o
  SDK JS do Facebook sob demanda (`https://connect.facebook.net/pt_BR/sdk.js`,
  `FB.init({appId: VITE_FB_APP_ID, version: 'v25.0'})`); listener de
  `message` p/ capturar `WA_EMBEDDED_SIGNUP` (session info: `waba_id`,
  `phone_number_id`); `FB.login(cb, {config_id: VITE_ES_CONFIG_ID,
  response_type: 'code', override_default_response_type: true})`; com `code` +
  session info → `POST /channels/es/exchange` → recarrega lista. Estados: SDK
  carregando, popup aberto, trocando código, sucesso/erro. Avisos de UX (da pesquisa
  de mercado): concluir o popup de uma vez (sessão expira em 1h), estar logado no
  Business Manager certo, o número recebe SMS/ligação de verificação.
  Env ausente (`VITE_ES_CONFIG_ID`) → botão desabilitado com tooltip "aguardando
  configuração".
- **`api/endpoints.js`**: `listChannels()`, `connectChannelManual(dto)`,
  `esExchange(dto)`, `disconnectChannel(id)`.

## 8. Verificação (builds + testes reais; sem framework de teste)

1. Builds: gateway (nest), web (vite), **dispatcher (go build)**.
2. Migração aplicada no banco local; `prisma generate` ok.
3. **Teste real do pipeline manual**: desconectar o canal de teste atual e reconectar
   a WABA de teste **pela API do pipeline** (curl) com as credenciais reais (app
   "teste" + token System User permanente) → canal salvo **cifrado** → enviar um
   template → **entregue** (prova o decrypt do Go) → webhook segue recebendo status.
4. **Assinatura por canal**: evento simulado assinado com o secret do canal → 200;
   assinatura inválida → 403.
5. **ES em modo dev**: quando o usuário fornecer o App Secret do app Zaplane —
   teste manual no navegador (popup com as contas dele) e gravação do vídeo p/ review.

## 9. Riscos e decisões

- **HTTPS no popup**: SDK do FB pode recusar `http://localhost` → plano B pronto:
  túnel ngrok apontado para o web (5173); o proxy do Vite repassa `/api` ao gateway,
  então painel + webhook funcionam no mesmo domínio https.
- **Token ES expira em 60 dias** (limitação do modelo da Meta): aceito; monitorar +
  renovar é Fatia 4. `debug_token` no pipeline registra `tokenExpiraEm` no canal…
  (guardado em log/resposta; coluna própria fica p/ F4 — YAGNI).
- **Segredos**: jamais logar token/secret; respostas de API nunca os incluem.
- **DELETE não desinscreve na Meta**: decisão explícita (não destruir config do
  cliente); documentado no confirm da UI.

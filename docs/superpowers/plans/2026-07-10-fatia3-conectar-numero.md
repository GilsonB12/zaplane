# Fatia 3 — "Conectar número" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Cliente conecta o próprio número na tela Configurações→Conexão (Embedded
Signup + manual), com tokens cifrados em repouso e webhook multi-cliente.

**Spec:** `docs/superpowers/specs/2026-07-10-fatia3-conectar-numero-design.md` (fonte
de requisitos — cada task referencia as seções relevantes).

**Tech:** NestJS+Prisma (gateway) · Go (dispatcher) · React/Vite (web) · Postgres.

## Global Constraints

- Multi-tenancy: org do JWT; SQL cru com `::uuid`; segredos NUNCA em logs/respostas.
- Migração SÓ aditiva (`003_*.sql`); schema SQL é fonte de verdade; `prisma generate` após.
- Sem framework de teste (verificação = builds + curl + teste real). Strings pt-BR.
- Cifragem: formato `ivB64:tagB64:cipherB64` (crypto.util existente); leitura SEMPRE
  com fallback texto puro (legado não pode quebrar).
- Env gateway: `ZAPLANE_FB_APP_ID` ✅ · `ZAPLANE_FB_APP_SECRET` (pendente — só bloqueia
  teste ES) · `ZAPLANE_ES_CONFIG_ID` ✅ · `WEBHOOK_PUBLIC_URL` · `APP_ENCRYPTION_KEY`.
- Ordem: T1 → T2 → T3 → T4 → T5 → T6 → T7 → review final. Commits por task.

---

### T1: Fundação — migração 003 + chave + config

**Files:** Create `db/migrations/003_channels_connect.sql` · Modify
`services/api-gateway/prisma/schema.prisma` (+3 campos em WhatsappChannel) ·
Modify `services/api-gateway/src/config/configuration.ts` (+ `zaplane: {appId,
appSecret, esConfigId}`, `webhookPublicUrl`) · `.env` gateway/dispatcher (chave).

**Steps:** (1) SQL do spec §3; aplicar com psql no banco local. (2) schema.prisma:
`appId String? @map("app_id")`, `appSecretEnc String? @map("app_secret_enc")`,
`connectedVia String @default("manual") @map("connected_via")`; `npx prisma generate`.
(3) Gerar `APP_ENCRYPTION_KEY` (32 bytes base64) e escrever nos DOIS `.env` (gateway
e dispatcher; mesma chave). (4) configuration.ts lê os envs novos. (5) build gateway.
(6) Commit (sem os `.env`).

### T2: Decrypt AES-GCM no dispatcher (Go)

**Files:** Modify `services/dispatcher/internal/worker/worker.go` (resolveToken) ·
Create `services/dispatcher/internal/crypto/crypto.go`.

**Interface:** `crypto.Decrypt(enc, keyB64 string) (string, error)` — espera
`ivB64:tagB64:cipherB64`; AES-256-GCM (Go: `cipher.NewGCM`, ciphertext = cipher||tag →
atenção: Node `createCipheriv` separa tag; em Go, `gcm.Open` espera cipher+tag
concatenados → decodificar as 3 partes e passar `append(cipherBytes, tagBytes...)`).
`resolveToken`: se valor contém exatamente 2 ':' e `APP_ENCRYPTION_KEY` setada →
tenta Decrypt; sucesso → usa; erro → segue fluxo atual (texto puro/fallback env).
Config.go: + `EncryptionKey` (`APP_ENCRYPTION_KEY`). Cache de canal: TTL — NÃO nesta
task (registrado; restart manual documentado). Verify: `go vet ./...` + `go build ./...`
+ teste unitário manual via `go run` de um snippet? NÃO — validação real na T7.
Commit.

### T3: Módulo `channels` (backend)

**Files:** Create `services/api-gateway/src/channels/{channels.module,channels.controller,channels.service}.ts` + `dto/{connect-manual.dto,es-exchange.dto}.ts` · Modify `app.module.ts`.

Implementar o spec §5 na íntegra: GET (campos whitelistados, sem segredos) · POST
`/channels/manual` (pipeline a–g com `etapas[]` na resposta; axios; `debug_token` via
token `appId|appSecret` p/ `access_token` param; cifrar com `encrypt()` do crypto.util)
· POST `/channels/es/exchange` (oauth/access_token com creds Zaplane do config; se
`ZAPLANE_FB_APP_SECRET` vazio → 503 com mensagem clara "Embedded Signup ainda não
configurado") · DELETE :id → disabled. Roles: escrita `owner,admin`; GET qualquer
autenticado. Reaproveitar `TemplatesService.sync` via injeção (import do módulo).
Verify: build + curl GET/DELETE contra o banco local (pipeline manual completo fica
p/ T7 que precisa do túnel). Commit.

### T4: Webhook — assinatura por canal

**Files:** Modify `services/api-gateway/src/webhooks/{webhooks.service,webhooks.controller}.ts`.

Spec §6: `validSignature(rawBody, signature)` → `validateSignature(rawBody, signature,
body)` duas fases (secret global → por canal via phone_number_id do payload; decifrar
`app_secret_enc` com fallback texto puro; cache Map com TTL 5 min). Controller passa o
body já parseado. Manter timingSafeEqual. Verify: build + simulação local: POST ao
webhook com HMAC calculado com um secret de canal de mentira gravado num canal de
teste → 200; HMAC errado → 403. Commit.

### T5: Tela Conexão live + modal manual

**Files:** Modify `services/web/src/screens/Configuracoes.jsx` · Create
`services/web/src/components/ConectarManualModal.jsx` · Modify
`services/web/src/api/endpoints.js` (+4 fns).

Spec §7 (exceto botão ES): lista de canais live (cards: displayNumber/label/via/status/
qualityRating; badge por connectedVia), desconectar com confirm (aviso: "não desfaz a
configuração na Meta"), modal manual com 6 campos + guia colapsável + feedback por
etapa (renderiza `etapas[]` da resposta; erro em etapa → mostra ✗ na etapa e mensagem).
Aba Conexão perde o banner "dados de exemplo" (Equipe/Billing mantêm). Verify: build
Vite. Commit.

### T6: Botão "Conectar WhatsApp" (Embedded Signup)

**Files:** Create `services/web/src/components/ConectarWhatsAppButton.jsx` · Modify
`Configuracoes.jsx` (posicionar botão) · usa `VITE_FB_APP_ID`/`VITE_ES_CONFIG_ID`.

Spec §7: SDK FB carregado sob demanda (script tag única, guard global); `FB.init`
v25.0; listener `message` (origem facebook.com) capturando
`data.type==='WA_EMBEDDED_SIGNUP'` → `{waba_id, phone_number_id}`; `FB.login` com
`{config_id, response_type:'code', override_default_response_type:true, extras:
{setup:{}, featureType:'', sessionInfoVersion:'3'}}`; sucesso → POST es/exchange →
reload da lista. Env ausente → botão desabilitado + tooltip. Avisos UX (1h/BM/SMS)
num texto auxiliar. Verify: build. Commit.

### T7: Validação real (controlador executa)

1. Stack no ar (gateway 3001, web 5173, túnel → validar `WEBHOOK_PUBLIC_URL`).
2. Re-cifragem do canal legado: `DELETE /channels/:id` no canal de teste atual →
   `POST /channels/manual` via curl com as credenciais reais do app "teste" (token
   System User permanente + app secret conhecidos) → pipeline `etapas[]` todo ✓ →
   confirmar no banco que `access_token_enc` está no formato `a:b:c` (cifrado).
3. Enviar template `oi` para +5585991581157 → `sent` + `delivered` (prova decrypt Go).
4. Assinatura por canal (teste da T4 com evento real da Meta chegando → 200 no log).
5. Builds finais (gateway/web/go). UI: usuário valida tela/modal/botão no navegador.
6. ES ao vivo: pendente do `ZAPLANE_FB_APP_SECRET` (usuário) — quando chegar: teste
   do popup em modo dev + gravação do vídeo do App Review.

### Review final whole-slice (opus) + fixes.

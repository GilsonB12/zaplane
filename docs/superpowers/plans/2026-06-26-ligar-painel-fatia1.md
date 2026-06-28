# Fatia 1 — Ligar o painel (mock→live) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ligar o painel React à API real do gateway, entregando o fluxo ponta a ponta login → contatos → import → criar template → campanhas, 100% local.

**Architecture:** Backend ganha leitura nova (`GET /campaigns`), enriquecimento de `GET /campaigns/:id`, escrita nova (`POST /templates`) e bootstrap mínimo (canal placeholder no registro). Frontend é refatorado incrementalmente: o monólito `Zaplane.jsx` perde os mocks tela a tela, cada uma ligada via uma camada de dados (`client`/`endpoints`/`adapters`/`useResource`) com auth real persistida em `localStorage`.

**Tech Stack:** NestJS 10 + Prisma 5 + class-validator (gateway); React 18 + Vite 5 + Tailwind (web); PostgreSQL 15.

## Global Constraints

- **100% local, sem Docker e sem AWS.** Não introduzir Docker/AWS/Redis/Kafka. (CLAUDE.md §9)
- **Sem framework de teste nesta fatia.** Validação por `tsc`/build + `curl` + smoke manual. (CLAUDE.md §10, decisão do spec §8)
- **Sem migração de banco.** As FKs já existem em `db/migrations/001_init.sql`; só declaramos relations no Prisma. Migrações futuras são aditivas. (CLAUDE.md §9)
- **Multi-tenancy:** `organizationId` sempre vem do JWT (`@CurrentUser('organizationId')`), nunca do body. (CLAUDE.md §8)
- **Graph API version via env** (`whatsapp.graphVersion`, default `v21.0`). Nunca hardcodar versão nem segredos. (CLAUDE.md §9)
- **Idioma:** mensagens de usuário, comentários e docs em português. (CLAUDE.md §8)
- **Prefixo global da API:** `/api/v1`. CORS já aberto (`origin: true`) no gateway.
- **Git:** o repositório ainda **não** está sob git. Cada tarefa fecha com um *checkpoint* de verificação; se você rodar `git init`, transforme cada checkpoint em commit.

> **⚠️ Itens descobertos no planejamento (confirmar com o usuário antes de A5):** uma organização recém-registrada **não tem canal WhatsApp**, e `POST /campaigns` exige `channelId` de um canal `active`. Sem isso o fluxo de campanha não funciona localmente. A Task **A5** resolve criando um canal placeholder no registro e tornando `channelId` opcional (fallback para o canal ativo do org). Se o usuário preferir outra abordagem (ex.: tela de conexão na Fatia 2), pular A5 e o smoke de campanha.

---

# PARTE A — Gateway (services/api-gateway)

## Task A1: Declarar relations Prisma (Campaign↔Template, Campaign↔Channel)

**Files:**
- Modify: `services/api-gateway/prisma/schema.prisma`

**Interfaces:**
- Produces: relations Prisma `Campaign.template` (`Template?`), `Campaign.channel` (`WhatsappChannel`), e back-relations `Template.campaigns` / `WhatsappChannel.campaigns` — consumidas por A2 e A3 via `include`.

- [ ] **Step 1: Adicionar relations ao model `Campaign`**

No model `Campaign` (após a linha `organization Organization @relation(...)`), acrescentar:

```prisma
  channel  WhatsappChannel @relation(fields: [channelId], references: [id])
  template Template?       @relation(fields: [templateId], references: [id])
```

- [ ] **Step 2: Adicionar back-relations**

No model `WhatsappChannel`, após `organization Organization @relation(...)`, acrescentar:

```prisma
  campaigns Campaign[]
```

No model `Template`, após `organization Organization @relation(...)`, acrescentar:

```prisma
  campaigns Campaign[]
```

- [ ] **Step 3: Regenerar o Prisma Client**

Run: `cd services/api-gateway && npx prisma generate`
Expected: "Generated Prisma Client" sem erros de validação do schema.

- [ ] **Step 4: Checkpoint — build**

Run: `cd services/api-gateway && npm run build`
Expected: build TS sem erros.

---

## Task A2: `GET /campaigns` — listar campanhas

**Files:**
- Create: `services/api-gateway/src/campaigns/dto/query-campaigns.dto.ts`
- Modify: `services/api-gateway/src/campaigns/campaigns.service.ts`
- Modify: `services/api-gateway/src/campaigns/campaigns.controller.ts`

**Interfaces:**
- Consumes: relations de A1.
- Produces: `GET /api/v1/campaigns?page&pageSize&status` → `{ items: CampaignRow[], total, page, pageSize }`, onde `CampaignRow = { id, name, status, template:{name,category}|null, channel:{label}, totalRecipients, suppressedCount, sentCount, deliveredCount, readCount, failedCount, costEstimateCents:number|null, scheduledAt, createdAt }`. Consumido pelo front (B6/B7).

- [ ] **Step 1: Criar o DTO de query**

Create `services/api-gateway/src/campaigns/dto/query-campaigns.dto.ts`:

```ts
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

const STATUSES = ['draft', 'scheduled', 'queuing', 'sending', 'completed', 'failed', 'canceled'];

export class QueryCampaignsDto {
  @IsOptional() @IsIn(STATUSES)
  status?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  pageSize?: number = 20;
}
```

- [ ] **Step 2: Adicionar `list()` ao service**

Em `campaigns.service.ts`, adicionar o import do DTO no topo:

```ts
import { QueryCampaignsDto } from './dto/query-campaigns.dto';
```

E adicionar o método (depois de `create`):

```ts
async list(orgId: string, q: QueryCampaignsDto) {
  const page = q.page ?? 1;
  const pageSize = Math.min(q.pageSize ?? 20, 100);
  const where: any = { organizationId: orgId };
  if (q.status) where.status = q.status;

  const [rows, total] = await Promise.all([
    this.prisma.campaign.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: {
        template: { select: { name: true, category: true } },
        channel: { select: { label: true } },
      },
    }),
    this.prisma.campaign.count({ where }),
  ]);

  const items = rows.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    template: c.template,
    channel: c.channel,
    totalRecipients: c.totalRecipients,
    suppressedCount: c.suppressedCount,
    sentCount: c.sentCount,
    deliveredCount: c.deliveredCount,
    readCount: c.readCount,
    failedCount: c.failedCount,
    costEstimateCents: c.costEstimateCents != null ? Number(c.costEstimateCents) : null,
    scheduledAt: c.scheduledAt,
    createdAt: c.createdAt,
  }));
  return { items, total, page, pageSize };
}
```

- [ ] **Step 3: Adicionar a rota ao controller**

Em `campaigns.controller.ts`, garantir os imports `Get, Query` (Get já existe; adicionar `Query`) e o DTO:

```ts
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { QueryCampaignsDto } from './dto/query-campaigns.dto';
```

Adicionar o handler **antes** de `progress(@Param('id'))`:

```ts
  @Get()
  list(@CurrentUser('organizationId') orgId: string, @Query() q: QueryCampaignsDto) {
    return this.campaigns.list(orgId, q);
  }
```

- [ ] **Step 4: Checkpoint — build + curl**

Run: `cd services/api-gateway && npm run build`
Expected: build sem erros.

Com o gateway rodando (`npm run start:dev`) e um token (registre via `POST /auth/register`), validar:

```bash
curl.exe -s -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/v1/campaigns?pageSize=5"
```
Expected: JSON `{"items":[],"total":0,"page":1,"pageSize":5}` para um org novo (sem campanhas) — sem erro 500.

---

## Task A3: Enriquecer `GET /campaigns/:id`

**Files:**
- Modify: `services/api-gateway/src/campaigns/campaigns.service.ts:85-92` (método `progress`)

**Interfaces:**
- Produces: `GET /api/v1/campaigns/:id` → `{ id, name, status, template:{name,category}|null, channel:{label}, total, suppressed, sent, delivered, read, failed, costEstimateCents:number|null, createdAt, scheduledAt }`. Consumido por B6 (CampanhaDetalhe).

- [ ] **Step 1: Substituir o corpo de `progress()`**

Substituir o método `progress` por:

```ts
async progress(orgId: string, id: string) {
  const c = await this.prisma.campaign.findFirst({
    where: { id, organizationId: orgId },
    include: {
      template: { select: { name: true, category: true } },
      channel: { select: { label: true } },
    },
  });
  if (!c) throw new NotFoundException('Campanha não encontrada.');
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    template: c.template,
    channel: c.channel,
    total: c.totalRecipients,
    suppressed: c.suppressedCount,
    sent: c.sentCount,
    delivered: c.deliveredCount,
    read: c.readCount,
    failed: c.failedCount,
    costEstimateCents: c.costEstimateCents != null ? Number(c.costEstimateCents) : null,
    createdAt: c.createdAt,
    scheduledAt: c.scheduledAt,
  };
}
```

- [ ] **Step 2: Checkpoint — build**

Run: `cd services/api-gateway && npm run build`
Expected: sem erros.

---

## Task A4: `POST /templates` — criar template (rascunho-local-primeiro)

**Files:**
- Create: `services/api-gateway/src/templates/dto/create-template.dto.ts`
- Modify: `services/api-gateway/src/templates/templates.service.ts`
- Modify: `services/api-gateway/src/templates/templates.controller.ts`

**Interfaces:**
- Produces: `POST /api/v1/templates` body `{ name, category, language?, body }` → o registro `Template` criado (`status:'PENDING'`) + campo `metaWarning?:string`. Consumido por B5.

- [ ] **Step 1: Criar o DTO**

Create `services/api-gateway/src/templates/dto/create-template.dto.ts`:

```ts
import { IsIn, IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class CreateTemplateDto {
  // regra de nome da Meta: minúsculas, dígitos e underscore
  @Matches(/^[a-z0-9_]+$/, {
    message: 'O nome deve conter apenas letras minúsculas, dígitos e underscore.',
  })
  name!: string;

  @IsIn(['MARKETING', 'UTILITY', 'AUTHENTICATION'])
  category!: string;

  @IsOptional() @IsString()
  language?: string;

  @IsString() @MinLength(1)
  body!: string;
}
```

- [ ] **Step 2: Implementar `create()` + helpers no service**

Em `templates.service.ts`, ajustar imports do topo:

```ts
import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { decrypt } from '../common/crypto.util';
import { CreateTemplateDto } from './dto/create-template.dto';
```

Adicionar, no fim do arquivo (fora da classe), os helpers:

```ts
// conta placeholders {{n}} distintos no corpo
function countVariables(body: string): number {
  const matches = body.match(/\{\{\s*(\d+)\s*\}\}/g) ?? [];
  const nums = new Set(matches.map((m) => m.replace(/\D/g, '')));
  return nums.size;
}

// access_token_enc pode estar cifrado (AES-GCM) ou em texto (cifragem é TODO no projeto)
function readToken(enc: string): string {
  try { return decrypt(enc); } catch { return enc; }
}

// placeholders do seed/dev não são credenciais reais
function looksConfigured(v?: string | null): boolean {
  return !!v && !v.includes('AQUI');
}
```

Adicionar os métodos à classe `TemplatesService`:

```ts
async create(orgId: string, dto: CreateTemplateDto) {
  const language = dto.language ?? 'pt_BR';
  const variablesCount = countVariables(dto.body);

  const exists = await this.prisma.template.findFirst({
    where: { organizationId: orgId, name: dto.name, language },
  });
  if (exists) throw new ConflictException('Já existe um template com esse nome e idioma.');

  const template = await this.prisma.template.create({
    data: {
      organizationId: orgId,
      name: dto.name,
      language,
      category: dto.category,
      status: 'PENDING',
      body: dto.body,
      variablesCount,
    },
  });

  // Submissão à Meta: best-effort e env-gated. Falha NÃO desfaz o rascunho local.
  let metaWarning: string | undefined;
  try {
    const submission = await this.submitToMeta(orgId, template);
    if (submission.id) {
      await this.prisma.template.update({
        where: { id: template.id },
        data: { metaTemplateId: submission.id },
      });
      (template as any).metaTemplateId = submission.id;
    } else {
      metaWarning = submission.skipped;
    }
  } catch (e: any) {
    metaWarning = `Falha ao submeter à Meta: ${e?.message ?? e}. Rascunho salvo localmente.`;
  }

  return { ...template, metaWarning };
}

private async submitToMeta(
  orgId: string,
  template: { name: string; language: string; category: string; body: string; variablesCount: number },
): Promise<{ id?: string; skipped?: string }> {
  const channel = await this.prisma.whatsappChannel.findFirst({
    where: { organizationId: orgId, status: 'active' },
  });
  if (!channel || !looksConfigured(channel.wabaId) || !looksConfigured(channel.accessTokenEnc)) {
    return { skipped: 'Sem canal Meta configurado; template salvo apenas localmente.' };
  }
  const version = this.config.get<string>('whatsapp.graphVersion');
  const token = readToken(channel.accessTokenEnc);
  const example =
    template.variablesCount > 0
      ? { body_text: [Array.from({ length: template.variablesCount }, (_, i) => `exemplo${i + 1}`)] }
      : undefined;
  const components: any[] = [{ type: 'BODY', text: template.body, ...(example ? { example } : {}) }];
  const url = `https://graph.facebook.com/${version}/${channel.wabaId}/message_templates`;
  const { data } = await axios.post(
    url,
    { name: template.name, language: template.language, category: template.category, components },
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return { id: data?.id };
}
```

- [ ] **Step 3: Adicionar a rota ao controller (com RolesGuard)**

Substituir o conteúdo de `templates.controller.ts` por:

```ts
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TemplatesService } from './templates.service';
import { CreateTemplateDto } from './dto/create-template.dto';

@Controller('templates')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  findAll(@CurrentUser('organizationId') orgId: string) {
    return this.templates.findAll(orgId);
  }

  @Post()
  @Roles('owner', 'admin', 'operator')
  create(@CurrentUser('organizationId') orgId: string, @Body() dto: CreateTemplateDto) {
    return this.templates.create(orgId, dto);
  }

  @Post('sync')
  sync(@CurrentUser('organizationId') orgId: string) {
    return this.templates.sync(orgId);
  }
}
```

> `RolesGuard` retorna `true` quando não há `@Roles` (verificado em `roles.guard.ts:14`), então `findAll`/`sync` continuam liberados a qualquer usuário autenticado.

- [ ] **Step 4: Checkpoint — build + curl**

Run: `cd services/api-gateway && npm run build`
Expected: sem erros.

Com gateway rodando e token:

```bash
curl.exe -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"promo_teste\",\"category\":\"MARKETING\",\"body\":\"Ola {{1}}, tudo bem?\"}" \
  http://localhost:3000/api/v1/templates
```
Expected: JSON do template com `"status":"PENDING"`, `"variablesCount":1` e `"metaWarning":"Sem canal Meta configurado; template salvo apenas localmente."` (para org sem canal real).

---

## Task A5: Bootstrap de canal no registro + `channelId` opcional na campanha  ⚠️ confirmar com o usuário

**Files:**
- Modify: `services/api-gateway/src/auth/auth.service.ts:29-43` (transação do `register`)
- Modify: `services/api-gateway/src/campaigns/dto/create-campaign.dto.ts:13-14`
- Modify: `services/api-gateway/src/campaigns/campaigns.service.ts:17-21` (início de `create`)

**Interfaces:**
- Produces: toda org nova nasce com 1 `whatsapp_channel` `active` (placeholder, sem credenciais Meta). `CreateCampaignDto.channelId` passa a ser opcional; `campaigns.service.create` usa o canal ativo do org quando `channelId` não é informado. Permite ao front criar campanhas sem `GET /channels`.

- [ ] **Step 1: Criar canal placeholder na transação de registro**

Em `auth.service.ts`, dentro do `this.prisma.$transaction(async (tx) => { ... })`, após criar o `user`, adicionar a criação do canal e retorná-lo:

```ts
      await tx.whatsappChannel.create({
        data: {
          organizationId: org.id,
          label: 'Canal padrão',
          phoneNumberId: 'LOCAL_DEV',
          wabaId: 'LOCAL_DEV',
          accessTokenEnc: 'LOCAL_DEV',
          status: 'active',
        },
      });
      return { org, user };
```

> Placeholders `LOCAL_DEV` reusam a mesma lógica de `looksConfigured`/env-gate: o canal existe para enfileirar localmente, mas não tenta falar com a Meta. O envio real só liga com credenciais de verdade (consistente com "tudo menos envio real funciona local").

- [ ] **Step 2: Tornar `channelId` opcional no DTO**

Em `create-campaign.dto.ts`, trocar:

```ts
  @IsUUID()
  channelId!: string;
```
por:
```ts
  @IsOptional() @IsUUID()
  channelId?: string;
```
(garantir `IsOptional` no import de `class-validator` — já está importado.)

- [ ] **Step 3: Fallback para o canal ativo do org em `create`**

Em `campaigns.service.ts`, substituir o início do método `create` (a busca do canal):

```ts
    const channel = await this.prisma.whatsappChannel.findFirst({
      where: dto.channelId
        ? { id: dto.channelId, organizationId: orgId, status: 'active' }
        : { organizationId: orgId, status: 'active' },
    });
    if (!channel) throw new NotFoundException('Canal WhatsApp não encontrado.');
```

E nas duas referências seguintes a `dto.channelId` dentro de `create` (no `data:` do `campaign.create` e no `map` que monta `outbound_messages`), trocar `dto.channelId` por `channel.id`.

- [ ] **Step 4: Checkpoint — build + curl**

Run: `cd services/api-gateway && npm run build`
Expected: sem erros.

Registrar um org novo e confirmar que ele tem canal:
```bash
curl.exe -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/campaigns?pageSize=1
```
Expected: 200 (sem erro). O teste real de criação de campanha acontece no smoke C1.

---

# PARTE B — Painel (services/web)

## Task B1: Camada de dados (client, endpoints, adapters, hook)

**Files:**
- Modify: `services/web/src/api/client.js`
- Modify: `services/web/src/api/endpoints.js`
- Create: `services/web/src/api/adapters.js`
- Create: `services/web/src/hooks/useResource.js`

**Interfaces:**
- Produces:
  - `client.js`: `setToken`, `getToken`, `isAuthenticated`, `setUnauthorizedHandler(fn)`, token persistido em `localStorage` (`zaplane_token`).
  - `endpoints.js` (novos): `listCampaigns(query)`, `createTemplate(dto)`, `logout()`.
  - `adapters.js`: `toUiContact(c)`, `toUiCampaign(c)`, `toUiTemplate(t)`.
  - `hooks/useResource.js`: `useResource(fetcher, deps)` → `{ data, loading, error, reload }`; `useMutation(action)` → `{ run, pending, error }`.

- [ ] **Step 1: client.js — persistir token + handler de 401**

Substituir `services/web/src/api/client.js` por:

```js
// Cliente HTTP do painel Zaplane → API Gateway (NestJS).
// O token JWT é persistido em localStorage. Em dev, a base é /api/v1 (Vite faz proxy p/ :3000).

const BASE = import.meta.env.VITE_API_URL || "/api/v1";
const TOKEN_KEY = "zaplane_token";

let token = localStorage.getItem(TOKEN_KEY);
export function setToken(t) {
  token = t || null;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}
export function getToken() { return token; }
export function isAuthenticated() { return !!token; }

// O AuthContext registra aqui o que fazer quando a API responde 401.
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function request(path, { method = "GET", body, isForm = false } = {}) {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let payload = body;
  if (body && !isForm) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });

  if (res.status === 401) {
    setToken(null);
    if (onUnauthorized) onUnauthorized();
  }
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch { detail = await res.text(); }
    throw new Error(`HTTP ${res.status} — ${detail}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

export const api = {
  get: (p) => request(p),
  post: (p, b) => request(p, { method: "POST", body: b }),
  patch: (p, b) => request(p, { method: "PATCH", body: b }),
  del: (p) => request(p, { method: "DELETE" }),
  postForm: (p, form) => request(p, { method: "POST", body: form, isForm: true }),
};
```

- [ ] **Step 2: endpoints.js — adicionar listCampaigns, createTemplate, logout**

Em `services/web/src/api/endpoints.js`, ajustar o import e adicionar funções:

```js
import { api, setToken } from "./client.js";
```
(mantém o existente; `setToken` já é importado.)

Substituir a linha de campanhas (a que tem o comentário "NOTA: o gateway ainda não tem GET /campaigns") por:

```js
/* ---- Campanhas ---- */
export const createCampaign = (dto) => api.post("/campaigns", dto);
export const getCampaign = (id) => api.get(`/campaigns/${id}`);
export const cancelCampaign = (id) => api.post(`/campaigns/${id}/cancel`);
export const listCampaigns = (query = {}) => {
  const qs = new URLSearchParams(query).toString();
  return api.get(`/campaigns${qs ? `?${qs}` : ""}`);
};
```

E adicionar `createTemplate` junto de `listTemplates`:

```js
export const createTemplate = (dto) => api.post("/templates", dto);
```

E adicionar, ao fim do arquivo:

```js
/* ---- Sessão ---- */
export function logout() { setToken(null); }
```

- [ ] **Step 3: Criar adapters.js**

Create `services/web/src/api/adapters.js`:

```js
// Traduz o schema real da API (inglês) para os nomes/rótulos pt-BR que a UI já usa.

const CONSENT_LABEL = {
  granted: "consentido",
  pending: "pendente",
  denied: "pendente",
  opted_out: "optout",
  unknown: "pendente",
};

export function toUiContact(c) {
  return {
    id: c.id,
    nome: c.name ?? "(sem nome)",
    tel: c.phoneE164,
    ddd: c.ddd ?? "",
    regiao: c.region ?? "",
    tag: (c.tags && c.tags[0]) ?? "",
    tags: c.tags ?? [],
    consent: c.optedOut ? "optout" : (CONSENT_LABEL[c.consentStatus] ?? "pendente"),
  };
}

const CAT_LABEL = { MARKETING: "Marketing", UTILITY: "Utility", AUTHENTICATION: "Authentication" };

// A UI só tem badges para enviando/concluida/rascunho/falha → mapeamos os 7 status reais nesses 4.
const CAMP_STATUS = {
  draft: "rascunho",
  scheduled: "rascunho",
  queuing: "enviando",
  sending: "enviando",
  completed: "concluida",
  failed: "falha",
  canceled: "falha",
};

export function toUiCampaign(c) {
  return {
    id: c.id,
    nome: c.name,
    template: c.template?.name ?? "—",
    categoria: CAT_LABEL[c.template?.category] ?? "Marketing",
    status: CAMP_STATUS[c.status] ?? "rascunho",
    // o list usa *Count; o detalhe usa nomes curtos — aceitamos os dois
    total: c.totalRecipients ?? c.total ?? 0,
    enviadas: c.sentCount ?? c.sent ?? 0,
    entregues: c.deliveredCount ?? c.delivered ?? 0,
    lidas: c.readCount ?? c.read ?? 0,
    falhas: c.failedCount ?? c.failed ?? 0,
    quando: c.createdAt ? new Date(c.createdAt).toLocaleString("pt-BR") : "—",
  };
}

const TPL_STATUS_LABEL = {
  APPROVED: "aprovado",
  PENDING: "em_analise",
  REJECTED: "rejeitado",
  DISABLED: "rejeitado",
};

export function toUiTemplate(t) {
  return {
    id: t.id,
    nome: t.name,
    categoria: CAT_LABEL[t.category] ?? "Marketing",
    status: TPL_STATUS_LABEL[t.status] ?? "em_analise",
    idioma: t.language ?? "pt_BR",
    corpo: t.body ?? "",
    botoes: [], // schema v1 não guarda botões
  };
}
```

- [ ] **Step 4: Criar hooks/useResource.js**

Create `services/web/src/hooks/useResource.js`:

```js
import { useCallback, useEffect, useState } from "react";

// GET com ciclo de vida: {data, loading, error, reload}
export function useResource(fetcher, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.resolve(fetcher())
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => load(), [load]);
  return { data, loading, error, reload: load };
}

// Mutação imperativa: {run, pending, error}
export function useMutation(action) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  async function run(...args) {
    setPending(true);
    setError(null);
    try {
      return await action(...args);
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setPending(false);
    }
  }
  return { run, pending, error };
}
```

- [ ] **Step 5: Checkpoint — build**

Run: `cd services/web && npm run build`
Expected: build Vite sem erros (módulos novos compilam; `Zaplane.jsx` ainda usa mocks, ok).

---

## Task B2: Extrair UI compartilhada → `components/ui.jsx`

**Files:**
- Create: `services/web/src/components/ui.jsx`
- Modify: `services/web/src/Zaplane.jsx`

**Interfaces:**
- Produces (export nomeado de `components/ui.jsx`): `BRAND`, `BRAND_DARK`, `TEAL`, `Card`, `StatusBadge`, `ConsentChip`, `TplStatusBadge`, `CategoryTag`, `ProgressBar`, `WhatsAppBubble`, `PrimaryBtn`, `Topbar`, `Sidebar`, `NAV`. Consumido por todas as telas (B3–B7).

- [ ] **Step 1: Mover os primitivos para `components/ui.jsx`**

Create `services/web/src/components/ui.jsx`. Mover **verbatim** de `Zaplane.jsx` (sem alterar o corpo) estes itens, adicionando `export` a cada um:
- consts: `BRAND`, `BRAND_DARK`, `TEAL` (linhas 15-17), `STATUS_META`, `CONSENT_META`, `TPL_STATUS`, `CAT_META`, `NAV`.
- funções/componentes: `Card`, `StatusBadge`, `ConsentChip`, `TplStatusBadge`, `CategoryTag`, `ProgressBar`, `WhatsAppBubble`, `Sidebar`, `Topbar`, `PrimaryBtn`.

No topo de `ui.jsx`, importar os ícones usados por esses componentes (de `lucide-react`): `CheckCheck, BadgeCheck, Clock, XCircle, Zap, ShieldCheck, Sun, Moon` e os usados por `Sidebar`/`NAV` (`LayoutDashboard, Users, Send, Megaphone, LayoutTemplate, Settings`). Manter os `export` apenas — sem `export default`.

```jsx
import React from "react";
import {
  CheckCheck, BadgeCheck, Clock, XCircle, Zap, ShieldCheck, Sun, Moon,
  LayoutDashboard, Users, Send, Megaphone, LayoutTemplate, Settings,
} from "lucide-react";

export const BRAND = "#0F8C5A";
export const BRAND_DARK = "#0c7a4e";
export const TEAL = "#128C7E";

// ...(colar aqui, com `export` em cada um, os consts e componentes listados acima)...
```

- [ ] **Step 2: Atualizar `Zaplane.jsx` para importar de `components/ui.jsx`**

Em `Zaplane.jsx`, remover as definições movidas e adicionar no topo:

```jsx
import {
  BRAND, BRAND_DARK, TEAL, Card, StatusBadge, ConsentChip, TplStatusBadge,
  CategoryTag, ProgressBar, WhatsAppBubble, PrimaryBtn, Topbar, Sidebar, NAV,
} from "./components/ui.jsx";
```
Remover dos imports de `lucide-react` em `Zaplane.jsx` os ícones que passaram a ser usados só dentro de `ui.jsx` (deixar os que ainda são usados pelas telas restantes). O build aponta imports não usados como warning, não erro — resolver os que o lint sinalizar.

- [ ] **Step 3: Checkpoint — build**

Run: `cd services/web && npm run build`
Expected: build sem erros; o app renderiza igual (refactor sem mudança de comportamento).

---

## Task B3: AuthContext + Login + portão de autenticação

**Files:**
- Create: `services/web/src/auth/AuthContext.jsx`
- Create: `services/web/src/screens/Login.jsx`
- Modify: `services/web/src/Zaplane.jsx:982-1016` (export default → portão)

**Interfaces:**
- Consumes: `client.setUnauthorizedHandler`, `endpoints.login/register/logout`, `client.isAuthenticated`.
- Produces: `AuthProvider`, `useAuth()` → `{ authed, login(email,password), register(dto), logout() }`. `Login` screen. O default export de `Zaplane.jsx` passa a renderizar `Login` quando não autenticado.

- [ ] **Step 1: Criar AuthContext**

Create `services/web/src/auth/AuthContext.jsx`:

```jsx
import React, { createContext, useContext, useEffect, useState } from "react";
import { isAuthenticated, setUnauthorizedHandler } from "../api/client.js";
import { login as apiLogin, register as apiRegister, logout as apiLogout } from "../api/endpoints.js";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [authed, setAuthed] = useState(isAuthenticated());

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false));
  }, []);

  async function login(email, password) {
    await apiLogin(email, password);
    setAuthed(true);
  }
  async function register(dto) {
    await apiRegister(dto);
    setAuthed(true);
  }
  function logout() {
    apiLogout();
    setAuthed(false);
  }

  return (
    <AuthCtx.Provider value={{ authed, login, register, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth deve ser usado dentro de AuthProvider");
  return ctx;
}
```

- [ ] **Step 2: Criar a tela de Login (login + criar conta)**

Create `services/web/src/screens/Login.jsx`:

```jsx
import React, { useState } from "react";
import { Zap } from "lucide-react";
import { BRAND, TEAL } from "../components/ui.jsx";
import { useAuth } from "../auth/AuthContext.jsx";

export default function Login() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState("login"); // "login" | "register"
  const [form, setForm] = useState({ organizationName: "", name: "", email: "", password: "" });
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (mode === "login") await login(form.email, form.password);
      else await register({
        organizationName: form.organizationName, name: form.name,
        email: form.email, password: form.password,
      });
    } catch (err) {
      setError(err.message || "Falha na autenticação.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-7 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl text-white" style={{ background: `linear-gradient(135deg, ${BRAND}, ${TEAL})` }}>
            <Zap className="h-5 w-5" />
          </div>
          <div className="text-[15px] font-semibold text-zinc-900 dark:text-white">Zaplane</div>
        </div>

        <h1 className="text-lg font-semibold text-zinc-900 dark:text-white">
          {mode === "login" ? "Entrar" : "Criar conta"}
        </h1>
        <p className="mb-5 text-[13px] text-zinc-500 dark:text-zinc-400">
          {mode === "login" ? "Acesse o painel da sua organização." : "Crie sua organização e o usuário owner."}
        </p>

        <form onSubmit={submit} className="space-y-3">
          {mode === "register" && (
            <>
              <input required value={form.organizationName} onChange={set("organizationName")} placeholder="Nome da organização"
                className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />
              <input required value={form.name} onChange={set("name")} placeholder="Seu nome"
                className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />
            </>
          )}
          <input required type="email" value={form.email} onChange={set("email")} placeholder="E-mail"
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />
          <input required type="password" value={form.password} onChange={set("password")} placeholder="Senha"
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />

          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

          <button type="submit" disabled={pending}
            className="w-full rounded-xl py-2 text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: BRAND }}>
            {pending ? "Aguarde…" : mode === "login" ? "Entrar" : "Criar conta"}
          </button>
        </form>

        <button onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}
          className="mt-4 w-full text-center text-[13px] font-medium text-[#0F8C5A] hover:underline dark:text-emerald-300">
          {mode === "login" ? "Não tem conta? Criar agora" : "Já tem conta? Entrar"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Envolver o app no portão de auth**

Em `Zaplane.jsx`:
1. Renomear `export default function Zaplane()` (linha ~982) para `function AppShell()` (remover `export default`).
2. Adicionar imports no topo:

```jsx
import { AuthProvider, useAuth } from "./auth/AuthContext.jsx";
import Login from "./screens/Login.jsx";
```
3. Adicionar, ao fim do arquivo, o novo default export:

```jsx
function Gate() {
  const { authed } = useAuth();
  return authed ? <AppShell /> : <Login />;
}

export default function Zaplane() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
```

- [ ] **Step 4: Botão de sair no Topbar (opcional, recomendado)**

Em `components/ui.jsx`, o `Topbar` exibe um usuário fixo "Ana Beatriz". Adicionar um botão de logout: aceitar uma prop `onLogout` no `Topbar` e renderizar um botão pequeno (ícone) que a chama; em `AppShell`, passar `onLogout={logout}` obtido de `useAuth()`. (Se preferir manter mínimo, pular este passo.)

- [ ] **Step 5: Checkpoint — build + smoke de auth**

Run: `cd services/web && npm run build`
Expected: sem erros.

Smoke (gateway + web rodando): abrir `http://localhost:5173` → ver a tela de Login → "Criar agora" → preencher → submeter → cair no painel. Recarregar a página → continua logado (token no localStorage).

---

## Task B4: Contatos live + ImportModal live

**Files:**
- Create: `services/web/src/screens/Contatos.jsx` (mover `Contatos` + `ImportModal` de `Zaplane.jsx`)
- Modify: `services/web/src/Zaplane.jsx` (remover as funções movidas e o mock `CONTATOS`; importar do novo arquivo)

**Interfaces:**
- Consumes: `endpoints.listContacts`, `updateContact`, `removeContact`, `optOutContact`, `importContacts`; `adapters.toUiContact`; `hooks.useResource/useMutation`; `components/ui`.
- Produces: `Contatos` (default export) e `ImportModal` (named export) em `screens/Contatos.jsx`.

- [ ] **Step 1: Mover Contatos + ImportModal e ligar a busca live**

Create `services/web/src/screens/Contatos.jsx`. Mover o componente `Contatos` (linhas ~384-470) e `ImportModal` (linhas ~473-…) de `Zaplane.jsx`. Importar dependências:

```jsx
import React, { useMemo, useRef, useState } from "react";
import { Search, Filter, Upload, MessageSquare, Edit2, Trash2, ChevronDown, X, ShieldCheck } from "lucide-react";
import { Card, ConsentChip, PrimaryBtn } from "../components/ui.jsx";
import { useResource, useMutation } from "../hooks/useResource.js";
import { toUiContact } from "../api/adapters.js";
import { listContacts, removeContact, optOutContact } from "../api/endpoints.js";
```

Substituir o topo do componente `Contatos` (a parte que lia o mock `CONTATOS`) por dados live:

```jsx
export default function Contatos({ openImport, reloadKey }) {
  const [q, setQ] = useState("");
  const [regiao, setRegiao] = useState("");
  const [tag, setTag] = useState("");
  const [consent, setConsent] = useState("");

  // server-side: busca, ddd e consent vão na query; região/tag filtram client-side a página atual
  const query = {};
  if (q) query.search = q;
  if (consent) query.consent = { consentido: "granted", pendente: "pending", optout: "opted_out" }[consent];

  const { data, loading, error, reload } = useResource(
    () => listContacts({ ...query, pageSize: 200 }),
    [q, consent, reloadKey],
  );

  const contatos = useMemo(() => (data?.items ?? []).map(toUiContact), [data]);
  const regioes = [...new Set(contatos.map((c) => c.regiao).filter(Boolean))];
  const tags = [...new Set(contatos.map((c) => c.tag).filter(Boolean))];
  const filtrados = contatos.filter((c) => (!regiao || c.regiao === regiao) && (!tag || c.tag === tag));

  const del = useMutation(removeContact);
  const opt = useMutation(optOutContact);
  async function onRemove(id) { await del.run(id); reload(); }
  async function onOptOut(id) { await opt.run(id); reload(); }
```

Manter o JSX dos filtros e da tabela. Ajustes no JSX:
- A tabela itera sobre `filtrados` (já adaptados) — manter como está.
- Acima da tabela, tratar estados: se `loading` → mostrar "Carregando contatos…"; se `error` → banner `error.message` + botão que chama `reload()`; se `!loading && filtrados.length === 0` → o `<tr>` de vazio já existente cobre.
- No botão "Remover" da linha, ligar `onClick={() => onRemove(c.id)}`; no botão "Enviar mensagem"/opt-out, conforme a ação (o ícone de remover de disparo pode chamar `onOptOut(c.id)` — manter o `disabled={c.consent === "optout"}` existente).
- Botão "Importar contatos" chama `openImport` (mantido).

- [ ] **Step 1b: EditContactModal (editar nome + tags)**

O mock só tem um ícone "Editar" sem tela. Adicionar um modal mínimo no mesmo arquivo, ligado a `updateContact(id, {name, tags})`:

```jsx
function EditContactModal({ contato, onClose, onSaved }) {
  const [name, setName] = useState(contato?.nome ?? "");
  const [tags, setTags] = useState((contato?.tags ?? []).join(", "));
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  if (!contato) return null;

  async function save() {
    setError(null);
    setPending(true);
    try {
      await updateContact(contato.id, {
        name,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e.message || "Falha ao salvar.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 text-base font-semibold text-zinc-900 dark:text-white">Editar contato</h3>
        <div className="space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome"
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags (separadas por vírgula)"
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">Cancelar</button>
          <button onClick={save} disabled={pending} className="rounded-xl px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: "#0F8C5A" }}>
            {pending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Em `Contatos`, adicionar `const [editing, setEditing] = useState(null);`, ligar o ícone "Editar" da linha a `onClick={() => setEditing(c)}`, renderizar `{editing && <EditContactModal contato={editing} onClose={() => setEditing(null)} onSaved={reload} />}`, e adicionar `updateContact` ao import de `endpoints.js`.

- [ ] **Step 2: ImportModal — upload real**

No `ImportModal` (movido para o mesmo arquivo, named export), substituir o conteúdo estático por upload real:

```jsx
export function ImportModal({ onClose, onImported }) {
  const [base, setBase] = useState("granted");        // consentStatus
  const [source, setSource] = useState("cadastro_loja"); // consentSource
  const fileRef = useRef(null);
  const imp = useMutation((file) => importContacts(file, base, source, "BR"));
  const [result, setResult] = useState(null);

  async function onSubmit() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const r = await imp.run(file);
    setResult(r); // { imported, duplicates, invalid, total }
    if (onImported) onImported();
  }
  // ...JSX: <input type="file" ref={fileRef} accept=".csv,.json,.xlsx" />,
  //   selects de base legal (granted/pending/unknown) e fonte (texto),
  //   botão "Importar" desabilitado quando imp.pending,
  //   se imp.error → banner imp.error.message,
  //   se result → mostrar `${result.imported} importados · ${result.duplicates} duplicados · ${result.invalid} inválidos`.
}
```
Adicionar `importContacts` ao import de `endpoints.js` no topo do arquivo.

- [ ] **Step 3: Ligar reload no Zaplane shell**

Em `Zaplane.jsx` (`AppShell`): remover o mock `CONTATOS` e a função `Contatos`/`ImportModal`; importar do novo arquivo:

```jsx
import Contatos, { ImportModal } from "./screens/Contatos.jsx";
```
Passar um `reloadKey` que muda após import: adicionar `const [contactsReload, setContactsReload] = useState(0);` e renderizar:
```jsx
{screen === "contatos" && <Contatos openImport={() => setImportOpen(true)} reloadKey={contactsReload} />}
...
{importOpen && <ImportModal onClose={() => setImportOpen(false)} onImported={() => setContactsReload((k) => k + 1)} />}
```

- [ ] **Step 4: Checkpoint — build + smoke**

Run: `cd services/web && npm run build`
Expected: sem erros.

Smoke: logar → Contatos mostra os contatos do banco (vazio para org novo) → Importar `scripts/sample-contacts.csv` com base "granted" → ver o resumo → a lista recarrega com os contatos.

---

## Task B5: Templates live + NovoTemplateModal

**Files:**
- Create: `services/web/src/screens/Templates.jsx` (mover `Templates` de `Zaplane.jsx`)
- Modify: `services/web/src/Zaplane.jsx` (remover `Templates` e o mock `TEMPLATES`)

**Interfaces:**
- Consumes: `endpoints.listTemplates`, `createTemplate`; `adapters.toUiTemplate`; `components/ui` (`Card, TplStatusBadge, CategoryTag, WhatsAppBubble, PrimaryBtn`).
- Produces: `Templates` (default export) em `screens/Templates.jsx`.

- [ ] **Step 1: Mover Templates e ligar listagem live**

Create `services/web/src/screens/Templates.jsx`. Mover o componente `Templates` (linhas ~821-860) de `Zaplane.jsx`. Topo do componente:

```jsx
import React, { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Card, TplStatusBadge, CategoryTag, WhatsAppBubble, PrimaryBtn } from "../components/ui.jsx";
import { useResource } from "../hooks/useResource.js";
import { toUiTemplate } from "../api/adapters.js";
import { listTemplates } from "../api/endpoints.js";

export default function Templates() {
  const [cat, setCat] = useState("Todas");
  const [modalOpen, setModalOpen] = useState(false);
  const { data, loading, error, reload } = useResource(() => listTemplates(), []);
  const templates = useMemo(() => (data ?? []).map(toUiTemplate), [data]);
  const filtrados = cat === "Todas" ? templates : templates.filter((t) => t.categoria === cat);
  // ...JSX: filtro por categoria (mantido), botão "Novo template" → setModalOpen(true),
  //   estados loading/error (banner + reload), grid mapeando `filtrados`,
  //   <NovoTemplateModal open={modalOpen} onClose={() => setModalOpen(false)} onCreated={reload} />
}
```

- [ ] **Step 2: NovoTemplateModal (criar template)**

No mesmo arquivo, adicionar o modal:

```jsx
function NovoTemplateModal({ open, onClose, onCreated }) {
  const [form, setForm] = useState({ name: "", category: "MARKETING", body: "" });
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  if (!open) return null;

  async function submit() {
    setError(null);
    if (!/^[a-z0-9_]+$/.test(form.name)) {
      setError("Nome: use apenas minúsculas, dígitos e underscore (ex.: promo_banho).");
      return;
    }
    setPending(true);
    try {
      const r = await createTemplate({ name: form.name, category: form.category, body: form.body });
      if (r?.metaWarning) console.info("[templates]", r.metaWarning);
      onCreated();
      onClose();
    } catch (e) {
      setError(e.message || "Falha ao criar template.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-zinc-900 dark:text-white">Novo template</h3>
        <p className="mb-4 text-[13px] text-zinc-500 dark:text-zinc-400">Será enviado à Meta para aprovação quando o canal estiver configurado.</p>
        <div className="space-y-3">
          <input value={form.name} onChange={set("name")} placeholder="nome_do_template (minúsculas, _ )"
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />
          <select value={form.category} onChange={set("category")}
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
            <option value="MARKETING">Marketing</option>
            <option value="UTILITY">Utility</option>
            <option value="AUTHENTICATION">Authentication</option>
          </select>
          <textarea value={form.body} onChange={set("body")} rows={4} placeholder="Corpo. Use {{1}}, {{2}} para variáveis."
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />
          {form.body && <WhatsAppBubble corpo={form.body} />}
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">Cancelar</button>
          <button onClick={submit} disabled={pending} className="rounded-xl px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: "#0F8C5A" }}>
            {pending ? "Criando…" : "Criar template"}
          </button>
        </div>
      </div>
    </div>
  );
}
```
Adicionar `createTemplate` ao import de `endpoints.js`.

- [ ] **Step 3: Atualizar o shell**

Em `Zaplane.jsx`: remover a função `Templates` e o mock `TEMPLATES`; importar `import Templates from "./screens/Templates.jsx";`.

- [ ] **Step 4: Checkpoint — build + smoke**

Run: `cd services/web && npm run build`
Expected: sem erros.

Smoke: Templates → "Novo template" → nome `promo_teste`, corpo `Olá {{1}}!` → Criar → o template aparece na galeria como "Em análise".

---

## Task B6: Campanhas live (grid + NovaCampanha + CampanhaDetalhe)

**Files:**
- Create: `services/web/src/screens/Campanhas.jsx` (mover `Campanhas`, `NovaCampanha`, `CampanhaDetalhe`)
- Modify: `services/web/src/Zaplane.jsx` (remover os 3 componentes e o mock `CAMPANHAS`)

**Interfaces:**
- Consumes: `endpoints.listCampaigns`, `getCampaign`, `createCampaign`, `cancelCampaign`, `listLists`, `listTemplates`; `adapters.toUiCampaign`, `toUiTemplate`; `hooks`; `components/ui`.
- Produces: `Campanhas` (default), `NovaCampanha`, `CampanhaDetalhe` (named) em `screens/Campanhas.jsx`.

- [ ] **Step 1: Grid de campanhas live**

Create `services/web/src/screens/Campanhas.jsx`. Mover `Campanhas` (linhas ~709-740). Topo:

```jsx
import React, { useMemo, useState } from "react";
import { MoreVertical, ChevronLeft, Send, Zap, CheckCheck, FileText } from "lucide-react";
import { Card, StatusBadge, CategoryTag, ProgressBar, PrimaryBtn, BRAND, TEAL } from "../components/ui.jsx";
import { useResource, useMutation } from "../hooks/useResource.js";
import { toUiCampaign, toUiTemplate } from "../api/adapters.js";
import { listCampaigns, getCampaign, createCampaign, cancelCampaign, listLists, listTemplates } from "../api/endpoints.js";

export default function Campanhas({ openCampaign }) {
  const { data, loading, error, reload } = useResource(() => listCampaigns({ pageSize: 60 }), []);
  const campanhas = useMemo(() => (data?.items ?? []).map(toUiCampaign), [data]);
  // ...JSX: estados loading/error (banner + reload); grid mapeando `campanhas` (mantido);
  //   se vazio → "Nenhuma campanha ainda."
}
```

- [ ] **Step 2: NovaCampanha — público + template + criar**

Mover `NovaCampanha` (linhas ~490-706) para o mesmo arquivo (named export). Ligar os dados:

```jsx
export function NovaCampanha({ setScreen, openCampaign }) {
  const listsRes = useResource(() => listLists(), []);
  const tplRes = useResource(() => listTemplates(), []);
  const listas = listsRes.data ?? [];                              // [{id,name,type,...}]
  const templatesAprovados = (tplRes.data ?? []).map(toUiTemplate).filter((t) => t.status === "aprovado");

  const [listId, setListId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [nome, setNome] = useState("");
  const create = useMutation(createCampaign);
  const [error, setError] = useState(null);

  async function confirmar() {
    setError(null);
    try {
      // channelId omitido de propósito → o gateway usa o canal ativo do org (Task A5)
      const r = await create.run({
        name: nome || "Campanha sem nome",
        templateId,
        listId: listId || undefined,
        // sem listId/audienceRule o gateway resolve por segmento vazio → todos os contatos do org
        templateParams: {},
      });
      openCampaign(r.campaignId); // navega ao detalhe
    } catch (e) {
      setError(e.message || "Falha ao criar campanha.");
    }
  }
  // ...JSX do wizard (mantido). Mapear:
  //   - o seletor de público para `listas` (ou "Todos os contatos" quando listId vazio);
  //   - o seletor de template para `templatesAprovados` (id → templateId; usar t.corpo no preview);
  //   - o passo final chama `confirmar()`; mostrar `error` se houver.
}
```

> O `templateId` precisa ser o **UUID real** do template (use `t.id` do `toUiTemplate`, que preserva o id). O wizard mock usava ids tipo `"t1"`; ao ligar, popular o seletor com os templates reais.

- [ ] **Step 3: CampanhaDetalhe — estado real, sem animação fake**

Mover `CampanhaDetalhe` (linhas ~743-…) para o arquivo. Substituir a base mock + `setInterval` por fetch real:

```jsx
export function CampanhaDetalhe({ campaignId, setScreen }) {
  const { data, loading, error, reload } = useResource(() => getCampaign(campaignId), [campaignId]);
  const live = data ? toUiCampaign(data) : null;
  const cancel = useMutation(cancelCampaign);
  async function onCancel() { await cancel.run(campaignId); reload(); }
  // ...JSX (mantido), porém:
  //   - remover o useEffect/setInterval de "tempo real";
  //   - guardar contra `live === null` (loading) e `error`;
  //   - adicionar um botão "Atualizar" que chama `reload()` e, quando status==="enviando", "Cancelar" → onCancel();
  //   - métricas/timeline leem de `live` (mesmos campos: enviadas/entregues/lidas/falhas/total/quando/status/nome/template/categoria).
}
```

- [ ] **Step 4: Atualizar o shell**

Em `Zaplane.jsx`: remover `Campanhas`, `NovaCampanha`, `CampanhaDetalhe` e o mock `CAMPANHAS`; importar:

```jsx
import Campanhas, { NovaCampanha, CampanhaDetalhe } from "./screens/Campanhas.jsx";
```
Ajustar as linhas de render: `<NovaCampanha setScreen={setScreen} openCampaign={openCampaign} />`.

- [ ] **Step 5: Checkpoint — build + smoke**

Run: `cd services/web && npm run build`
Expected: sem erros.

Smoke: com contatos importados e 1 template **APROVADO** → Nova campanha → escolher público + template → Confirmar → cair no detalhe com contadores reais. Campanhas mostra o card.

> **⚠️ Aprovação de template no local:** `POST /campaigns` só aceita template com `status='APPROVED'` (a aprovação vem da Meta, fora desta fase), e a `NovaCampanha` só lista os aprovados. Um template recém-criado fica `PENDING` → **não aparece no wizard**. Para o smoke local, aprove um manualmente:
> ```bash
> psql -d zaplane -c "UPDATE templates SET status='APPROVED' WHERE name='promo_teste';"
> ```
> Em produção isso acontece via `templates.sync` puxando o status da Meta (Fatia futura).

> Observação: para a campanha disparar de fato é preciso o Dispatcher + credenciais Meta. Localmente, a campanha é criada e enfileirada (status `sending`/`queuing`); os contadores ficam zerados sem o worker — esperado nesta fase.

---

## Task B7: Dashboard parcial-live + Configurações com selo + limpeza de mocks

**Files:**
- Create: `services/web/src/screens/Dashboard.jsx`
- Create: `services/web/src/screens/Configuracoes.jsx`
- Modify: `services/web/src/Zaplane.jsx` (remover mocks restantes: `KPIS`, `ENVIOS_14D`, `MEMBROS`, e funções movidas)

**Interfaces:**
- Consumes: `endpoints.listContacts`, `listCampaigns`; `adapters.toUiCampaign`; `components/ui`.
- Produces: `Dashboard` (default) e `Configuracoes` (default) em arquivos próprios.

- [ ] **Step 1: Dashboard parcial-live**

Create `services/web/src/screens/Dashboard.jsx`. Mover `Dashboard` (linhas ~271-381) e as consts `TITLES`? (não — `TITLES` fica no shell). Ligar:

```jsx
import { useResource } from "../hooks/useResource.js";
import { toUiCampaign } from "../api/adapters.js";
import { listContacts, listCampaigns } from "../api/endpoints.js";

export default function Dashboard({ setScreen, openCampaign }) {
  const contatosRes = useResource(() => listContacts({ pageSize: 1 }), []);
  const campRes = useResource(() => listCampaigns({ pageSize: 5 }), []);
  const totalContatos = contatosRes.data?.total ?? 0;
  const ultimas = (campRes.data?.items ?? []).map(toUiCampaign);
  // ...JSX:
  //   - Card de KPI "Contatos ativos" mostra totalContatos (live);
  //   - demais KPIs e o gráfico de 14 dias e o card "Saúde do número":
  //     marcar com um selo "em breve" (placeholder) — manter visual, mas trocar os números mock por "—"
  //     ou um badge "dados de exemplo";
  //   - tabela "Últimas campanhas" itera `ultimas` (vazio → linha "Nenhuma campanha ainda").
}
```

Remover do arquivo a dependência de `ENVIOS_14D`/`KPIS` (mocks). Para o gráfico, ou (a) ocultar o card de gráfico nesta fatia, ou (b) deixá-lo com um overlay "dados de exemplo" usando um array local pequeno marcado como exemplo. Escolha (a) para não confundir.

- [ ] **Step 2: Configurações com selo "dados de exemplo"**

Create `services/web/src/screens/Configuracoes.jsx`. Mover `Configuracoes` (linhas ~876-969) e as consts `RBAC_DESC`/`RBAC_CLS`. Manter os dados mock (canais/equipe/billing são Fatia 2), mas adicionar no topo do componente um banner visível:

```jsx
<div className="rounded-xl bg-amber-50 px-4 py-2 text-[13px] text-amber-800 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300">
  Dados de exemplo — Conexão, Equipe e Billing entram na próxima fatia.
</div>
```
Definir `MEMBROS` localmente neste arquivo (mover o mock para cá) já que a equipe ainda é exemplo.

- [ ] **Step 3: Limpar o shell**

Em `Zaplane.jsx`: remover os mocks restantes (`KPIS`, `ENVIOS_14D`, `MEMBROS`) e as funções movidas; importar `Dashboard` e `Configuracoes` dos novos arquivos. Conferir que **nenhum** mock de dados (`CONTATOS`, `CAMPANHAS`, `TEMPLATES`, `KPIS`, `ENVIOS_14D`, `MEMBROS`) resta em `Zaplane.jsx`.

- [ ] **Step 4: Checkpoint — build**

Run: `cd services/web && npm run build`
Expected: sem erros. Buscar no arquivo por nomes de mock removidos:

Run: `grep.exe -nE "KPIS|ENVIOS_14D|CONTATOS|CAMPANHAS =|TEMPLATES =|MEMBROS" services/web/src/Zaplane.jsx` (ou a busca do editor)
Expected: nenhum resultado.

---

# PARTE C — Verificação ponta a ponta

## Task C1: Smoke manual completo

**Files:** nenhum (verificação).

**Pré-requisitos:** Postgres com `001_init.sql` aplicado; gateway `:3000` (`npm run start:dev`); importer `:8000` (`uvicorn`); web `:5173` (`npm run dev`).

- [ ] **Step 1: Builds limpos**

Run: `cd services/api-gateway && npm run build`
Run: `cd services/web && npm run build`
Expected: ambos sem erros.

- [ ] **Step 2: Fluxo no navegador**

- [ ] Abrir `http://localhost:5173` → tela de Login.
- [ ] "Criar agora" → registrar org + owner → cai no painel.
- [ ] Recarregar a página → continua logado.
- [ ] Contatos → Importar `scripts/sample-contacts.csv` (base "granted", fonte "cadastro_loja") → ver resumo → lista recarrega com contatos.
- [ ] Filtrar contatos por consentimento/região.
- [ ] Templates → "Novo template" (`promo_teste`, corpo `Olá {{1}}!`) → aparece "Em análise".
- [ ] **Aprovar o template no local** (a Meta não está no loop): `psql -d zaplane -c "UPDATE templates SET status='APPROVED' WHERE name='promo_teste';"` → recarregar Templates → "Aprovado".
- [ ] Nova campanha → público "Todos os contatos" → template aprovado → Confirmar → cai no detalhe com nome/template/contadores.
- [ ] Campanhas → o card da campanha aparece.
- [ ] (Auth) Apagar o `localStorage` `zaplane_token` no devtools e fazer uma ação → volta ao Login (401 → logout).

- [ ] **Step 3: Registrar resultado**

Anotar no final do plano (ou no PR/diário) o que passou e qualquer divergência. Sem framework de teste — esta é a verificação de aceite da Fatia 1.

---

## Notas de execução

- **Ordem recomendada:** A1→A2→A3→A4→(A5 após confirmação)→B1→B2→B3→B4→B5→B6→B7→C1. A Parte A é testável isolada via `curl`; a Parte B depende dos contratos de A.
- **Sempre compila:** cada tarefa de frontend termina com `npm run build` verde; a extração é tela a tela para o app nunca quebrar.
- **Itens a confirmar (A5):** bootstrap de canal no registro + `channelId` opcional. Sem A5, pular o smoke de criação de campanha.

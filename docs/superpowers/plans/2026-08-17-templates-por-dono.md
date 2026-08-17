# Templates por dono — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cada organização só vê e dispara os próprios templates, e a Zaplane publica templates genéricos que servem todos os clientes assistidos.

**Architecture:** O template ganha dois nomes — `name` (o que o cliente vê) e `meta_name` (o que existe na Meta, com prefixo derivado do id da organização). O `sync()` passa a só criar linha para template cujo nome carregue o prefixo desta organização, ou o prefixo `zaplane` dos genéricos. O escopo (`org` | `platform`) diz de quem é o template, e genérico só aparece para quem envia pela WABA da plataforma.

**Tech Stack:** NestJS 10 / Prisma 5 / TypeScript 5 / PostgreSQL 15 / Jest.

**Spec:** `docs/superpowers/specs/2026-08-17-templates-por-dono-design.md`

## Global Constraints

- Comentários, mensagens ao usuário e docs em **português**. Mensagens de commit em português, sem co-author e sem menção a IA.
- Multi-tenancy: `organizationId` vem sempre do JWT (`@CurrentUser('organizationId')`), **nunca** do body.
- `db/migrations/*.sql` é a fonte de verdade. Migrações são **aditivas** — novos arquivos `00X_*.sql`, nunca editar as já aplicadas. A `013` já foi aplicada em produção.
- **Nunca rodar `npx prisma db pull`** neste repositório: ele apaga os comentários do `schema.prisma` e cria models para `consent_events`, `inbound_messages`, `audit_logs` e `list_contacts`, que o projeto mantém de propósito fora do Prisma. O schema é editado à mão para refletir o SQL.
- Tabelas sem model Prisma usam `$queryRaw`/`$executeRaw` com cast `::uuid` nos parâmetros.
- Nada hardcoded que devesse ser configuração. A versão do Graph API vem de `whatsapp.graphVersion`.
- A suíte tem hoje **11 arquivos e 96 testes** passando. Nenhum pode quebrar. No fim de cada tarefa: `npx jest` e `npx tsc --noEmit` em `services/api-gateway`.
- Regra de nome de template da Meta: só `[a-z0-9_]`.

## Chaves de configuração já existentes (não criar novas)

- `whatsapp.graphVersion` — `WHATSAPP_GRAPH_API_VERSION`, default `v21.0`
- `whatsapp.accessToken` — `WHATSAPP_ACCESS_TOKEN`, token de System User da plataforma
- `assisted.wabaId` — `ZAPLANE_WABA_ID`, a WABA compartilhada

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `db/migrations/014_templates_por_dono.sql` | `meta_name`, `scope`, `organization_id` anulável, CHECK do par, índice parcial de plataforma, `is_platform_admin` |
| `src/templates/meta-nome.ts` | funções puras: prefixo da org, prefixo da plataforma, normalização, montagem do `meta_name` |
| `src/common/plataforma.service.ts` | predicado único "esta organização envia pela WABA da plataforma" |
| `src/common/guards/plataforma-admin.guard.ts` + `src/common/decorators/plataforma-admin.decorator.ts` | autorização de operação da Zaplane |
| `src/templates/templates.service.ts` | credenciais por canal, sync com as duas regras, create com `meta_name` e escopo |
| `src/campaigns/campaigns.service.ts`, `src/messages/messages.service.ts` | busca aceitando genérico, envio pelo `meta_name` |
| `scripts/verifica-templates-por-dono.cjs` | invariantes da `014` contra o Postgres real, em transação revertida |

---

### Task 1: Migração 014, Prisma e verificação contra o banco real

**Files:**
- Create: `db/migrations/014_templates_por_dono.sql`
- Create: `scripts/verifica-templates-por-dono.cjs`
- Modify: `services/api-gateway/prisma/schema.prisma` (models `Template` e `User`)

**Interfaces:**
- Consumes: nada.
- Produces: colunas `templates.meta_name` (TEXT NOT NULL), `templates.scope` (TEXT, `'org'|'platform'`), `templates.organization_id` anulável, `users.is_platform_admin` (BOOLEAN NOT NULL DEFAULT false). No Prisma: `Template.metaName`, `Template.scope`, `Template.organizationId` opcional, `User.isPlatformAdmin`.

- [ ] **Step 1: Escrever a migração**

`db/migrations/014_templates_por_dono.sql`:

```sql
-- 014_templates_por_dono.sql
-- Templates deixam de ser visíveis entre organizações que dividem a mesma WABA.
--
-- Dois nomes: `name` é o que o cliente vê; `meta_name` é o que existe na Meta,
-- com prefixo derivado do id da organização. O nome do template é único na
-- WABA (não por organização), então sem o prefixo dois clientes não podem ter
-- "promocao" — e o erro de nome duplicado da Meta entrega que o template do
-- outro existe.

BEGIN;

ALTER TABLE templates ADD COLUMN IF NOT EXISTS meta_name TEXT;
-- os templates que já existem são de WABA dedicada e não têm prefixo:
-- o nome na Meta é o próprio nome local
UPDATE templates SET meta_name = name WHERE meta_name IS NULL;
ALTER TABLE templates ALTER COLUMN meta_name SET NOT NULL;

COMMENT ON COLUMN templates.meta_name IS
  'Nome do template na Meta (com prefixo da organização). É este que vai no envio, nunca o name.';

ALTER TABLE templates ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'org';
ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_scope_check;
ALTER TABLE templates ADD CONSTRAINT templates_scope_check
  CHECK (scope IN ('org','platform'));

-- genérico não tem dono
ALTER TABLE templates ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_escopo_dono_check;
ALTER TABLE templates ADD CONSTRAINT templates_escopo_dono_check CHECK (
  (scope = 'org'      AND organization_id IS NOT NULL) OR
  (scope = 'platform' AND organization_id IS NULL)
);

-- o UNIQUE (organization_id, name, language) não segura os genéricos: no
-- Postgres, NULL é distinto de NULL, então dois genéricos poderiam ter o
-- mesmo nome
CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_plataforma
  ON templates (name, language) WHERE scope = 'platform';

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN users.is_platform_admin IS
  'Operação da Zaplane. O RBAC (role) é por organização; isto é acima dela.';

COMMIT;
```

- [ ] **Step 2: Editar o schema.prisma à mão**

No model `Template`, trocar a linha de `organizationId` e acrescentar duas colunas; a relação vira opcional:

```prisma
model Template {
  id             String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organizationId String?  @map("organization_id") @db.Uuid
  name           String
  metaName       String   @map("meta_name")
  scope          String   @default("org")
  language       String   @default("pt_BR")
  category       String
  status         String   @default("PENDING")
  body           String?
  variablesCount Int      @default(0) @map("variables_count")
  metaTemplateId String?  @map("meta_template_id")
  createdAt      DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt      DateTime @default(now()) @map("updated_at") @db.Timestamptz(6)

  organization Organization? @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  campaigns    Campaign[]

  @@unique([organizationId, name, language])
  @@map("templates")
}
```

No model `User`, acrescentar depois de `status`:

```prisma
  isPlatformAdmin Boolean   @default(false) @map("is_platform_admin")
```

- [ ] **Step 3: Escrever o verificador contra o banco real**

`scripts/verifica-templates-por-dono.cjs` — aplica a `014` dentro de uma transação que termina em ROLLBACK e confere os invariantes que teste unitário não alcança. Cada checagem que espera violação usa SAVEPOINT (o Postgres aborta a transação inteira no primeiro erro) e exige `code`/`constraint` (checar só "deu erro" passaria por qualquer motivo, inclusive coluna NOT NULL nova):

```js
/* Invariantes da migração 014 contra o Postgres real, em transação revertida. */
const fs = require('fs');
const { Client } = require('pg');

const MIGRACAO = 'd:/Projetos/Pessoal/meta-whatsapp-api/db/migrations/014_templates_por_dono.sql';

let ok = 0, fail = 0;
const check = (nome, cond, det = '') => {
  cond ? ok++ : fail++;
  console.log(`  ${cond ? 'PASS ' : 'FALHA'} | ${nome}${det ? ' — ' + det : ''}`);
};
const violou = (e, constraint) =>
  !!e && e.code === '23514' && e.constraint === constraint;
const violouUnico = (e, indice) =>
  !!e && e.code === '23505' && e.constraint === indice;

(async () => {
  const c = new Client({
    connectionString: process.env.PGCONN,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  await c.query('BEGIN');
  try {
    // a 014 traz o próprio BEGIN/COMMIT; remover para não fechar a transação
    const sql = fs.readFileSync(MIGRACAO, 'utf8').replace(/^\s*(BEGIN|COMMIT)\s*;\s*$/gim, '');
    await c.query(sql);
    check('014 aplica sem erro', true);

    const org = (await c.query(
      `INSERT INTO organizations (name, slug) VALUES ('T','t-1') RETURNING id`)).rows[0].id;

    // genérico com dono é rejeitado
    await c.query('SAVEPOINT s1');
    let erro = null;
    try {
      await c.query(
        `INSERT INTO templates (organization_id, name, meta_name, scope, category)
         VALUES ($1,'x','zaplane_x','platform','UTILITY')`, [org]);
    } catch (e) { erro = e; }
    await c.query('ROLLBACK TO SAVEPOINT s1');
    check('genérico com dono é rejeitado', violou(erro, 'templates_escopo_dono_check'),
      erro ? `${erro.code}/${erro.constraint}` : 'nenhum erro');

    // template de organização sem dono é rejeitado
    await c.query('SAVEPOINT s2');
    erro = null;
    try {
      await c.query(
        `INSERT INTO templates (name, meta_name, scope, category)
         VALUES ('y','zabc_y','org','UTILITY')`);
    } catch (e) { erro = e; }
    await c.query('ROLLBACK TO SAVEPOINT s2');
    check('template de org sem dono é rejeitado', violou(erro, 'templates_escopo_dono_check'),
      erro ? `${erro.code}/${erro.constraint}` : 'nenhum erro');

    // dois genéricos com o mesmo nome são rejeitados
    await c.query(
      `INSERT INTO templates (name, meta_name, scope, category)
       VALUES ('promo','zaplane_promo','platform','UTILITY')`);
    await c.query('SAVEPOINT s3');
    erro = null;
    try {
      await c.query(
        `INSERT INTO templates (name, meta_name, scope, category)
         VALUES ('promo','zaplane_promo2','platform','MARKETING')`);
    } catch (e) { erro = e; }
    await c.query('ROLLBACK TO SAVEPOINT s3');
    check('dois genéricos com o mesmo nome são rejeitados',
      violouUnico(erro, 'idx_templates_plataforma'),
      erro ? `${erro.code}/${erro.constraint}` : 'nenhum erro');

    // duas organizações PODEM ter o mesmo nome de exibição
    const org2 = (await c.query(
      `INSERT INTO organizations (name, slug) VALUES ('T2','t2-1') RETURNING id`)).rows[0].id;
    await c.query(
      `INSERT INTO templates (organization_id, name, meta_name, scope, category)
       VALUES ($1,'promoção','zaaaaaaaa_promocao','org','MARKETING')`, [org]);
    await c.query(
      `INSERT INTO templates (organization_id, name, meta_name, scope, category)
       VALUES ($1,'promoção','zbbbbbbbb_promocao','org','MARKETING')`, [org2]);
    check('duas organizações podem ter o mesmo nome de exibição', true);

    // os templates que já existiam ganharam meta_name
    const semMeta = await c.query(
      `SELECT count(*)::int n FROM templates WHERE meta_name IS NULL`);
    check('nenhum template ficou sem meta_name', semMeta.rows[0].n === 0);

    const flag = await c.query(
      `SELECT count(*)::int n FROM users WHERE is_platform_admin IS NULL`);
    check('is_platform_admin não é nula em nenhum usuário', flag.rows[0].n === 0);
  } catch (e) {
    fail++; console.log('  FALHA | erro:', e.message);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(`\n===== ${ok} PASS, ${fail} FALHA (revertido) =====`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 4: Rodar o verificador**

O pacote `pg` não está instalado na raiz do repositório; use o `node_modules` do scratchpad via `NODE_PATH`.

Run:
```bash
cd "d:/Projetos/Pessoal/meta-whatsapp-api"
SP="C:/Users/gilso/AppData/Local/Temp/claude/d--Projetos-Pessoal-meta-whatsapp-api/5f982767-08bd-4039-a05b-1ffe9471a3b9/scratchpad"
PGCONN=$(cat "$SP/pgconn.txt") NODE_PATH="$SP/node_modules" node scripts/verifica-templates-por-dono.cjs
```
Expected: `7 PASS, 0 FALHA (revertido)`

**Nunca imprima o conteúdo de `pgconn.txt`** nem escreva string de conexão em arquivo do repositório.

- [ ] **Step 5: Gerar o client e compilar**

Run: `cd services/api-gateway && npx prisma generate && npx tsc --noEmit && npx jest`
Expected: generate OK; `tsc` sem erro; 96 testes passando.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/014_templates_por_dono.sql scripts/verifica-templates-por-dono.cjs services/api-gateway/prisma/schema.prisma
git commit -m "feat(db): templates ganham meta_name e escopo, users ganham is_platform_admin"
```

---

### Task 2: Geração do nome na Meta

**Files:**
- Create: `services/api-gateway/src/templates/meta-nome.ts`
- Create: `services/api-gateway/src/templates/meta-nome.spec.ts`

**Interfaces:**
- Consumes: nada (funções puras).
- Produces: `PREFIXO_PLATAFORMA: 'zaplane'`, `prefixoDaOrg(orgId: string): string`, `normalizarNome(nome: string): string`, `metaNomeDaOrg(orgId: string, nomeExibicao: string): string`, `metaNomeDaPlataforma(nomeExibicao: string): string`, `NomeInvalidoError`.

- [ ] **Step 1: Escrever os testes que falham**

`src/templates/meta-nome.spec.ts`:

```ts
import {
  PREFIXO_PLATAFORMA, prefixoDaOrg, normalizarNome,
  metaNomeDaOrg, metaNomeDaPlataforma, NomeInvalidoError,
} from './meta-nome';

const ORG = 'cc96458b-1239-4906-b23b-45d27545b620';

describe('normalizarNome', () => {
  it('tira acento, baixa a caixa e troca separador por underscore', () => {
    expect(normalizarNome('Promoção de Banho')).toBe('promocao_de_banho');
  });

  it('colapsa repetição e apara as bordas', () => {
    expect(normalizarNome('  --Olá!!  mundo--  ')).toBe('ola_mundo');
  });

  it('rejeita nome que fica vazio depois de normalizar', () => {
    expect(() => normalizarNome('!!! ---')).toThrow(NomeInvalidoError);
  });

  it('limita o tamanho', () => {
    expect(normalizarNome('a'.repeat(300))).toHaveLength(200);
  });
});

describe('prefixoDaOrg', () => {
  it('usa z + 8 caracteres do uuid, sem hifen', () => {
    expect(prefixoDaOrg(ORG)).toBe('zcc96458b');
  });

  it('e estavel para o mesmo id', () => {
    expect(prefixoDaOrg(ORG)).toBe(prefixoDaOrg(ORG));
  });

  it('nunca colide com o prefixo da plataforma', () => {
    // 'zaplane' tem 7 caracteres; o da org tem sempre 9
    expect(prefixoDaOrg(ORG)).not.toBe(PREFIXO_PLATAFORMA);
    expect(prefixoDaOrg(ORG)).toHaveLength(9);
  });
});

describe('meta_name', () => {
  it('monta o nome da organizacao', () => {
    expect(metaNomeDaOrg(ORG, 'Promoção de Banho')).toBe('zcc96458b_promocao_de_banho');
  });

  it('monta o nome da plataforma', () => {
    expect(metaNomeDaPlataforma('Lembrete de agendamento')).toBe('zaplane_lembrete_de_agendamento');
  });

  it('so produz caracteres que a Meta aceita', () => {
    expect(metaNomeDaOrg(ORG, 'Açaí 50% OFF!!')).toMatch(/^[a-z0-9_]+$/);
  });

  it('duas organizacoes com o mesmo nome de exibicao nao colidem', () => {
    const outra = 'ffffffff-1111-2222-3333-444444444444';
    expect(metaNomeDaOrg(ORG, 'promoção')).not.toBe(metaNomeDaOrg(outra, 'promoção'));
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd services/api-gateway && npx jest meta-nome`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

`src/templates/meta-nome.ts`:

```ts
/** Nome do template na Meta.
 *
 *  O nome é único na WABA, não por organização. Sem prefixo, dois clientes não
 *  podem ter "promoção" — e o erro de nome duplicado da Meta entrega que o
 *  template do outro existe, reabrindo pelo lado dos templates o oráculo de
 *  enumeração que o catálogo `erros.ts` fecha na conexão.
 *
 *  O prefixo sai do ID da organização, não do slug: slug muda quando o cliente
 *  renomeia a empresa, e a Meta não aceita hífen em nome de template. */

/** Prefixo dos templates genéricos da Zaplane. 7 caracteres — o da organização
 *  tem sempre 9, então os dois nunca colidem. */
export const PREFIXO_PLATAFORMA = 'zaplane';

const MAX_SUFIXO = 200;

export class NomeInvalidoError extends Error {
  constructor(nome: string) {
    super(`Nome de template inválido: "${nome}"`);
    this.name = 'NomeInvalidoError';
  }
}

/** `z` + 8 caracteres do UUID. O `z` inicial evita nome começando por dígito e
 *  marca o template como gerado pela Zaplane. */
export function prefixoDaOrg(orgId: string): string {
  return 'z' + orgId.replace(/-/g, '').slice(0, 8).toLowerCase();
}

/** A Meta só aceita `[a-z0-9_]`. */
export function normalizarNome(nome: string): string {
  const semAcento = (nome ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const limpo = semAcento
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_SUFIXO)
    .replace(/_+$/g, '');
  if (!limpo) throw new NomeInvalidoError(nome);
  return limpo;
}

export function metaNomeDaOrg(orgId: string, nomeExibicao: string): string {
  return `${prefixoDaOrg(orgId)}_${normalizarNome(nomeExibicao)}`;
}

export function metaNomeDaPlataforma(nomeExibicao: string): string {
  return `${PREFIXO_PLATAFORMA}_${normalizarNome(nomeExibicao)}`;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd services/api-gateway && npx jest meta-nome`
Expected: PASS, 11 testes.

- [ ] **Step 5: Commit**

```bash
git add services/api-gateway/src/templates/meta-nome.ts services/api-gateway/src/templates/meta-nome.spec.ts
git commit -m "feat(templates): nome na Meta com prefixo derivado do id da organizacao"
```

---

### Task 3: Extrair o predicado "organização na WABA da plataforma"

**Files:**
- Create: `services/api-gateway/src/common/plataforma.service.ts`
- Create: `services/api-gateway/src/common/plataforma.service.spec.ts`
- Modify: `services/api-gateway/src/common/quota.service.ts` (método `sujeitaACota`)
- Modify: `services/api-gateway/src/common/quota.module.ts`

**Interfaces:**
- Consumes: `PrismaService`, `ConfigService`.
- Produces: `PlataformaService.orgNaWabaDaPlataforma(orgId: string): Promise<boolean>`, exportado por um módulo `@Global()`.

**Contexto:** `QuotaService.sujeitaACota()` já responde exatamente esta pergunta. Ela vira consumidora do serviço novo em vez de dona da regra — é a mesma pergunta de segurança em dois lugares, e duas cópias divergem.

- [ ] **Step 1: Escrever os testes que falham**

`src/common/plataforma.service.spec.ts`:

```ts
import { PlataformaService } from './plataforma.service';

const cfg = (wabaId: string) => ({ get: (k: string) => (k === 'assisted.wabaId' ? wabaId : undefined) } as any);
const prisma = (n: number) => ({ whatsappChannel: { count: jest.fn().mockResolvedValue(n) } } as any);

describe('PlataformaService.orgNaWabaDaPlataforma', () => {
  it('verdadeiro quando a organizacao tem canal na WABA da plataforma', async () => {
    const s = new PlataformaService(prisma(1), cfg('W'));
    expect(await s.orgNaWabaDaPlataforma('org')).toBe(true);
  });

  it('falso quando nao tem canal nenhum', async () => {
    const s = new PlataformaService(prisma(0), cfg('W'));
    expect(await s.orgNaWabaDaPlataforma('org')).toBe(false);
  });

  it('com ZAPLANE_WABA_ID vazio, ainda reconhece por connected_via', async () => {
    const p = prisma(1);
    const s = new PlataformaService(p, cfg(''));
    expect(await s.orgNaWabaDaPlataforma('org')).toBe(true);
    const where = p.whatsappChannel.count.mock.calls[0][0].where;
    // sem wabaId, o OR nao pode conter filtro por waba vazia (casaria com nada
    // e a trava sumiria para quem realmente divide a WABA)
    expect(where.OR).toEqual([{ connectedVia: 'assisted' }]);
  });

  it('com ZAPLANE_WABA_ID definido, consulta os dois criterios', async () => {
    const p = prisma(1);
    const s = new PlataformaService(p, cfg('W'));
    await s.orgNaWabaDaPlataforma('org');
    const where = p.whatsappChannel.count.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ wabaId: 'W' }, { connectedVia: 'assisted' }]);
    expect(where.organizationId).toBe('org');
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd services/api-gateway && npx jest plataforma.service`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar o serviço**

`src/common/plataforma.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/** "Esta organização envia pela WABA da Zaplane?"
 *
 *  Pergunta de segurança usada em mais de um lugar: decide quem está sujeito à
 *  cota diária (o limite da Meta é do portfólio e compartilhado) e quem enxerga
 *  os templates genéricos (template pertence a uma WABA, e um número só dispara
 *  template da WABA dele). Mora aqui, sozinha, porque duas cópias divergem.
 *
 *  Critério duplo de propósito: `waba_id` casa com a configuração, e
 *  `connected_via = 'assisted'` está gravado na própria linha do canal — é ele
 *  que segura a regra de pé quando `ZAPLANE_WABA_ID` está vazio.
 *
 *  Sem filtro de `status`: a vaga do número na WABA não volta por API, então um
 *  canal assistido desativado continua sendo um número da plataforma. */
@Injectable()
export class PlataformaService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  async orgNaWabaDaPlataforma(orgId: string): Promise<boolean> {
    const wabaId = this.config.get<string>('assisted.wabaId') || '';
    const n = await this.prisma.whatsappChannel.count({
      where: {
        organizationId: orgId,
        OR: [...(wabaId ? [{ wabaId }] : []), { connectedVia: 'assisted' }],
      },
    });
    return n > 0;
  }
}
```

- [ ] **Step 4: Fazer a QuotaService consumir o serviço**

Em `src/common/quota.service.ts`: injetar `PlataformaService` no construtor e substituir o corpo de `sujeitaACota` pela delegação, preservando o comentário que explica **por que** a cota existe (ele é sobre a cota, não sobre o predicado):

```ts
  async sujeitaACota(orgId: string): Promise<boolean> {
    return this.plataforma.orgNaWabaDaPlataforma(orgId);
  }
```

O comentário longo que hoje descreve as duas bordas (`wabaId` vazio, organização sem canal) migra para `plataforma.service.ts`, onde a regra passa a morar — não duplique nos dois arquivos.

- [ ] **Step 5: Registrar no módulo**

Em `src/common/quota.module.ts`, acrescentar `PlataformaService` a `providers` e a `exports` (o módulo já é `@Global()`, então `TemplatesService` e o guard alcançam sem novo import).

- [ ] **Step 6: Rodar tudo**

Run: `cd services/api-gateway && npx jest && npx tsc --noEmit`
Expected: todos passando, incluindo os testes já existentes de `quota.service.spec.ts` sem alteração — se algum deles quebrar, a extração mudou comportamento e precisa ser corrigida, não o teste.

- [ ] **Step 7: Commit**

```bash
git add services/api-gateway/src/common/plataforma.service.ts services/api-gateway/src/common/plataforma.service.spec.ts services/api-gateway/src/common/quota.service.ts services/api-gateway/src/common/quota.module.ts
git commit -m "refactor(common): predicado da WABA da plataforma sai da cota para um servico proprio"
```

---

### Task 4: Guard de admin de plataforma

**Files:**
- Create: `services/api-gateway/src/common/decorators/plataforma-admin.decorator.ts`
- Create: `services/api-gateway/src/common/guards/plataforma-admin.guard.ts`
- Create: `services/api-gateway/src/common/guards/plataforma-admin.guard.spec.ts`
- Modify: `services/api-gateway/src/channels/assisted/assisted.controller.ts` (rota `GET orphans`)

**Interfaces:**
- Consumes: `PrismaService`, `Reflector`, `User.isPlatformAdmin` (Task 1).
- Produces: decorator `@PlataformaAdmin()` e `PlataformaAdminGuard`.

**Contexto:** o RBAC só tem papéis **dentro** da organização, então `@Roles('owner')` na rota de órfãos é alcançável pelo dono de qualquer cliente — e a resposta dela é de plataforma. Esse residual ficou anotado na revisão final da conexão assistida.

- [ ] **Step 1: Escrever os testes que falham**

`src/common/guards/plataforma-admin.guard.spec.ts`:

```ts
import { ForbiddenException } from '@nestjs/common';
import { PlataformaAdminGuard } from './plataforma-admin.guard';

const ctx = (user: any) => ({
  switchToHttp: () => ({ getRequest: () => ({ user }) }),
  getHandler: () => ({}),
  getClass: () => ({}),
}) as any;

const reflector = (exigido: boolean) => ({ getAllAndOverride: () => exigido } as any);
const prisma = (u: any) => ({ user: { findUnique: jest.fn().mockResolvedValue(u) } } as any);

describe('PlataformaAdminGuard', () => {
  it('libera rota que nao exige admin de plataforma', async () => {
    const g = new PlataformaAdminGuard(reflector(false), prisma(null));
    expect(await g.canActivate(ctx({ userId: 'u' }))).toBe(true);
  });

  it('libera admin de plataforma ativo', async () => {
    const g = new PlataformaAdminGuard(reflector(true), prisma({ isPlatformAdmin: true, status: 'active' }));
    expect(await g.canActivate(ctx({ userId: 'u' }))).toBe(true);
  });

  it('barra owner de cliente comum', async () => {
    const g = new PlataformaAdminGuard(reflector(true), prisma({ isPlatformAdmin: false, status: 'active' }));
    await expect(g.canActivate(ctx({ userId: 'u', role: 'owner' }))).rejects.toThrow(ForbiddenException);
  });

  it('barra admin de plataforma desativado', async () => {
    const g = new PlataformaAdminGuard(reflector(true), prisma({ isPlatformAdmin: true, status: 'disabled' }));
    await expect(g.canActivate(ctx({ userId: 'u' }))).rejects.toThrow(ForbiddenException);
  });

  it('barra usuario que nao existe mais', async () => {
    const g = new PlataformaAdminGuard(reflector(true), prisma(null));
    await expect(g.canActivate(ctx({ userId: 'u' }))).rejects.toThrow(ForbiddenException);
  });

  it('le do BANCO, nao do JWT', async () => {
    // um token emitido antes de a flag ser revogada nao pode continuar valendo
    const p = prisma({ isPlatformAdmin: false, status: 'active' });
    const g = new PlataformaAdminGuard(reflector(true), p);
    await expect(g.canActivate(ctx({ userId: 'u', isPlatformAdmin: true }))).rejects.toThrow(ForbiddenException);
    expect(p.user.findUnique).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd services/api-gateway && npx jest plataforma-admin`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar o decorator**

`src/common/decorators/plataforma-admin.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';

export const PLATAFORMA_ADMIN_KEY = 'plataformaAdmin';

/** Marca a rota como ação da operação da Zaplane, acima do RBAC da organização. */
export const PlataformaAdmin = () => SetMetadata(PLATAFORMA_ADMIN_KEY, true);
```

- [ ] **Step 4: Implementar o guard**

`src/common/guards/plataforma-admin.guard.ts`:

```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { PLATAFORMA_ADMIN_KEY } from '../decorators/plataforma-admin.decorator';

/** Autoriza ação de plataforma.
 *
 *  O RBAC do projeto tem papéis DENTRO da organização (owner/admin/operator/
 *  viewer), então `@Roles('owner')` é alcançável pelo dono de qualquer cliente.
 *  Rota de plataforma precisa de outro eixo.
 *
 *  Lê a flag do BANCO e não do JWT de propósito: com a flag no token, revogar o
 *  acesso só teria efeito quando o token expirasse. São duas rotas raras, o
 *  custo da consulta é irrelevante. */
@Injectable()
export class PlataformaAdminGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const exigido = this.reflector.getAllAndOverride<boolean>(PLATAFORMA_ADMIN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!exigido) return true;

    const { user } = context.switchToHttp().getRequest();
    const negar = () => {
      throw new ForbiddenException('Ação restrita à operação da Zaplane.');
    };
    if (!user?.userId) return negar();

    const u = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { isPlatformAdmin: true, status: true },
    });
    if (!u || !u.isPlatformAdmin || u.status !== 'active') return negar();
    return true;
  }
}
```

- [ ] **Step 5: Proteger a rota de órfãos**

Em `src/channels/assisted/assisted.controller.ts`: acrescentar `PlataformaAdminGuard` ao `@UseGuards(...)` da classe, trocar `@Roles('owner')` da rota `orphans` por `@PlataformaAdmin()`, e atualizar o comentário do método — ele hoje explica por que `owner` bastava, e passa a explicar que a rota é de plataforma. Mantenha o `@Throttle` como está.

- [ ] **Step 6: Rodar e confirmar**

Run: `cd services/api-gateway && npx jest && npx tsc --noEmit`
Expected: 6 testes novos passando; nenhum dos existentes quebrado (`assisted.controller.spec.ts` inclusive — se ele asserta o papel da rota de órfãos, ajuste o teste ao comportamento novo e diga isso no relatório).

- [ ] **Step 7: Commit**

```bash
git add services/api-gateway/src/common/decorators/plataforma-admin.decorator.ts services/api-gateway/src/common/guards/plataforma-admin.guard.ts services/api-gateway/src/common/guards/plataforma-admin.guard.spec.ts services/api-gateway/src/channels/assisted/assisted.controller.ts
git commit -m "feat(auth): guard de admin de plataforma e rota de orfaos fora do RBAC da organizacao"
```

---

### Task 5: Credenciais da Meta por canal

**Files:**
- Modify: `services/api-gateway/src/templates/templates.service.ts`
- Create: `services/api-gateway/src/templates/templates.service.spec.ts`
- Modify: `services/api-gateway/src/templates/templates.module.ts`

**Interfaces:**
- Consumes: `whatsapp.accessToken`, `assisted.wabaId`, `whatsapp.graphVersion`.
- Produces: método privado `resolverCredenciais(orgId): Promise<{ wabaId: string; token: string; plataforma: boolean } | null>`, consumido por `sync()` (Task 6) e `create()` (Task 7).

**Contexto:** hoje `sync()` e `submitToMeta()` leem `channel.accessTokenEnc`. No canal assistido essa coluna nasce **vazia** de propósito — o token é da plataforma. Por isso os dois caem em "Sem canal Meta configurado" e um cliente assistido não consegue usar template nenhum.

- [ ] **Step 1: Escrever os testes que falham**

`src/templates/templates.service.spec.ts`:

```ts
import { TemplatesService } from './templates.service';

const cfg = (vals: Record<string, any>) => ({ get: (k: string) => vals[k] } as any);
const COMPLETA = {
  'whatsapp.graphVersion': 'v21.0',
  'whatsapp.accessToken': 'TOKEN_PLATAFORMA',
  'assisted.wabaId': 'WABA_ZAPLANE',
  assisted: { wabaId: 'WABA_ZAPLANE' },
};
const prismaCom = (canal: any) =>
  ({ whatsappChannel: { findFirst: jest.fn().mockResolvedValue(canal) } } as any);

describe('TemplatesService.resolverCredenciais', () => {
  const resolver = (s: TemplatesService, orgId = 'org') => (s as any).resolverCredenciais(orgId);

  it('canal assistido usa token e WABA da plataforma', async () => {
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'assisted', wabaId: 'WABA_ZAPLANE', accessTokenEnc: '' }),
      cfg(COMPLETA), {} as any,
    );
    expect(await resolver(s)).toEqual({ wabaId: 'WABA_ZAPLANE', token: 'TOKEN_PLATAFORMA', plataforma: true });
  });

  it('canal legado usa a WABA e o token da propria linha', async () => {
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'manual', wabaId: 'WABA_CLIENTE', accessTokenEnc: 'TOKEN_CLIENTE' }),
      cfg(COMPLETA), {} as any,
    );
    expect(await resolver(s)).toEqual({ wabaId: 'WABA_CLIENTE', token: 'TOKEN_CLIENTE', plataforma: false });
  });

  it('canal na WABA da plataforma sem connected_via assistido tambem usa a plataforma', async () => {
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'manual', wabaId: 'WABA_ZAPLANE', accessTokenEnc: '' }),
      cfg(COMPLETA), {} as any,
    );
    expect((await resolver(s))?.plataforma).toBe(true);
  });

  it('canal assistido sem token da plataforma devolve nulo em vez de chamar a Meta com token vazio', async () => {
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'assisted', wabaId: 'WABA_ZAPLANE', accessTokenEnc: '' }),
      cfg({ ...COMPLETA, 'whatsapp.accessToken': '' }), {} as any,
    );
    expect(await resolver(s)).toBeNull();
  });

  it('sem canal ativo devolve nulo', async () => {
    const s = new TemplatesService(prismaCom(null), cfg(COMPLETA), {} as any);
    expect(await resolver(s)).toBeNull();
  });

  it('canal legado com placeholder de seed devolve nulo', async () => {
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'manual', wabaId: 'COLOQUE_AQUI', accessTokenEnc: 'COLOQUE_AQUI' }),
      cfg(COMPLETA), {} as any,
    );
    expect(await resolver(s)).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd services/api-gateway && npx jest templates.service`
Expected: FAIL — `resolverCredenciais` não existe.

- [ ] **Step 3: Implementar**

Em `templates.service.ts`, acrescentar `PlataformaService` como terceiro parâmetro do construtor (usado na Task 8) e o método privado:

```ts
  /** Qual WABA e qual token esta organização usa para falar com a Meta.
   *
   *  No canal assistido, `access_token_enc` nasce VAZIO de propósito: o token é
   *  da plataforma, não do cliente. Ler a linha do canal aqui é o que faz o
   *  cliente assistido não conseguir usar template nenhum hoje. */
  private async resolverCredenciais(
    orgId: string,
  ): Promise<{ wabaId: string; token: string; plataforma: boolean } | null> {
    const canal = await this.prisma.whatsappChannel.findFirst({
      where: { organizationId: orgId, status: 'active' },
      // determinístico (oldest-first) quando houver mais de um canal ativo
      orderBy: { createdAt: 'asc' },
    });
    if (!canal) return null;

    const wabaPlataforma = this.config.get<string>('assisted.wabaId') || '';
    const daPlataforma =
      canal.connectedVia === 'assisted' || (!!wabaPlataforma && canal.wabaId === wabaPlataforma);

    if (daPlataforma) {
      const token = this.config.get<string>('whatsapp.accessToken') || '';
      // sem credencial da plataforma, falhar fechado: chamar a Meta com token
      // vazio devolveria erro de permissão disfarçado de erro de template
      if (!wabaPlataforma || !token) return null;
      return { wabaId: wabaPlataforma, token, plataforma: true };
    }

    if (!looksConfigured(canal.wabaId) || !looksConfigured(canal.accessTokenEnc)) return null;
    return { wabaId: canal.wabaId, token: readToken(canal.accessTokenEnc), plataforma: false };
  }
```

Trocar o corpo de `sync()` e de `submitToMeta()` para usarem `resolverCredenciais(orgId)` no lugar da busca de canal e da leitura de token que fazem hoje. A mensagem de retorno de `sync()` quando não há credencial continua sendo `{ synced: false, note: 'Sem canal Meta configurado nesta organização.' }`.

- [ ] **Step 4: Registrar a dependência**

Em `templates.module.ts` nada muda: `PlataformaService` é exportado por um módulo `@Global()` (Task 3).

- [ ] **Step 5: Rodar e confirmar**

Run: `cd services/api-gateway && npx jest && npx tsc --noEmit`
Expected: 6 testes novos passando, nenhum existente quebrado.

- [ ] **Step 6: Commit**

```bash
git add services/api-gateway/src/templates/templates.service.ts services/api-gateway/src/templates/templates.service.spec.ts
git commit -m "fix(templates): canal assistido passa a usar o token e a WABA da plataforma"
```

---

### Task 6: Sincronização com as duas regras

**Files:**
- Modify: `services/api-gateway/src/templates/templates.service.ts` (método `sync`)
- Modify: `services/api-gateway/src/templates/templates.service.spec.ts`

**Interfaces:**
- Consumes: `resolverCredenciais` (Task 5), `prefixoDaOrg`/`PREFIXO_PLATAFORMA` (Task 2).
- Produces: `sync(orgId)` devolvendo `{ synced: true, total, atualizados, criados, ignorados }`.

**Contexto:** é a tarefa que fecha o vazamento. Hoje o `sync()` grava na organização de quem chamou **tudo** que encontra na WABA. Em produção, a WABA `1546948303766181` tem canais de duas organizações diferentes, então cada uma já importa os templates da outra.

- [ ] **Step 1: Escrever o teste do vazamento (falha)**

Acrescentar a `src/templates/templates.service.spec.ts`:

```ts
describe('TemplatesService.sync — isolamento', () => {
  const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000000';
  const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000000';

  // a WABA tem: um template da org A, um da org B, um generico e um sem prefixo
  const remotos = [
    { name: 'zaaaaaaaa_promocao', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING', id: 'm1', components: [{ type: 'BODY', text: 'oi {{1}}' }] },
    { name: 'zbbbbbbbb_promocao', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING', id: 'm2', components: [{ type: 'BODY', text: 'ola' }] },
    { name: 'zaplane_lembrete',   language: 'pt_BR', status: 'APPROVED', category: 'UTILITY',   id: 'm3', components: [{ type: 'BODY', text: 'lembrete' }] },
    { name: 'hello_world',        language: 'en_US', status: 'APPROVED', category: 'UTILITY',   id: 'm4', components: [{ type: 'BODY', text: 'hi' }] },
  ];

  function servico(orgId: string, conhecidos: any[] = []) {
    const criados: any[] = [];
    const prisma: any = {
      whatsappChannel: {
        findFirst: jest.fn().mockResolvedValue({
          connectedVia: 'manual', wabaId: 'WABA_COMPARTILHADA', accessTokenEnc: 'TOKEN',
        }),
      },
      template: {
        findFirst: jest.fn(({ where }: any) =>
          Promise.resolve(conhecidos.find((t) => t.metaTemplateId === where.metaTemplateId) ?? null)),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn((args: any) => { criados.push(args.data); return Promise.resolve(args.data); }),
      },
    };
    const s = new TemplatesService(prisma, cfg(COMPLETA), {} as any);
    (s as any).buscarRemotos = jest.fn().mockResolvedValue(remotos);
    return { s, prisma, criados, orgId };
  }

  it('a organizacao A nao importa o template da organizacao B', async () => {
    const { s, criados } = servico(ORG_A);
    await s.sync(ORG_A);
    const nomes = criados.map((t) => t.metaName);
    expect(nomes).toContain('zaaaaaaaa_promocao');
    expect(nomes).not.toContain('zbbbbbbbb_promocao');
  });

  it('template sem prefixo e desconhecido nao vira linha de ninguem', async () => {
    const { s, criados } = servico(ORG_A);
    await s.sync(ORG_A);
    expect(criados.map((t) => t.metaName)).not.toContain('hello_world');
  });

  it('generico entra com escopo de plataforma e sem dono', async () => {
    const { s, criados } = servico(ORG_A);
    await s.sync(ORG_A);
    const generico = criados.find((t) => t.metaName === 'zaplane_lembrete');
    expect(generico.scope).toBe('platform');
    expect(generico.organizationId).toBeNull();
  });

  it('template da organizacao entra com escopo org e com dono', async () => {
    const { s, criados } = servico(ORG_A);
    await s.sync(ORG_A);
    const meu = criados.find((t) => t.metaName === 'zaaaaaaaa_promocao');
    expect(meu.scope).toBe('org');
    expect(meu.organizationId).toBe(ORG_A);
  });

  it('template ja rastreado por meta_template_id continua sendo atualizado, mesmo sem prefixo', async () => {
    const conhecido = { id: 'local-1', metaTemplateId: 'm4' };
    const { s, prisma } = servico(ORG_A, [conhecido]);
    await s.sync(ORG_A);
    expect(prisma.template.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'local-1' } }),
    );
  });

  it('conta os ignorados', async () => {
    const { s } = servico(ORG_A);
    const r: any = await s.sync(ORG_A);
    // dos 4 remotos: 1 da org A, 1 generico, 1 da org B ignorado, 1 sem prefixo ignorado
    expect(r.criados).toBe(2);
    expect(r.ignorados).toBe(2);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd services/api-gateway && npx jest templates.service`
Expected: FAIL — o `sync` atual importa tudo e não conhece `scope`/`metaName`.

- [ ] **Step 3: Extrair a busca dos remotos**

Ainda em `templates.service.ts`, separar a paginação num método próprio para o teste poder substituí-lo (é o mesmo laço de hoje, com `paging.next`, teto de 10 páginas e o `try/catch` que vira `{ synced: false, note }`):

```ts
  /** GET /{waba}/message_templates, paginado. Separado de `sync` para o teste
   *  poder exercitar a regra de importação sem falar com a rede. */
  private async buscarRemotos(wabaId: string, token: string): Promise<any[]> {
    const version = this.config.get<string>('whatsapp.graphVersion');
    const remotos: any[] = [];
    let url: string | undefined =
      `https://graph.facebook.com/${version}/${wabaId}/message_templates?limit=100`;
    let paginas = 0;
    while (url && paginas < 10) {
      const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
      remotos.push(...(data?.data ?? []));
      url = data?.paging?.next;
      paginas++;
    }
    return remotos;
  }
```

- [ ] **Step 4: Reescrever a regra de importação**

O laço de `sync()` passa a decidir por três caminhos, nesta ordem:

```ts
    const prefixoOrg = prefixoDaOrg(orgId);
    let atualizados = 0, criados = 0, ignorados = 0;

    for (const r of remotos) {
      if (!r?.name || !r?.language) { ignorados++; continue; }

      const body: string | null =
        (r.components ?? []).find((c: any) => c?.type === 'BODY')?.text ?? null;
      const campos = {
        category: r.category ?? 'MARKETING',
        status: statusLocal(r.status),
        ...(body != null ? { body, variablesCount: countVariables(body) } : {}),
      };

      // 1) já rastreado: atualiza. É o que mantém o legado funcionando,
      //    inclusive templates sem prefixo criados antes desta mudança.
      const conhecido = r.id
        ? await this.prisma.template.findFirst({ where: { metaTemplateId: r.id } })
        : null;
      if (conhecido) {
        await this.prisma.template.update({ where: { id: conhecido.id }, data: campos });
        atualizados++;
        continue;
      }

      // 2) carrega o prefixo desta organização, ou o dos genéricos.
      //    Qualquer outra coisa é template de outro cliente: NÃO vira linha de
      //    ninguém — é este `continue` que fecha o vazamento.
      const daOrg = r.name.startsWith(`${prefixoOrg}_`);
      const daPlataforma = r.name.startsWith(`${PREFIXO_PLATAFORMA}_`);
      if (!daOrg && !daPlataforma) { ignorados++; continue; }

      await this.prisma.template.create({
        data: {
          organizationId: daPlataforma ? null : orgId,
          scope: daPlataforma ? 'platform' : 'org',
          name: r.name.slice((daPlataforma ? PREFIXO_PLATAFORMA : prefixoOrg).length + 1),
          metaName: r.name,
          language: r.language,
          body,
          variablesCount: body != null ? countVariables(body) : 0,
          category: campos.category,
          status: campos.status,
          metaTemplateId: r.id ?? null,
        },
      });
      criados++;
    }

    return { synced: true, total: remotos.length, atualizados, criados, ignorados };
```

A busca do conhecido é por `metaTemplateId` global e não por `(org, name, language)`: o id da Meta é único e já diz de quem é a linha; buscar por nome dentro da organização recriaria o problema que a tarefa resolve.

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `cd services/api-gateway && npx jest && npx tsc --noEmit`
Expected: os 6 testes novos passando, nenhum existente quebrado.

- [ ] **Step 6: Commit**

```bash
git add services/api-gateway/src/templates/templates.service.ts services/api-gateway/src/templates/templates.service.spec.ts
git commit -m "fix(templates): sync deixa de importar template de outra organizacao"
```

---

### Task 7: Criação com `meta_name` e escopo de plataforma

**Files:**
- Modify: `services/api-gateway/src/templates/dto/create-template.dto.ts`
- Modify: `services/api-gateway/src/templates/templates.service.ts` (métodos `create` e `submitToMeta`)
- Modify: `services/api-gateway/src/templates/templates.controller.ts`
- Modify: `services/api-gateway/src/templates/templates.service.spec.ts`

**Interfaces:**
- Consumes: `metaNomeDaOrg`/`metaNomeDaPlataforma` (Task 2), `resolverCredenciais` (Task 5), `@PlataformaAdmin()` (Task 4).
- Produces: `create(orgId, dto, opts: { plataforma: boolean })`.

- [ ] **Step 1: Relaxar o DTO**

Hoje o DTO exige `^[a-z0-9_]+$` no `name` — isso fazia sentido quando o nome ia direto para a Meta. Agora o `name` é o rótulo que o cliente lê, e o `meta_name` é gerado. Substituir a validação:

```ts
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateTemplateDto {
  // rótulo que o cliente lê; o nome que vai para a Meta é gerado a partir dele
  // (ver meta-nome.ts), porque a Meta só aceita [a-z0-9_] e o nome é único na WABA
  @IsString() @MinLength(1) @MaxLength(200)
  name!: string;

  @IsIn(['MARKETING', 'UTILITY', 'AUTHENTICATION'])
  category!: string;

  @IsOptional() @IsString()
  language?: string;

  @IsString() @MinLength(1)
  body!: string;
}
```

O escopo **não** entra no DTO: ele vem da rota, não do corpo — pelo mesmo motivo que `organizationId` vem do JWT.

- [ ] **Step 2: Escrever os testes que falham**

Acrescentar a `templates.service.spec.ts`:

```ts
describe('TemplatesService.create', () => {
  const ORG = 'cc96458b-1239-4906-b23b-45d27545b620';

  function servico() {
    const criado: any = {};
    const prisma: any = {
      whatsappChannel: { findFirst: jest.fn().mockResolvedValue({
        connectedVia: 'assisted', wabaId: 'WABA_ZAPLANE', accessTokenEnc: '' }) },
      template: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn((a: any) => { Object.assign(criado, a.data); return Promise.resolve({ id: 't1', ...a.data }); }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const s = new TemplatesService(prisma, cfg(COMPLETA), {} as any);
    (s as any).submitToMeta = jest.fn().mockResolvedValue({ id: 'meta-1' });
    return { s, prisma, criado };
  }

  const dto = { name: 'Promoção de Banho', category: 'MARKETING', body: 'Oi {{1}}' } as any;

  it('grava o nome de exibicao e o meta_name prefixado', async () => {
    const { s, criado } = servico();
    await s.create(ORG, dto, { plataforma: false });
    expect(criado.name).toBe('Promoção de Banho');
    expect(criado.metaName).toBe('zcc96458b_promocao_de_banho');
    expect(criado.scope).toBe('org');
    expect(criado.organizationId).toBe(ORG);
  });

  it('generico nasce sem dono e com prefixo da plataforma', async () => {
    const { s, criado } = servico();
    await s.create(ORG, { ...dto, name: 'Lembrete de agendamento' }, { plataforma: true });
    expect(criado.metaName).toBe('zaplane_lembrete_de_agendamento');
    expect(criado.scope).toBe('platform');
    expect(criado.organizationId).toBeNull();
  });

  it('submete a Meta o meta_name, nunca o nome de exibicao', async () => {
    const { s } = servico();
    await s.create(ORG, dto, { plataforma: false });
    const enviado = (s as any).submitToMeta.mock.calls[0][1];
    expect(enviado.metaName).toBe('zcc96458b_promocao_de_banho');
  });

  it('nome que fica vazio depois de normalizar vira 400, sem gravar nada', async () => {
    const { s, prisma } = servico();
    await expect(s.create(ORG, { ...dto, name: '!!! ---' }, { plataforma: false }))
      .rejects.toThrow(BadRequestException);
    expect(prisma.template.create).not.toHaveBeenCalled();
  });
});
```

Acrescentar `BadRequestException` aos imports do arquivo de teste.

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `cd services/api-gateway && npx jest templates.service`
Expected: FAIL.

- [ ] **Step 4: Implementar**

Em `create()`:

```ts
  async create(orgId: string, dto: CreateTemplateDto, opts: { plataforma: boolean }) {
    const language = dto.language ?? 'pt_BR';
    const variablesCount = countVariables(dto.body);

    let metaName: string;
    try {
      metaName = opts.plataforma
        ? metaNomeDaPlataforma(dto.name)
        : metaNomeDaOrg(orgId, dto.name);
    } catch (e) {
      if (e instanceof NomeInvalidoError) {
        throw new BadRequestException(
          'Dê ao template um nome com letras ou números.',
        );
      }
      throw e;
    }

    const exists = await this.prisma.template.findFirst(
      opts.plataforma
        ? { where: { scope: 'platform', name: dto.name, language } }
        : { where: { organizationId: orgId, name: dto.name, language } },
    );
    if (exists) throw new ConflictException('Já existe um template com esse nome e idioma.');

    const template = await this.prisma.template.create({
      data: {
        organizationId: opts.plataforma ? null : orgId,
        scope: opts.plataforma ? 'platform' : 'org',
        name: dto.name,
        metaName,
        language,
        category: dto.category,
        status: 'PENDING',
        body: dto.body,
        variablesCount,
      },
    });
    // ...o resto (submissão best-effort, metaWarning) continua como está,
    // passando `template` para submitToMeta
  }
```

Em `submitToMeta()`, trocar `name: template.name` por `name: template.metaName` e usar `resolverCredenciais(orgId)` (Task 5) no lugar da busca de canal.

- [ ] **Step 5: Ligar a rota**

Em `templates.controller.ts`, a rota existente passa `{ plataforma: false }`, e nasce uma rota de plataforma:

```ts
  @Post()
  @Roles('owner', 'admin', 'operator')
  create(@CurrentUser('organizationId') orgId: string, @Body() dto: CreateTemplateDto) {
    return this.templates.create(orgId, dto, { plataforma: false });
  }

  /** Template genérico da Zaplane: aprovado uma vez, serve todos os clientes
   *  assistidos. Ação de operação, não de cliente — daí o guard de plataforma
   *  e não o RBAC da organização. */
  @Post('platform')
  @PlataformaAdmin()
  criarGenerico(@CurrentUser('organizationId') orgId: string, @Body() dto: CreateTemplateDto) {
    return this.templates.create(orgId, dto, { plataforma: true });
  }
```

Acrescentar `PlataformaAdminGuard` ao `@UseGuards(...)` da classe e importar o decorator.

`orgId` continua sendo passado no caso genérico porque `resolverCredenciais` precisa dele para achar a WABA — mas ele **não** vira dono do template.

- [ ] **Step 6: Rodar e confirmar**

Run: `cd services/api-gateway && npx jest && npx tsc --noEmit`
Expected: tudo passando.

- [ ] **Step 7: Commit**

```bash
git add services/api-gateway/src/templates/
git commit -m "feat(templates): criacao gera o nome da Meta e aceita escopo de plataforma"
```

---

### Task 8: Leitura e envio

**Files:**
- Modify: `services/api-gateway/src/templates/templates.service.ts` (método `findAll`)
- Modify: `services/api-gateway/src/campaigns/campaigns.service.ts` (busca do template e `buildTemplatePayload`)
- Modify: `services/api-gateway/src/messages/messages.service.ts` (busca do template e payload)
- Modify: `services/api-gateway/src/templates/templates.service.spec.ts`
- Modify: `services/api-gateway/src/messages/messages.service.spec.ts`

**Interfaces:**
- Consumes: `PlataformaService.orgNaWabaDaPlataforma` (Task 3), `Template.metaName`/`Template.scope` (Task 1).
- Produces: nada para tarefas seguintes.

**Contexto:** template pertence a uma WABA, e um número só dispara template da WABA dele. O genérico vive na WABA da Zaplane, então mostrá-lo a um cliente de WABA própria faria o disparo morrer na Meta com "template não encontrado".

- [ ] **Step 1: Escrever os testes que falham**

Em `templates.service.spec.ts`:

```ts
describe('TemplatesService.findAll', () => {
  const consulta = async (naPlataforma: boolean) => {
    const prisma: any = { template: { findMany: jest.fn().mockResolvedValue([]) } };
    const plataforma: any = { orgNaWabaDaPlataforma: jest.fn().mockResolvedValue(naPlataforma) };
    const s = new TemplatesService(prisma, cfg(COMPLETA), plataforma);
    await s.findAll('org');
    return prisma.template.findMany.mock.calls[0][0].where;
  };

  it('cliente da WABA da plataforma ve os proprios e os genericos', async () => {
    expect(await consulta(true)).toEqual({
      OR: [{ organizationId: 'org' }, { scope: 'platform' }],
    });
  });

  it('cliente de WABA propria NAO ve generico', async () => {
    // generico vive na WABA da Zaplane; disparar de outra WABA morre na Meta
    expect(await consulta(false)).toEqual({ organizationId: 'org' });
  });
});
```

Em `messages.service.spec.ts`, acrescentar:

```ts
  it('envia o meta_name, nunca o nome de exibicao', async () => {
    // (montar o serviço como os testes existentes do arquivo já fazem, com um
    //  template { name: 'Promoção', metaName: 'zcc96458b_promocao' })
    // e afirmar sobre o payload gravado em outbound_messages:
    expect(payload.template.name).toBe('zcc96458b_promocao');
  });
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd services/api-gateway && npx jest templates.service messages.service`
Expected: FAIL.

- [ ] **Step 3: Implementar `findAll`**

```ts
  /** Os templates da organização, mais os genéricos — estes só quando ela envia
   *  pela WABA da Zaplane, que é onde os genéricos vivem. */
  async findAll(orgId: string) {
    const veGenericos = await this.plataforma.orgNaWabaDaPlataforma(orgId);
    return this.prisma.template.findMany({
      where: veGenericos
        ? { OR: [{ organizationId: orgId }, { scope: 'platform' }] }
        : { organizationId: orgId },
      orderBy: { name: 'asc' },
    });
  }
```

- [ ] **Step 4: Implementar a busca e o envio nos dois consumidores**

Em `campaigns.service.ts` e `messages.service.ts`, a busca do template deixa de ser `findFirst({ where: { id, organizationId: orgId } })` — que nunca acharia um genérico, porque genérico não tem dono — e passa a ser:

```ts
    const template = await this.prisma.template.findFirst({
      where: {
        id: dto.templateId,
        OR: [
          { organizationId: orgId },
          // genérico só serve a quem envia pela WABA onde ele vive
          ...((await this.plataforma.orgNaWabaDaPlataforma(orgId)) ? [{ scope: 'platform' }] : []),
        ],
      },
    });
```

E o payload passa a usar `template.metaName`:

```ts
        name: template.metaName,
```

nos dois lugares (`campaigns.service.ts:243` e `messages.service.ts:43`).

Injetar `PlataformaService` nos dois serviços (módulo `@Global()`, sem import novo).

- [ ] **Step 5: Rodar e confirmar**

Run: `cd services/api-gateway && npx jest && npx tsc --noEmit`
Expected: tudo passando.

- [ ] **Step 6: Commit**

```bash
git add services/api-gateway/src/templates/ services/api-gateway/src/campaigns/campaigns.service.ts services/api-gateway/src/messages/
git commit -m "feat(templates): listagem inclui genericos e o envio usa o nome da Meta"
```

---

### Task 9: Sincronizar após conectar canal assistido, e documentar

**Files:**
- Modify: `services/api-gateway/src/channels/assisted/assisted.service.ts` (depois de criar o canal)
- Modify: `docs/RAILWAY-MIGRATION.md`
- Modify: `docs/superpowers/specs/2026-08-13-conexao-assistida-design.md` (§11)

**Interfaces:**
- Consumes: `TemplatesService.sync` (Task 6).
- Produces: nada.

**Contexto:** o spec da conexão assistida registrou em §11 que o fluxo assistido **não** podia chamar `templates.sync` até o namespacing existir. Com as Tasks 6 e 7 no lugar, a trava sai — e passa a ser necessária, porque é o sync que traz os genéricos para o cliente recém-conectado.

- [ ] **Step 1: Chamar o sync ao fim da conexão**

Em `assisted.service.ts`, logo depois de o canal ser criado com sucesso (o mesmo ponto onde a auditoria `channel.connect.registered` é gravada), acrescentar a chamada em best-effort — falha aqui **não** pode desfazer a conexão nem virar erro para o cliente, porque a vaga do número já foi consumida:

```ts
    // Traz os genéricos da plataforma para o cliente recém-conectado. Falha aqui
    // não desfaz nada: o número já está registrado e a vaga já foi consumida.
    try {
      await this.templates.sync(orgId);
    } catch (e) {
      this.logger.warn(`sync de templates falhou após conectar (org ${orgId}): ${e}`);
    }
```

Injetar `TemplatesService` (o `ChannelsModule` já importa `TemplatesModule`, que o exporta).

- [ ] **Step 2: Escrever o teste**

Em `assisted.service.spec.ts`, no caminho feliz que já existe, afirmar que o sync foi chamado, e acrescentar um caso em que o sync rejeita e a conexão termina com sucesso mesmo assim:

```ts
  it('falha do sync de templates nao derruba a conexao', async () => {
    // (montar como o teste de caminho feliz existente, com
    //  templates.sync = jest.fn().mockRejectedValue(new Error('meta fora')))
    const resultado = await svc.verificar(ORG, ID, { codigo: '123456' } as any);
    expect(resultado.canalId).toBeDefined();
  });
```

- [ ] **Step 3: Atualizar a documentação**

Em `docs/RAILWAY-MIGRATION.md`: acrescentar a `014_templates_por_dono.sql` à lista ordenada de migrações, e uma linha na seção de diagnóstico explicando como ligar um operador (`UPDATE users SET is_platform_admin = true WHERE email = '...'`).

Em `docs/superpowers/specs/2026-08-13-conexao-assistida-design.md` §11: marcar a pendência do namespace de templates como resolvida, apontando para o spec `2026-08-17-templates-por-dono-design.md`.

- [ ] **Step 4: Rodar tudo**

Run: `cd services/api-gateway && npx jest && npx tsc --noEmit`
Expected: tudo passando.

- [ ] **Step 5: Commit**

```bash
git add services/api-gateway/src/channels/assisted/ docs/
git commit -m "feat(conexao-assistida): cliente recem-conectado recebe os templates genericos"
```

---

## Ordem e dependências

```
T1 (migração + Prisma) → T5 (credenciais) → T6 (sync) → T7 (create) → T8 (leitura/envio) → T9 (fechamento)
T2 (nome na Meta) e T3 (PlataformaService) são independentes — entram logo após T1.
T4 (guard) depende só de T1; T7 usa o decorator dele.
```

## Depois do merge (controlador, não implementador)

- Aplicar `db/migrations/014_templates_por_dono.sql` em produção **antes** do deploy do código: o `schema.prisma` passa a declarar `meta_name` e `scope`, e o Prisma seleciona coluna a coluna, então código sem a migração quebra toda consulta a `templates`.
- Ligar os operadores: `UPDATE users SET is_platform_admin = true WHERE email IN (...)`.
- Rodar `templates.sync` uma vez pela organização assistida, para adotar `zaplane_teste_entrega` e `zaplane_conexao_confirmada` como genéricos.

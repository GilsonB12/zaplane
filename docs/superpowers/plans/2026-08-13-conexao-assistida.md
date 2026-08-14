# Conexão assistida — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para implementar tarefa a tarefa. Os passos usam checkbox (`- [ ]`).

**Goal:** O cliente conecta o próprio número informando apenas número, nome do negócio e o código do SMS — o número passa a viver na WABA da Zaplane, e ele nunca toca em nada da Meta.

**Spec:** `docs/superpowers/specs/2026-08-13-conexao-assistida-design.md` — fonte de requisitos; cada tarefa referencia as seções.

**Architecture:** O estado parcial vive numa tabela nova (`channel_connection_requests`); `whatsapp_channels` só ganha linha quando o número está verificado E registrado. Um wrapper fino isola as chamadas da Meta, um serviço orquestra a máquina de estados e as travas, e o wizard no front consome quatro endpoints.

**Tech Stack:** NestJS 10 + Prisma 5 · PostgreSQL 15 · React 18 + Vite + Tailwind · Jest (introduzido na T1).

## Global Constraints

- **Multi-tenancy:** `organizationId` sempre do JWT, nunca do body. SQL cru com `::uuid`.
- **Segredos nunca vazam:** token, PIN e `app_secret` não aparecem em resposta de API, log ou front. Token sempre por header `Authorization`, nunca em query string.
- **Migração aditiva:** novo arquivo `013_*.sql`; o SQL é a fonte de verdade; `npx prisma db pull` + `prisma generate` depois.
- **Nada hardcoded:** WABA, caps e cotas via `configuration.ts` + `.env.example` (CLAUDE.md §9).
- **Idioma:** strings de usuário, comentários e commits em português.
- **Erro da Meta nunca vai para o cliente** — só o texto do catálogo (spec §8).
- **Invariante:** linha em `whatsapp_channels` ⇒ número verificado, registrado e pronto para enviar.
- **Commits por tarefa**, sem co-author.

---

### Task 1: Base de testes + utilitários puros

Sem framework de teste no gateway hoje. Esta feature tem normalização de telefone, catálogo de erros e contadores — lógica que precisa de teste barato.

**Files:**
- Modify: `services/api-gateway/package.json` (devDeps + bloco `jest`)
- Create: `services/api-gateway/src/channels/assisted/telefone.ts`
- Create: `services/api-gateway/src/channels/assisted/telefone.spec.ts`
- Create: `services/api-gateway/src/channels/assisted/erros.ts`
- Create: `services/api-gateway/src/channels/assisted/erros.spec.ts`

**Interfaces:**
- Produces: `normalizarTelefoneBR(entrada: string): TelefoneBR` com `{ cc, nacional, semNono, e164, ultimos4 }`; `TelefoneInvalidoError`; `mensagemParaCliente(codigoMeta: number | null): string`; `ERROS_CONEXAO`.

- [ ] **Step 1: Instalar jest**

```bash
cd services/api-gateway
npm i -D jest@29 ts-jest@29 @types/jest@29
```

- [ ] **Step 2: Configurar jest no package.json**

Acrescentar ao `package.json` (fora de `scripts`):

```json
"jest": {
  "preset": "ts-jest",
  "testEnvironment": "node",
  "rootDir": "src",
  "testRegex": ".*\\.spec\\.ts$"
}
```

E em `scripts`, trocar `"test": "jest"` por `"test": "jest --passWithNoTests"`.

- [ ] **Step 3: Escrever o teste do telefone (vai falhar)**

`src/channels/assisted/telefone.spec.ts`:

```ts
import { normalizarTelefoneBR, TelefoneInvalidoError } from './telefone';

describe('normalizarTelefoneBR', () => {
  it('aceita celular de 9 dígitos com máscara', () => {
    const t = normalizarTelefoneBR('(85) 99999-9999');
    expect(t.cc).toBe('55');
    expect(t.nacional).toBe('85999999999');
    expect(t.semNono).toBe('8599999999');
    expect(t.e164).toBe('+5585999999999');
    expect(t.ultimos4).toBe('9999');
  });

  it('aceita número antigo de 8 dígitos e devolve as duas variantes', () => {
    // o chip de teste do projeto: a Meta guarda sem o nono dígito
    const t = normalizarTelefoneBR('85 9806-2656');
    expect(t.semNono).toBe('8598062656');
    expect(t.nacional).toBe('85998062656');
  });

  it('remove o 55 quando o usuário digita o país', () => {
    expect(normalizarTelefoneBR('+55 85 99999-9999').nacional).toBe('85999999999');
  });

  it('preserva o DDD 55 (Mato Grosso do Sul)', () => {
    expect(normalizarTelefoneBR('55 99999-9999').nacional).toBe('55999999999');
  });

  it('recusa número curto demais', () => {
    expect(() => normalizarTelefoneBR('85 9999')).toThrow(TelefoneInvalidoError);
  });
});
```

- [ ] **Step 4: Rodar e confirmar que falha**

Run: `npx jest src/channels/assisted/telefone.spec.ts`
Expected: FAIL — `Cannot find module './telefone'`

- [ ] **Step 5: Implementar telefone.ts**

```ts
/** Normalização de telefone brasileiro para o formato que a Meta espera.
 *
 *  A Meta recebe `cc` separado do resto. O formato do assinante é PONTO EM
 *  ABERTO (spec §4): o único número que testamos é antigo e ela o guarda sem o
 *  nono dígito. Por isso devolvemos as duas variantes — quem chama tenta a
 *  primeira e cai na segunda se a Meta recusar por parâmetro. */
export class TelefoneInvalidoError extends Error {
  constructor() {
    super('telefone_invalido');
  }
}

export type TelefoneBR = {
  cc: string;
  /** DDD + 9 dígitos, ex.: 85999999999 */
  nacional: string;
  /** DDD + 8 dígitos (sem o nono), ex.: 8599999999 */
  semNono: string;
  /** +5585999999999 */
  e164: string;
  /** para mascarar na UI */
  ultimos4: string;
};

export function normalizarTelefoneBR(entrada: string): TelefoneBR {
  const digitos = (entrada || '').replace(/\D/g, '');
  // só tira o 55 quando sobra número demais para ser DDD+assinante
  const sem55 = digitos.startsWith('55') && digitos.length > 11 ? digitos.slice(2) : digitos;
  if (sem55.length < 10 || sem55.length > 11) throw new TelefoneInvalidoError();

  const ddd = sem55.slice(0, 2);
  const assinante = sem55.slice(2);
  const comNono = assinante.length === 8 ? '9' + assinante : assinante;
  const semNono =
    assinante.length === 9 && assinante.startsWith('9') ? assinante.slice(1) : assinante;

  return {
    cc: '55',
    nacional: ddd + comNono,
    semNono: ddd + semNono,
    e164: '+55' + ddd + comNono,
    ultimos4: assinante.slice(-4),
  };
}

/** (85) 9••••-••99 — o que a UI mostra na tela do código. */
export function mascarar(ddd: string, ultimos4: string): string {
  return `(${ddd}) 9••••-••${ultimos4.slice(-2)}`;
}
```

- [ ] **Step 6: Rodar e confirmar que passa**

Run: `npx jest src/channels/assisted/telefone.spec.ts`
Expected: PASS (5 testes)

- [ ] **Step 7: Escrever o teste do catálogo de erros (vai falhar)**

`src/channels/assisted/erros.spec.ts`:

```ts
import { ERROS_CONEXAO, mensagemParaCliente } from './erros';

describe('catálogo de erros', () => {
  it('número em uso e número inválido são indistinguíveis', () => {
    // impede que a rota vire oráculo de enumeração (spec §8)
    expect(mensagemParaCliente(133005)).toBe(mensagemParaCliente(100));
  });

  it('nunca devolve o código numérico da Meta ao cliente', () => {
    for (const codigo of [131042, 133005, 100, 80007, 999999, null]) {
      expect(mensagemParaCliente(codigo)).not.toMatch(/\d{3,}/);
    }
  });

  it('limite de SMS tem mensagem própria', () => {
    expect(mensagemParaCliente(80007)).toBe(ERROS_CONEXAO.sms_limite);
  });
});
```

- [ ] **Step 8: Rodar e confirmar que falha**

Run: `npx jest src/channels/assisted/erros.spec.ts`
Expected: FAIL — módulo não existe

- [ ] **Step 9: Implementar erros.ts**

```ts
/** Catálogo de mensagens do fluxo de conexão assistida.
 *
 *  O erro cru da Meta NUNCA chega ao cliente: ele transformaria a rota num
 *  oráculo de enumeração — daria para descobrir quais números já são clientes.
 *  "Número em uso" e "número inválido" respondem a MESMA coisa, de propósito.
 *  O código real vai só para o log do servidor e para audit_logs (spec §8). */
export const ERROS_CONEXAO = {
  numero_indisponivel:
    'Não foi possível usar este número. Verifique se ele não tem WhatsApp ativo.',
  sms_limite: 'Aguarde alguns minutos para pedir um novo código.',
  capacidade: 'Estamos com a capacidade cheia. Nossa equipe entra em contato.',
  generico: 'Não foi possível concluir agora. Tente novamente em alguns minutos.',
} as const;

/** Limite de vazão / cota — vale a pena tentar de novo mais tarde. */
const LIMITE = new Set([4, 80007, 130429, 131048]);

/** Número indisponível: já em uso, inválido, ou com WhatsApp ativo. */
const INDISPONIVEL = new Set([100, 133005, 133006, 133008, 133009, 136024]);

export function mensagemParaCliente(codigoMeta: number | null | undefined): string {
  if (typeof codigoMeta !== 'number') return ERROS_CONEXAO.generico;
  if (LIMITE.has(codigoMeta)) return ERROS_CONEXAO.sms_limite;
  if (INDISPONIVEL.has(codigoMeta)) return ERROS_CONEXAO.numero_indisponivel;
  return ERROS_CONEXAO.generico;
}

export function codigoIncorreto(restantes: number): string {
  return `Código incorreto. ${restantes} tentativa(s) restante(s).`;
}
```

- [ ] **Step 10: Rodar a suíte inteira**

Run: `npx jest`
Expected: PASS — 8 testes

- [ ] **Step 11: Commit**

```bash
git add services/api-gateway/package.json services/api-gateway/package-lock.json services/api-gateway/src/channels/assisted/
git commit -m "test(gateway): jest + utilitarios puros da conexao assistida

Introduz jest no gateway, que nao tinha framework de teste. Comeca pelos
utilitarios do fluxo assistido: normalizacao de telefone brasileiro (com as
duas variantes de nono digito, porque o formato que a Meta aceita e ponto em
aberto) e o catalogo de erros, que garante que numero em uso e numero invalido
respondem identico para a rota nao virar oraculo de enumeracao."
```

---

### Task 2: Migração 013 + Prisma + configuração

**Files:**
- Create: `db/migrations/013_conexao_assistida.sql`
- Modify: `services/api-gateway/prisma/schema.prisma`
- Modify: `services/api-gateway/src/config/configuration.ts`
- Modify: `services/api-gateway/.env.example`

**Interfaces:**
- Produces: model Prisma `ChannelConnectionRequest`; `config.assisted.{wabaId, phoneCap, orgMaxChannels, orgDailyQuota}`.

- [ ] **Step 1: Escrever a migração**

`db/migrations/013_conexao_assistida.sql`:

```sql
-- 013_conexao_assistida.sql
-- Conexão assistida: o número do cliente passa a viver na WABA da Zaplane.
--
-- O estado parcial vive AQUI, não em whatsapp_channels, porque o ClaimBatch do
-- dispatcher faz JOIN naquela tabela sem filtrar status — um canal meia-boca
-- lá seria armadilha na parte mais sensível do sistema. Invariante: linha em
-- whatsapp_channels ⇒ número verificado, registrado e pronto para enviar.

BEGIN;

CREATE TABLE IF NOT EXISTS channel_connection_requests (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    waba_id           TEXT NOT NULL,
    -- PII: número cifrado (AES-GCM) + HMAC para unicidade/cooldown sem expor
    phone_e164_enc    TEXT NOT NULL,
    phone_hash        TEXT NOT NULL,
    -- DDD e 4 últimos em claro: é o mínimo para a UI mascarar na retomada
    -- ((85) 9••••-••99) sem precisar decifrar o número
    phone_ddd         TEXT NOT NULL,
    phone_last4       TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    phone_number_id   TEXT,
    -- PIN de 2 etapas gerado pelo servidor; nunca exibido ao cliente
    register_pin_enc  TEXT,
    status            TEXT NOT NULL DEFAULT 'criando'
                      CHECK (status IN ('criando','aguardando_codigo','concluida','falhou','cancelada')),
    code_requests     INTEGER NOT NULL DEFAULT 0,
    code_attempts     INTEGER NOT NULL DEFAULT 0,
    last_code_sent_at TIMESTAMPTZ,
    error_code        TEXT,
    error_detail      TEXT,
    channel_id        UUID REFERENCES whatsapp_channels(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE channel_connection_requests IS
  'Conexão de número em andamento. O código de 6 dígitos NUNCA é gravado — só contadores e horários.';

-- no máximo uma solicitação viva por organização
CREATE UNIQUE INDEX IF NOT EXISTS idx_ccr_org_viva
    ON channel_connection_requests (organization_id)
    WHERE status IN ('criando','aguardando_codigo');

-- o mesmo número não pode estar em duas solicitações vivas, de nenhuma org
CREATE UNIQUE INDEX IF NOT EXISTS idx_ccr_phone_viva
    ON channel_connection_requests (phone_hash)
    WHERE status IN ('criando','aguardando_codigo');

-- cooldown de SMS é por número e cross-tenant
CREATE INDEX IF NOT EXISTS idx_ccr_phone_recente
    ON channel_connection_requests (phone_hash, last_code_sent_at);

-- connected_via ganha o valor novo. O CHECK veio da 003 com nome auto-gerado,
-- daí o IF EXISTS: o nome pode divergir entre ambientes.
ALTER TABLE whatsapp_channels
    DROP CONSTRAINT IF EXISTS whatsapp_channels_connected_via_check;
ALTER TABLE whatsapp_channels
    ADD CONSTRAINT whatsapp_channels_connected_via_check
    CHECK (connected_via IN ('manual','embedded_signup','bootstrap','assisted'));

-- a vaga do número na Meta não volta por API (DELETE /{pnid} não é suportado),
-- então a unicidade vale inclusive para canais desconectados
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_pnid_global
    ON whatsapp_channels (phone_number_id);

ALTER TABLE whatsapp_channels
    ADD COLUMN IF NOT EXISTS register_pin_enc TEXT;

COMMENT ON COLUMN whatsapp_channels.register_pin_enc IS
  'PIN de 2 etapas do registro na Meta, cifrado. Necessário para re-registrar ou desregistrar o número.';

COMMIT;
```

- [ ] **Step 2: Aplicar em produção e conferir**

```bash
node -e "
const {Client}=require('pg');const fs=require('fs');
(async()=>{const c=new Client({connectionString:process.env.PGCONN,ssl:false});await c.connect();
await c.query(fs.readFileSync('db/migrations/013_conexao_assistida.sql','utf8'));
const t=await c.query(\"SELECT count(*)::int n FROM information_schema.tables WHERE table_name='channel_connection_requests'\");
const v=await c.query(\"SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='whatsapp_channels_connected_via_check'\");
console.log('tabela criada:',t.rows[0].n===1,'| check:',v.rows[0].d);
await c.end();})();"
```

Expected: `tabela criada: true` e o CHECK contendo `'assisted'`.

⚠️ Se `idx_channels_pnid_global` falhar por duplicata, há `phone_number_id` repetido em `whatsapp_channels` — investigar antes de prosseguir, não remover o índice.

- [ ] **Step 3: Sincronizar o Prisma**

```bash
cd services/api-gateway && npx prisma db pull && npx prisma generate
```

Conferir que apareceu `model ChannelConnectionRequest` e o campo `registerPinEnc` em `WhatsappChannel`.

- [ ] **Step 4: Acrescentar a configuração**

Em `src/config/configuration.ts`, dentro do objeto retornado:

```ts
  assisted: {
    // WABA da Zaplane que recebe os números dos clientes
    wabaId: process.env.ZAPLANE_WABA_ID || '',
    // teto de números por WABA na Meta (2 sobe para 20 com empresa verificada)
    phoneCap: parseInt(process.env.ZAPLANE_WABA_PHONE_CAP || '20', 10),
    // canais ativos permitidos por organização
    orgMaxChannels: parseInt(process.env.ORG_MAX_CHANNELS || '1', 10),
    // Limite de mensagens é do PORTFÓLIO e compartilhado por todos os números
    // (Meta, desde 07/10/2025). Sem cota por org, um cliente consome o pote de
    // todos. Ver spec §2.
    orgDailyQuota: parseInt(process.env.ORG_DAILY_MESSAGE_QUOTA || '200', 10),
  },
```

- [ ] **Step 5: Documentar no .env.example**

```
# ---- Conexão assistida ----
# WABA da Zaplane que recebe os números dos clientes
ZAPLANE_WABA_ID=1972668750117567
# Teto de números por WABA na Meta
ZAPLANE_WABA_PHONE_CAP=20
# Canais ativos por organização
ORG_MAX_CHANNELS=1
# Destinatários únicos por organização em 24h. O limite da Meta é do PORTFÓLIO
# e compartilhado — sem esta cota um cliente consome a capacidade de todos.
ORG_DAILY_MESSAGE_QUOTA=200
```

- [ ] **Step 6: Documentar o token de fallback do dispatcher**

⚠️ **Sem este passo o canal assistido nasce quebrado.** O canal grava um
sentinela em `access_token_enc` para não replicar o token mestre em cada linha;
quem resolve o token de verdade é o `resolveToken` do dispatcher, pelo fallback
de ambiente. Verificado em 14/08/2026: **`WHATSAPP_ACCESS_TOKEN` não está
definida no serviço `zaplane-dispatcher` em produção.** Com ela vazia, o worker
faz `MarkFailed(..., "no_token", ...)` e **toda** mensagem do canal assistido
falha na hora — conecta com sucesso e não envia nada.

Acrescentar em `services/dispatcher/.env.example`:

```
# Token de System User da Zaplane. OBRIGATÓRIO no modelo de conexão assistida:
# os canais assistidos gravam um sentinela em access_token_enc (para não
# replicar o token mestre por tenant) e dependem deste fallback. Vazio =
# toda mensagem desses canais falha com "no_token".
WHATSAPP_ACCESS_TOKEN=
```

E registrar no relatório da tarefa que a variável **precisa ser definida no
Railway antes da T10** (o teste ponta a ponta falha sem ela).

- [ ] **Step 7: Verificar que compila**

Run: `cd services/api-gateway && npx tsc --noEmit -p tsconfig.json`
Expected: sem saída

- [ ] **Step 8: Commit**

```bash
git add db/migrations/013_conexao_assistida.sql services/api-gateway/prisma/schema.prisma services/api-gateway/src/config/configuration.ts services/api-gateway/.env.example services/dispatcher/.env.example
git commit -m "feat(db): tabela de solicitacoes de conexao assistida (013)

Estado parcial da conexao vive em channel_connection_requests, nao em
whatsapp_channels — o ClaimBatch do dispatcher faz JOIN naquela tabela sem
filtrar status, entao um canal meia-boca la seria armadilha na fila.

Recria o CHECK de connected_via (003) para aceitar 'assisted', e cria indice
unico global de phone_number_id incluindo canais desconectados: a vaga do
numero na Meta nao volta por API."
```

---

### Task 3: Wrapper das chamadas da Meta

Isola as cinco chamadas num arquivo só, testável com `fetch` mocado.

**Files:**
- Create: `services/api-gateway/src/channels/assisted/meta-numeros.client.ts`
- Create: `services/api-gateway/src/channels/assisted/meta-numeros.client.spec.ts`

**Interfaces:**
- Consumes: `TelefoneBR` (T1).
- Produces: classe `MetaNumerosClient` com `adicionarNumero`, `pedirCodigo`, `verificarCodigo`, `registrar`, `contarNumeros`, `inscreverWebhook`. Todos devolvem `{ ok: true, ... }` ou `{ ok: false, codigo: number|null, detalhe: string }`.

- [ ] **Step 1: Escrever o teste (vai falhar)**

`src/channels/assisted/meta-numeros.client.spec.ts`:

```ts
import { MetaNumerosClient } from './meta-numeros.client';

function mockFetch(respostas: Array<{ status: number; body: any }>) {
  const chamadas: Array<{ url: string; init: any }> = [];
  let i = 0;
  global.fetch = jest.fn(async (url: any, init: any) => {
    chamadas.push({ url: String(url), init });
    const r = respostas[Math.min(i++, respostas.length - 1)];
    return { status: r.status, ok: r.status < 400, json: async () => r.body } as any;
  }) as any;
  return chamadas;
}

const cli = () => new MetaNumerosClient('v21.0', 'TOKEN_SECRETO');

describe('MetaNumerosClient', () => {
  it('manda o token por header, nunca na URL', async () => {
    const chamadas = mockFetch([{ status: 200, body: { id: '123' } }]);
    await cli().adicionarNumero('WABA', { cc: '55', nacional: '85999999999', semNono: '8599999999', e164: '+5585999999999', ultimos4: '9999' }, 'Loja');
    expect(chamadas[0].url).not.toContain('TOKEN_SECRETO');
    expect(chamadas[0].init.headers.Authorization).toBe('Bearer TOKEN_SECRETO');
  });

  it('devolve o phone_number_id quando a Meta aceita', async () => {
    mockFetch([{ status: 200, body: { id: '1162435340296069' } }]);
    const r = await cli().adicionarNumero('WABA', { cc: '55', nacional: '85999999999', semNono: '8599999999', e164: '+5585999999999', ultimos4: '9999' }, 'Loja');
    expect(r).toEqual({ ok: true, phoneNumberId: '1162435340296069' });
  });

  it('tenta a variante sem o nono digito quando a primeira falha por parametro', async () => {
    // formato do assinante e ponto em aberto (spec §4)
    const chamadas = mockFetch([
      { status: 400, body: { error: { code: 100, message: 'Invalid parameter' } } },
      { status: 200, body: { id: '999' } },
    ]);
    const r = await cli().adicionarNumero('WABA', { cc: '55', nacional: '85999999999', semNono: '8599999999', e164: '+5585999999999', ultimos4: '9999' }, 'Loja');
    expect(r).toEqual({ ok: true, phoneNumberId: '999' });
    expect(chamadas[0].init.body).toContain('85999999999');
    expect(chamadas[1].init.body).toContain('8599999999');
  });

  it('expoe o codigo da Meta para o log, sem repassar texto', async () => {
    mockFetch([{ status: 400, body: { error: { code: 133005, message: 'x' } } }]);
    const r = await cli().verificarCodigo('PNID', '123456');
    expect(r).toEqual({ ok: false, codigo: 133005, detalhe: 'x' });
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest meta-numeros`
Expected: FAIL — módulo não existe

- [ ] **Step 3: Implementar o client**

```ts
import { Injectable } from '@nestjs/common';
import { TelefoneBR } from './telefone';

export type Falha = { ok: false; codigo: number | null; detalhe: string };
const falha = (b: any): Falha => ({
  ok: false,
  codigo: typeof b?.error?.code === 'number' ? b.error.code : null,
  detalhe: b?.error?.error_data?.details ?? b?.error?.message ?? 'erro desconhecido',
});

/** Chamadas da Meta para adicionar, verificar e registrar um número.
 *  Contrato verificado em produção — ver spec §4. O token vai SEMPRE por
 *  header: em query string ele vazaria para log de proxy e histórico. */
@Injectable()
export class MetaNumerosClient {
  constructor(private readonly versao: string, private readonly token: string) {}

  private async chamar(caminho: string, metodo: 'GET' | 'POST', corpo?: URLSearchParams) {
    const r = await fetch(`https://graph.facebook.com/${this.versao}/${caminho}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(corpo ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(corpo ? { body: corpo.toString() } : {}),
    });
    return { status: r.status, body: await r.json() };
  }

  /** Tenta o assinante com o nono dígito e cai na variante sem ele se a Meta
   *  recusar por parâmetro — o formato aceito é ponto em aberto (spec §4). */
  async adicionarNumero(
    wabaId: string,
    tel: TelefoneBR,
    nomeExibicao: string,
  ): Promise<{ ok: true; phoneNumberId: string } | Falha> {
    let ultima: Falha | null = null;
    for (const assinante of [tel.nacional, tel.semNono]) {
      const r = await this.chamar(
        `${wabaId}/phone_numbers`,
        'POST',
        new URLSearchParams({ cc: tel.cc, phone_number: assinante, verified_name: nomeExibicao }),
      );
      if (r.status < 400 && r.body?.id) return { ok: true, phoneNumberId: String(r.body.id) };
      ultima = falha(r.body);
      // só vale tentar a outra variante se o problema foi de parâmetro
      if (ultima.codigo !== 100) break;
      if (assinante === tel.semNono) break;
    }
    return ultima!;
  }

  async pedirCodigo(pnid: string, metodo: 'SMS' | 'VOICE'): Promise<{ ok: true } | Falha> {
    const r = await this.chamar(
      `${pnid}/request_code`,
      'POST',
      new URLSearchParams({ code_method: metodo, language: 'pt_BR' }),
    );
    return r.status < 400 ? { ok: true } : falha(r.body);
  }

  async verificarCodigo(pnid: string, codigo: string): Promise<{ ok: true } | Falha> {
    const r = await this.chamar(`${pnid}/verify_code`, 'POST', new URLSearchParams({ code: codigo }));
    return r.status < 400 ? { ok: true } : falha(r.body);
  }

  async registrar(pnid: string, pin: string): Promise<{ ok: true } | Falha> {
    const r = await this.chamar(
      `${pnid}/register`,
      'POST',
      new URLSearchParams({ messaging_product: 'whatsapp', pin }),
    );
    return r.status < 400 ? { ok: true } : falha(r.body);
  }

  async contarNumeros(wabaId: string): Promise<{ ok: true; total: number } | Falha> {
    const r = await this.chamar(`${wabaId}/phone_numbers?fields=id`, 'GET');
    if (r.status >= 400) return falha(r.body);
    return { ok: true, total: (r.body?.data ?? []).length };
  }

  /** Obrigatório por WABA: sem isso o número envia e NENHUM status volta. */
  async inscreverWebhook(wabaId: string): Promise<{ ok: true } | Falha> {
    const r = await this.chamar(`${wabaId}/subscribed_apps`, 'POST', new URLSearchParams());
    return r.status < 400 ? { ok: true } : falha(r.body);
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx jest meta-numeros`
Expected: PASS (4 testes)

- [ ] **Step 5: Commit**

```bash
git add services/api-gateway/src/channels/assisted/meta-numeros.client.ts services/api-gateway/src/channels/assisted/meta-numeros.client.spec.ts
git commit -m "feat(channels): wrapper das chamadas de numero da Meta

Isola adicionar/pedir codigo/verificar/registrar/contar/inscrever webhook num
arquivo testavel. Token sempre por header — em query string vazaria para log de
proxy. O adicionar tenta o assinante com o nono digito e cai na variante sem
ele quando a Meta recusa por parametro, porque o formato aceito e ponto em
aberto (spec 4)."
```

---

### Task 4: Serviço de conexão assistida

O coração: máquina de estados e travas.

**Files:**
- Create: `services/api-gateway/src/channels/assisted/assisted.service.ts`
- Create: `services/api-gateway/src/channels/assisted/assisted.service.spec.ts`

**Interfaces:**
- Consumes: `MetaNumerosClient` (T3); `normalizarTelefoneBR`, `mensagemParaCliente`, `codigoIncorreto` (T1); `encrypt`, `phoneHash` de `src/common/crypto.util`.
- Produces: `AssistedService` com `atual(orgId)`, `iniciar(orgId, userId, dto)`, `reenviar(orgId, id, metodo)`, `verificar(orgId, id, codigo)`, `cancelar(orgId, id)`.

- [ ] **Step 1: Escrever o teste das travas (vai falhar)**

`src/channels/assisted/assisted.service.spec.ts`:

```ts
import { BadRequestException, ConflictException } from '@nestjs/common';
import { AssistedService } from './assisted.service';

const CFG = { wabaId: 'WABA', phoneCap: 20, orgMaxChannels: 1, orgDailyQuota: 200 };
const ORG = '11111111-1111-1111-1111-111111111111';

function montar(over: any = {}) {
  const prisma = {
    whatsappChannel: { count: jest.fn().mockResolvedValue(0), findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    channelConnectionRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: 'REQ', ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 'REQ', ...data })),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    ...over.prisma,
  };
  const meta = {
    contarNumeros: jest.fn().mockResolvedValue({ ok: true, total: 3 }),
    adicionarNumero: jest.fn().mockResolvedValue({ ok: true, phoneNumberId: 'PNID' }),
    pedirCodigo: jest.fn().mockResolvedValue({ ok: true }),
    verificarCodigo: jest.fn().mockResolvedValue({ ok: true }),
    registrar: jest.fn().mockResolvedValue({ ok: true }),
    inscreverWebhook: jest.fn().mockResolvedValue({ ok: true }),
    ...over.meta,
  };
  const config = { get: (k: string) => (k === 'assisted' ? CFG : undefined) };
  return { svc: new AssistedService(prisma as any, config as any, meta as any), prisma, meta };
}

const DTO = { telefone: '(85) 99999-9999', nomeExibicao: 'Loja do Zé', aceitouPreRequisito: true };

describe('AssistedService.iniciar', () => {
  it('recusa sem o aceite do pré-requisito', async () => {
    const { svc } = montar();
    await expect(svc.iniciar(ORG, 'U', { ...DTO, aceitouPreRequisito: false }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('recusa quando a organização já tem canal ativo', async () => {
    const { svc } = montar({ prisma: { whatsappChannel: { count: jest.fn().mockResolvedValue(1), findFirst: jest.fn(), create: jest.fn() } } });
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toBeInstanceOf(ConflictException);
  });

  it('recusa quando a WABA está lotada — sem chamar a Meta para adicionar', async () => {
    const { svc, meta } = montar({ meta: { contarNumeros: jest.fn().mockResolvedValue({ ok: true, total: 20 }) } });
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toThrow(/capacidade/i);
    expect(meta.adicionarNumero).not.toHaveBeenCalled();
  });

  it('recusa número que já é de outra organização', async () => {
    const { svc, meta } = montar({ prisma: { whatsappChannel: { count: jest.fn().mockResolvedValue(0), findFirst: jest.fn().mockResolvedValue({ id: 'C', organizationId: 'OUTRA' }), create: jest.fn() } } });
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toThrow();
    expect(meta.adicionarNumero).not.toHaveBeenCalled();
  });

  it('grava a linha ANTES de chamar a Meta', async () => {
    const { svc, prisma, meta } = montar();
    await svc.iniciar(ORG, 'U', DTO);
    const ordemCreate = (prisma.channelConnectionRequest.create as jest.Mock).mock.invocationCallOrder[0];
    const ordemMeta = (meta.adicionarNumero as jest.Mock).mock.invocationCallOrder[0];
    expect(ordemCreate).toBeLessThan(ordemMeta);
  });

  it('nunca persiste o número em texto puro', async () => {
    const { svc, prisma } = montar();
    await svc.iniciar(ORG, 'U', DTO);
    const dados = (prisma.channelConnectionRequest.create as jest.Mock).mock.calls[0][0].data;
    expect(JSON.stringify(dados)).not.toContain('85999999999');
    expect(dados.phoneHash).toBeTruthy();
  });
});

describe('AssistedService.verificar', () => {
  const req = {
    id: 'REQ', organizationId: ORG, status: 'aguardando_codigo',
    phoneNumberId: 'PNID', codeAttempts: 0, registerPinEnc: null,
    phoneE164Enc: 'x', displayName: 'Loja', wabaId: 'WABA', phoneLast4: '9999',
  };

  it('nunca persiste o código de 6 dígitos', async () => {
    const { svc, prisma } = montar({
      prisma: { channelConnectionRequest: {
        findFirst: jest.fn().mockResolvedValue(req),
        create: jest.fn(), update: jest.fn(async ({ data }: any) => data),
      } },
    });
    await svc.verificar(ORG, 'REQ', '894701').catch(() => {});
    for (const c of (prisma.channelConnectionRequest.update as jest.Mock).mock.calls) {
      expect(JSON.stringify(c[0])).not.toContain('894701');
    }
  });

  it('queima a solicitação após 5 tentativas erradas', async () => {
    const { svc } = montar({
      prisma: { channelConnectionRequest: {
        findFirst: jest.fn().mockResolvedValue({ ...req, codeAttempts: 4 }),
        create: jest.fn(), update: jest.fn(async ({ data }: any) => data),
      } },
      meta: { verificarCodigo: jest.fn().mockResolvedValue({ ok: false, codigo: 136008, detalhe: 'x' }) },
    });
    await expect(svc.verificar(ORG, 'REQ', '000000')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest assisted.service`
Expected: FAIL — módulo não existe

- [ ] **Step 3: Implementar o serviço**

```ts
import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { encrypt, phoneHash } from '../../common/crypto.util';
import { MetaNumerosClient } from './meta-numeros.client';
import { normalizarTelefoneBR, mascarar, TelefoneInvalidoError } from './telefone';
import { ERROS_CONEXAO, codigoIncorreto, mensagemParaCliente } from './erros';

const VIVOS = ['criando', 'aguardando_codigo'];
const MAX_TENTATIVAS_CODIGO = 5;
const MAX_SMS_24H = 3;
const COOLDOWN_SMS_MS = 60_000;

@Injectable()
export class AssistedService {
  private readonly logger = new Logger('ConexaoAssistida');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly meta: MetaNumerosClient,
  ) {}

  private cfg() {
    return this.config.get<any>('assisted');
  }

  /** Solicitação em andamento — a tela abre direto no passo do código. */
  async atual(orgId: string) {
    const r = await this.prisma.channelConnectionRequest.findFirst({
      where: { organizationId: orgId, status: { in: VIVOS } },
      orderBy: { createdAt: 'desc' },
    });
    if (!r) return { solicitacao: null };
    return {
      solicitacao: {
        id: r.id,
        status: r.status,
        numeroMascarado: mascarar(r.phoneDdd, r.phoneLast4),
        nomeExibicao: r.displayName,
        tentativasRestantes: MAX_TENTATIVAS_CODIGO - r.codeAttempts,
        podeReenviarEm: this.segundosParaReenvio(r.lastCodeSentAt),
      },
    };
  }

  private segundosParaReenvio(ultimo: Date | null): number {
    if (!ultimo) return 0;
    const falta = COOLDOWN_SMS_MS - (Date.now() - ultimo.getTime());
    return falta > 0 ? Math.ceil(falta / 1000) : 0;
  }

  async iniciar(
    orgId: string,
    userId: string,
    dto: { telefone: string; nomeExibicao: string; aceitouPreRequisito: boolean },
  ) {
    if (!dto.aceitouPreRequisito) {
      throw new BadRequestException('É preciso confirmar o pré-requisito do número.');
    }
    const nome = (dto.nomeExibicao || '').trim();
    if (nome.length < 2 || nome.length > 60) {
      throw new BadRequestException('Informe o nome do negócio (2 a 60 caracteres).');
    }

    let tel;
    try {
      tel = normalizarTelefoneBR(dto.telefone);
    } catch (e) {
      if (e instanceof TelefoneInvalidoError) {
        throw new BadRequestException(ERROS_CONEXAO.numero_indisponivel);
      }
      throw e;
    }
    const hash = phoneHash(tel.e164);
    const cfg = this.cfg();

    // Travas ANTES de qualquer escrita na Meta — a vaga não volta por API.
    const jaTem = await this.prisma.whatsappChannel.count({
      where: { organizationId: orgId, status: 'active' },
    });
    if (jaTem >= cfg.orgMaxChannels) {
      throw new ConflictException('Sua conta já tem um número conectado.');
    }
    const emAndamento = await this.prisma.channelConnectionRequest.findFirst({
      where: { organizationId: orgId, status: { in: VIVOS } },
    });
    if (emAndamento) {
      throw new ConflictException('Já existe uma conexão em andamento.');
    }
    // Número de outra organização: falha fechado, com a mensagem genérica.
    // whatsapp_channels NÃO tem phone_hash — a checagem é contra as
    // solicitações concluídas, que é onde o hash vive.
    const deOutra = await this.prisma.channelConnectionRequest.findFirst({
      where: { phoneHash: hash, status: 'concluida' },
    });
    if (deOutra && deOutra.organizationId !== orgId) {
      this.logger.warn(`Tentativa de conectar número de outra organização (org ${orgId})`);
      throw new BadRequestException(ERROS_CONEXAO.numero_indisponivel);
    }
    const capacidade = await this.meta.contarNumeros(cfg.wabaId);
    if (capacidade.ok && capacidade.total >= cfg.phoneCap) {
      throw new ConflictException(ERROS_CONEXAO.capacidade);
    }

    // Linha ANTES da Meta: se a chamada aceitar e o nosso UPDATE falhar, a
    // reconciliação encontra o número; sem a linha ele seria invisível.
    const req = await this.prisma.channelConnectionRequest.create({
      data: {
        organizationId: orgId,
        createdBy: userId,
        wabaId: cfg.wabaId,
        phoneE164Enc: encrypt(tel.e164),
        phoneHash: hash,
        phoneDdd: tel.nacional.slice(0, 2),
        phoneLast4: tel.ultimos4,
        displayName: nome,
        status: 'criando',
      },
    });

    const add = await this.meta.adicionarNumero(cfg.wabaId, tel, nome);
    if (!add.ok) {
      await this.prisma.channelConnectionRequest.update({
        where: { id: req.id },
        data: { status: 'falhou', errorCode: String(add.codigo ?? ''), errorDetail: add.detalhe },
      });
      this.logger.warn(`adicionarNumero falhou (org ${orgId}): ${add.codigo} ${add.detalhe}`);
      throw new BadRequestException(mensagemParaCliente(add.codigo));
    }

    await this.meta.inscreverWebhook(cfg.wabaId); // idempotente; sem isso nenhum status volta
    const sms = await this.meta.pedirCodigo(add.phoneNumberId, 'SMS');
    if (!sms.ok) {
      await this.prisma.channelConnectionRequest.update({
        where: { id: req.id },
        data: { status: 'falhou', phoneNumberId: add.phoneNumberId, errorCode: String(sms.codigo ?? ''), errorDetail: sms.detalhe },
      });
      throw new BadRequestException(mensagemParaCliente(sms.codigo));
    }

    await this.prisma.channelConnectionRequest.update({
      where: { id: req.id },
      data: {
        phoneNumberId: add.phoneNumberId,
        status: 'aguardando_codigo',
        codeRequests: 1,
        lastCodeSentAt: new Date(),
      },
    });
    return { id: req.id, numeroMascarado: mascarar(tel.nacional.slice(0, 2), tel.ultimos4) };
  }

  async reenviar(orgId: string, id: string, metodo: 'SMS' | 'VOICE') {
    const req = await this.buscarViva(orgId, id);
    if (req.codeRequests >= MAX_SMS_24H) throw new BadRequestException(ERROS_CONEXAO.sms_limite);
    if (this.segundosParaReenvio(req.lastCodeSentAt) > 0) {
      throw new BadRequestException(ERROS_CONEXAO.sms_limite);
    }
    const r = await this.meta.pedirCodigo(req.phoneNumberId!, metodo);
    if (!r.ok) throw new BadRequestException(mensagemParaCliente(r.codigo));
    await this.prisma.channelConnectionRequest.update({
      where: { id: req.id },
      data: { codeRequests: { increment: 1 }, lastCodeSentAt: new Date() },
    });
    return { ok: true };
  }

  async verificar(orgId: string, id: string, codigo: string) {
    const req = await this.buscarViva(orgId, id);
    const v = await this.meta.verificarCodigo(req.phoneNumberId!, codigo);
    if (!v.ok) {
      const tentativas = req.codeAttempts + 1;
      const queimou = tentativas >= MAX_TENTATIVAS_CODIGO;
      await this.prisma.channelConnectionRequest.update({
        where: { id: req.id },
        data: {
          codeAttempts: tentativas,
          ...(queimou ? { status: 'falhou', errorCode: 'codigo_esgotado' } : {}),
        },
      });
      throw new BadRequestException(
        queimou ? 'Tentativas esgotadas. Recomece a conexão.' : codigoIncorreto(MAX_TENTATIVAS_CODIGO - tentativas),
      );
    }

    const pin = String(randomInt(100000, 999999));
    const reg = await this.meta.registrar(req.phoneNumberId!, pin);
    if (!reg.ok) {
      await this.prisma.channelConnectionRequest.update({
        where: { id: req.id },
        data: { errorCode: String(reg.codigo ?? ''), errorDetail: reg.detalhe },
      });
      throw new BadRequestException(mensagemParaCliente(reg.codigo));
    }

    // Só agora nasce o canal — invariante: linha aqui ⇒ pronto para enviar.
    const canal = await this.prisma.whatsappChannel.create({
      data: {
        organizationId: orgId,
        label: req.displayName,
        phoneNumberId: req.phoneNumberId!,
        wabaId: req.wabaId,
        // o token da Zaplane NUNCA é copiado para a linha do canal; o
        // dispatcher resolve pelo fallback do ambiente (worker.go resolveToken)
        accessTokenEnc: '',
        registerPinEnc: encrypt(pin),
        connectedVia: 'assisted',
        status: 'active',
      } as any,
    });
    await this.prisma.channelConnectionRequest.update({
      where: { id: req.id },
      data: { status: 'concluida', channelId: canal.id },
    });
    return { canalId: canal.id };
  }

  async cancelar(orgId: string, id: string) {
    const req = await this.buscarViva(orgId, id);
    await this.prisma.channelConnectionRequest.update({
      where: { id: req.id },
      data: { status: 'cancelada' },
    });
    // A vaga na Meta NÃO volta por API — fica para a baixa manual do operador.
    this.logger.warn(`Conexão cancelada; número ${req.phoneNumberId} segue ocupando vaga na WABA ${req.wabaId}`);
    return { ok: true };
  }

  private async buscarViva(orgId: string, id: string) {
    const req = await this.prisma.channelConnectionRequest.findFirst({
      where: { id, organizationId: orgId, status: { in: VIVOS } },
    });
    if (!req) throw new NotFoundException('Conexão não encontrada.');
    return req;
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx jest assisted.service`
Expected: PASS (8 testes)

- [ ] **Step 5: Commit**

```bash
git add services/api-gateway/src/channels/assisted/assisted.service.ts services/api-gateway/src/channels/assisted/assisted.service.spec.ts
git commit -m "feat(channels): servico da conexao assistida

Maquina de estados e travas. As travas rodam ANTES de qualquer escrita na Meta,
porque a vaga do numero nao volta por API. A linha e gravada antes da chamada,
para que um numero aceito pela Meta com UPDATE falho ainda seja encontravel
pela reconciliacao.

Numero e cifrado, o codigo de 6 digitos nunca e persistido, o PIN e gerado no
servidor e o token da Zaplane nunca e copiado para a linha do canal — o
dispatcher ja resolve pelo fallback do ambiente."
```

---

### Task 5: Controller, DTOs e wiring

**Files:**
- Create: `services/api-gateway/src/channels/assisted/dto/iniciar.dto.ts`
- Create: `services/api-gateway/src/channels/assisted/assisted.controller.ts`
- Modify: `services/api-gateway/src/channels/channels.module.ts`

**Interfaces:**
- Consumes: `AssistedService` (T4).
- Produces: rotas `GET /channels/assisted/current`, `POST /channels/assisted`, `POST /channels/assisted/:id/resend`, `POST /channels/assisted/:id/verify`, `DELETE /channels/assisted/:id`.

- [ ] **Step 1: DTO**

```ts
import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

export class IniciarConexaoDto {
  @IsString() @Length(10, 20)
  telefone!: string;

  @IsString() @Length(2, 60)
  nomeExibicao!: string;

  @IsBoolean()
  aceitouPreRequisito!: boolean;
}

export class VerificarCodigoDto {
  @IsString() @Matches(/^\d{6}$/, { message: 'O código tem 6 dígitos.' })
  codigo!: string;
}

export class ReenviarDto {
  @IsOptional() @IsIn(['SMS', 'VOICE'])
  metodo?: 'SMS' | 'VOICE';
}
```

- [ ] **Step 2: Controller**

```ts
import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SubscriptionGuard } from '../../common/guards/subscription.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequireActiveSubscription } from '../../common/decorators/subscription.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AssistedService } from './assisted.service';
import { IniciarConexaoDto, ReenviarDto, VerificarCodigoDto } from './dto/iniciar.dto';

/** Conexão assistida: o número do cliente entra na WABA da Zaplane.
 *  Cada chamada aqui consome recurso real — uma vaga na WABA ou um SMS de
 *  verdade — daí o throttle apertado e a exigência de assinatura ativa. */
@Controller('channels/assisted')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@Roles('owner', 'admin')
export class AssistedController {
  constructor(private readonly assisted: AssistedService) {}

  @Get('current')
  atual(@CurrentUser('organizationId') orgId: string) {
    return this.assisted.atual(orgId);
  }

  @Post()
  @RequireActiveSubscription()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  iniciar(
    @CurrentUser('organizationId') orgId: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: IniciarConexaoDto,
  ) {
    return this.assisted.iniciar(orgId, userId, dto);
  }

  @Post(':id/resend')
  @RequireActiveSubscription()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  reenviar(
    @CurrentUser('organizationId') orgId: string,
    @Param('id') id: string,
    @Body() dto: ReenviarDto,
  ) {
    return this.assisted.reenviar(orgId, id, dto.metodo ?? 'SMS');
  }

  @Post(':id/verify')
  @RequireActiveSubscription()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verificar(
    @CurrentUser('organizationId') orgId: string,
    @Param('id') id: string,
    @Body() dto: VerificarCodigoDto,
  ) {
    return this.assisted.verificar(orgId, id, dto.codigo);
  }

  @Delete(':id')
  cancelar(@CurrentUser('organizationId') orgId: string, @Param('id') id: string) {
    return this.assisted.cancelar(orgId, id);
  }
}
```

- [ ] **Step 3: Registrar no módulo**

Substituir `services/api-gateway/src/channels/channels.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TemplatesModule } from '../templates/templates.module';
import { ChannelsService } from './channels.service';
import { ChannelsController } from './channels.controller';
import { AssistedService } from './assisted/assisted.service';
import { AssistedController } from './assisted/assisted.controller';
import { MetaNumerosClient } from './assisted/meta-numeros.client';

@Module({
  imports: [TemplatesModule],
  controllers: [ChannelsController, AssistedController],
  providers: [
    ChannelsService,
    AssistedService,
    {
      provide: MetaNumerosClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new MetaNumerosClient(
          config.get<string>('whatsapp.graphVersion')!,
          process.env.WHATSAPP_ACCESS_TOKEN || '',
        ),
    },
  ],
})
export class ChannelsModule {}
```

- [ ] **Step 4: Verificar que compila e que a aplicação sobe**

```bash
cd services/api-gateway && npx tsc --noEmit -p tsconfig.json && npm run build
DATABASE_URL="$PGCONN" PORT=3999 node dist/main.js 2>&1 | grep -E "assisted|error" | head
```

Expected: as cinco rotas `/api/v1/channels/assisted*` mapeadas, sem erro de DI.

- [ ] **Step 5: Commit**

```bash
git add services/api-gateway/src/channels/
git commit -m "feat(channels): rotas da conexao assistida

Cinco rotas com JwtAuthGuard + RolesGuard(owner,admin) + SubscriptionGuard.
Throttle apertado em iniciar e reenviar: cada chamada consome uma vaga na WABA
ou dispara um SMS real para um numero de terceiro."
```

---

### Task 6: Wizard no front

**Files:**
- Create: `services/web/src/screens/conexao/ConectarNumeroWizard.jsx`
- Modify: `services/web/src/api/endpoints.js`

**Interfaces:**
- Consumes: rotas da T5.
- Produces: componente `<ConectarNumeroWizard onConectado={fn} />`.

- [ ] **Step 1: Endpoints no front**

Acrescentar em `services/web/src/api/endpoints.js`:

```js
// --- conexão assistida ---
export const conexaoAtual = () => api.get("/channels/assisted/current");
export const iniciarConexao = (dto) => api.post("/channels/assisted", dto);
export const reenviarCodigo = (id, metodo) => api.post(`/channels/assisted/${id}/resend`, { metodo });
export const verificarCodigo = (id, codigo) => api.post(`/channels/assisted/${id}/verify`, { codigo });
export const cancelarConexao = (id) => api.del(`/channels/assisted/${id}`);
```

- [ ] **Step 2: Escrever o wizard**

`services/web/src/screens/conexao/ConectarNumeroWizard.jsx` — quatro passos e retomada. Estados: `inicio` → `prerequisito` → `dados` → `codigo` → `pronto`.

```jsx
import React, { useEffect, useState } from "react";
import { AlertTriangle, Check, MessageCircle } from "lucide-react";
import {
  conexaoAtual, iniciarConexao, reenviarCodigo, verificarCodigo, cancelarConexao,
} from "../../api/endpoints.js";

const BRAND = "#0F8C5A";
const INPUT =
  "w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-base outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 sm:py-2 sm:text-sm";

export default function ConectarNumeroWizard({ nomeOrganizacao, onConectado }) {
  const [passo, setPasso] = useState("inicio");
  const [aceite, setAceite] = useState(false);
  const [telefone, setTelefone] = useState("");
  const [nome, setNome] = useState(nomeOrganizacao || "");
  const [codigo, setCodigo] = useState("");
  const [req, setReq] = useState(null);
  const [erro, setErro] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [espera, setEspera] = useState(0);

  // Retomada: se houver conexão em andamento, abre direto no passo do código.
  useEffect(() => {
    conexaoAtual()
      .then((r) => {
        if (r?.solicitacao) {
          setReq(r.solicitacao);
          setEspera(r.solicitacao.podeReenviarEm || 0);
          setPasso("codigo");
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (espera <= 0) return;
    const t = setTimeout(() => setEspera((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [espera]);

  async function executar(fn) {
    setErro(null);
    setOcupado(true);
    try {
      return await fn();
    } catch (e) {
      setErro(e.body?.message || e.message || "Não foi possível concluir.");
      return null;
    } finally {
      setOcupado(false);
    }
  }

  const enviar = () =>
    executar(async () => {
      const r = await iniciarConexao({
        telefone, nomeExibicao: nome, aceitouPreRequisito: aceite,
      });
      setReq({ ...r, tentativasRestantes: 5 });
      setEspera(60);
      setPasso("codigo");
    });

  const confirmar = () =>
    executar(async () => {
      await verificarCodigo(req.id, codigo);
      setPasso("pronto");
      onConectado?.();
    });

  const caixa = "rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900";

  if (passo === "inicio") {
    return (
      <div className={caixa}>
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">
          Conecte seu número do WhatsApp
        </h3>
        <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">
          Para disparar campanhas, conecte um número. Leva cerca de 3 minutos.
        </p>
        <button
          onClick={() => setPasso("prerequisito")}
          className="mt-4 inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-semibold text-white sm:py-2"
          style={{ backgroundColor: BRAND }}
        >
          <MessageCircle className="h-4 w-4" /> Conectar meu número
        </button>
      </div>
    );
  }

  if (passo === "prerequisito") {
    return (
      <div className={caixa}>
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">
              Antes de começar, confira duas coisas
            </h3>
            <ul className="mt-2 space-y-1.5 text-[13px] leading-snug text-zinc-600 dark:text-zinc-300">
              <li>
                • O número <strong>não pode ter WhatsApp ativo</strong> — nem o comum, nem o
                Business. Se tiver, é preciso apagar a conta antes, e o histórico de conversas
                se perde.
              </li>
              <li>• O número vai <strong>receber um SMS</strong> com um código. Tenha o aparelho em mãos.</li>
            </ul>
            <p className="mt-2 text-[12px] text-zinc-400">
              Dica: use um chip novo, dedicado ao disparo. Evita perder seu histórico.
            </p>
            <label className="mt-3 flex items-start gap-2 text-[13px] text-zinc-700 dark:text-zinc-200">
              <input type="checkbox" className="mt-0.5" checked={aceite}
                onChange={(e) => setAceite(e.target.checked)} />
              Confirmo que este número não tem WhatsApp ativo, ou que posso apagá-lo.
            </label>
            <button
              disabled={!aceite}
              onClick={() => setPasso("dados")}
              className="mt-4 rounded-xl px-3.5 py-2.5 text-sm font-semibold text-white disabled:opacity-40 sm:py-2"
              style={{ backgroundColor: BRAND }}
            >
              Continuar
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (passo === "dados") {
    return (
      <div className={caixa}>
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">Dados do número</h3>
        <div className="mt-3 space-y-3">
          <div className="flex items-center gap-2">
            <span className="rounded-xl border border-zinc-200 px-3 py-2.5 text-sm text-zinc-500 dark:border-zinc-800 sm:py-2">
              +55
            </span>
            <input className={INPUT} placeholder="(85) 99999-9999" value={telefone}
              onChange={(e) => setTelefone(e.target.value)} />
          </div>
          <div>
            <input className={INPUT} placeholder="Nome do negócio" value={nome}
              onChange={(e) => setNome(e.target.value)} />
            <p className="mt-1.5 text-[12px] leading-snug text-zinc-500 dark:text-zinc-400">
              É este nome que aparece para quem recebe. A Meta analisa em algumas horas —
              <strong> até lá, o destinatário vê o número</strong>.
            </p>
          </div>
          {erro && <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:bg-red-500/10 dark:text-red-300">{erro}</div>}
          <button disabled={ocupado || !telefone || nome.trim().length < 2} onClick={enviar}
            className="rounded-xl px-3.5 py-2.5 text-sm font-semibold text-white disabled:opacity-40 sm:py-2"
            style={{ backgroundColor: BRAND }}>
            {ocupado ? "Enviando…" : "Enviar código por SMS"}
          </button>
        </div>
      </div>
    );
  }

  if (passo === "codigo") {
    return (
      <div className={caixa}>
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">Digite o código</h3>
        <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">
          Enviamos um SMS para <strong>{req?.numeroMascarado}</strong>
        </p>
        <input className={`${INPUT} mt-3 tracking-[0.4em]`} inputMode="numeric" maxLength={6}
          placeholder="______" value={codigo}
          onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ""))} />
        {erro && <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:bg-red-500/10 dark:text-red-300">{erro}</div>}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button disabled={ocupado || codigo.length !== 6} onClick={confirmar}
            className="rounded-xl px-3.5 py-2.5 text-sm font-semibold text-white disabled:opacity-40 sm:py-2"
            style={{ backgroundColor: BRAND }}>
            {ocupado ? "Verificando…" : "Verificar e conectar"}
          </button>
          <button disabled={espera > 0 || ocupado}
            onClick={() => executar(async () => { await reenviarCodigo(req.id, "SMS"); setEspera(60); })}
            className="text-[13px] font-medium text-zinc-500 disabled:opacity-40 hover:underline dark:text-zinc-400">
            {espera > 0 ? `Reenviar em ${espera}s` : "Reenviar código"}
          </button>
          <button disabled={ocupado}
            onClick={() => executar(async () => { await reenviarCodigo(req.id, "VOICE"); setEspera(60); })}
            className="text-[13px] font-medium text-zinc-500 hover:underline dark:text-zinc-400">
            Receber por ligação
          </button>
          <button
            onClick={() => executar(async () => { await cancelarConexao(req.id); setPasso("inicio"); setReq(null); })}
            className="text-[13px] text-zinc-400 hover:underline">
            Cancelar e recomeçar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={caixa}>
      <div className="flex items-start gap-3">
        <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">Número conectado</h3>
          <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">
            Você já pode criar campanhas.
          </p>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verificar que compila**

Run: `cd services/web && npm run build`
Expected: build sem erro

- [ ] **Step 4: Commit**

```bash
git add services/web/src/screens/conexao/ services/web/src/api/endpoints.js
git commit -m "feat(web): wizard de conexao assistida

Quatro passos — pre-requisito com aceite obrigatorio, dados, codigo, pronto —
e retomada: havendo conexao em andamento, abre direto no passo do codigo.
O nome de exibicao vem pre-preenchido com o nome da organizacao, e a tela avisa
que ate a Meta analisar o destinatario ve o numero."
```

---

### Task 7: Trocar a tela antiga

**Files:**
- Modify: `services/web/src/screens/Configuracoes.jsx`
- Modify: `services/web/src/screens/Dashboard.jsx`

- [ ] **Step 1: Trocar os botões pelo wizard**

Em `Configuracoes.jsx`: importar `ConectarNumeroWizard`, remover a constante `botoesConectar` (e os usos), remover o import e o uso de `ConectarWhatsAppButton` e do modal manual. Onde hoje aparece `botoesConectar`, renderizar:

```jsx
<ConectarNumeroWizard
  nomeOrganizacao={user?.organizationName}
  onConectado={canaisRes.reload}
/>
```

- [ ] **Step 2: Gatear o banner de pagamento**

Trocar a linha do filtro:

```jsx
// canais assistidos vivem na WABA da Zaplane — quem paga a Meta é a Zaplane,
// então o aviso não se aplica. Os legados (manual/embedded_signup) continuam
// precisando dele, por isso o bloco NÃO é removido.
const semPagamento = canais.filter(
  (c) => c.status === "active" && !c.paymentAckAt && c.connectedVia !== "assisted",
);
```

- [ ] **Step 3: Rótulo do canal assistido**

Em `Configuracoes.jsx`, acrescentar ao mapa `VIA_META`:

```js
  assisted: { label: "Conectado pela Zaplane", cls: "text-emerald-700 ring-emerald-200 dark:text-emerald-300 dark:ring-emerald-500/30" },
```

Em `Dashboard.jsx:213`, trocar o ternário — hoje ele rotularia o canal assistido como "Manual":

```jsx
{canal.connectedVia === "assisted"
  ? "Conectado pela Zaplane"
  : canal.connectedVia === "embedded_signup"
  ? "WhatsApp"
  : "Manual"}
```

- [ ] **Step 4: Verificar**

Run: `cd services/web && npm run build`
Depois, no bundle: `grep -c "Conectar manualmente" dist/assets/*.js` → esperado `0`.

- [ ] **Step 5: Commit**

```bash
git add services/web/src/screens/Configuracoes.jsx services/web/src/screens/Dashboard.jsx
git commit -m "feat(web): conexao assistida substitui os dois caminhos antigos

Embedded Signup e 'conectar manualmente' saem da tela do cliente — pediam
phoneNumberId, wabaId, accessToken, appId e appSecret, que sao dados da
Zaplane. Os endpoints continuam no backend para casos especiais.

O aviso de forma de pagamento passa a ser gateado por connectedVia: no canal
assistido quem paga a Meta e a Zaplane, entao o aviso e falso — mas os canais
legados ainda precisam dele."
```

---

### Task 8: Alerta da Meta para de contaminar todos os clientes

**Files:**
- Modify: `services/api-gateway/src/webhooks/webhooks.service.ts` (`handleAccountAlert`)
- Create: `services/api-gateway/src/webhooks/account-alert.spec.ts`

- [ ] **Step 1: Escrever o teste (vai falhar)**

```ts
import { escolherCanaisDoAlerta } from './webhooks.service';

describe('escolherCanaisDoAlerta', () => {
  const canais = [
    { id: 'A', phoneNumberId: '111' },
    { id: 'B', phoneNumberId: '222' },
  ];

  it('afeta só o canal identificado no payload', () => {
    expect(escolherCanaisDoAlerta(canais, '222').map((c) => c.id)).toEqual(['B']);
  });

  it('NÃO afeta ninguém quando o payload não identifica o número', () => {
    // WABA compartilhada: espalhar marcaria CRITICAL no painel de todos os
    // clientes sobre um problema que nenhum deles pode resolver
    expect(escolherCanaisDoAlerta(canais, null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest account-alert`
Expected: FAIL — `escolherCanaisDoAlerta` não exportado

- [ ] **Step 3: Extrair e corrigir**

Em `webhooks.service.ts`, exportar a função pura e usá-la em `handleAccountAlert`:

```ts
/** Numa WABA compartilhada entre clientes, um alerta sem número identificado
 *  não pode ser espalhado: marcaria CRITICAL no painel de todos sobre algo que
 *  nenhum deles resolve. Sem identificação, o alerta é da PLATAFORMA. */
export function escolherCanaisDoAlerta<T extends { phoneNumberId: string }>(
  canais: T[],
  scopedPhoneNumberId: string | null,
): T[] {
  if (!scopedPhoneNumberId) return [];
  return canais.filter((c) => c.phoneNumberId === scopedPhoneNumberId);
}
```

Trocar, dentro de `handleAccountAlert`, o bloco que hoje faz
`const alvos = scopedPhoneNumberId ? canais.filter(...) : canais;` por:

```ts
    const alvos = escolherCanaisDoAlerta(canais, scopedPhoneNumberId);
    if (alvos.length === 0) {
      this.logger.error(
        `ALERTA DE PLATAFORMA na WABA ${wabaId}: ${value?.alert_severity} ${value?.alert_type} — ${value?.alert_description ?? ''}`,
      );
      return;
    }
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx jest account-alert`
Expected: PASS (2 testes)

- [ ] **Step 5: Commit**

```bash
git add services/api-gateway/src/webhooks/
git commit -m "fix(webhooks): alerta de conta para de contaminar todos os clientes

handleAccountAlert fazia updateMany por waba_id. Com a WABA compartilhada entre
clientes, um alerta da Meta marcaria CRITICAL no painel de todo mundo sobre um
problema que nenhum deles pode resolver — e o app da Zaplane autentica pelo
secret global, entao o escopo por numero volta nulo justamente no fluxo
assistido. Sem numero identificado, o alerta agora e de plataforma: vai para o
log da operacao, nao para o painel dos clientes."
```

---

### Task 9: Cota diária por organização

O limite da Meta é do portfólio e compartilhado (spec §2). Sem esta trava, um cliente consome a capacidade de todos.

**Files:**
- Create: `services/api-gateway/src/common/quota.service.ts`
- Create: `services/api-gateway/src/common/quota.service.spec.ts`
- Modify: `services/api-gateway/src/campaigns/campaigns.service.ts`
- Modify: `services/api-gateway/src/app.module.ts`

**Interfaces:**
- Produces: `QuotaService.destinatariosRestantes(orgId): Promise<number>` e `QuotaService.garantirCota(orgId, novos: number): Promise<void>`.

- [ ] **Step 1: Escrever o teste (vai falhar)**

```ts
import { ForbiddenException } from '@nestjs/common';
import { QuotaService } from './quota.service';

const cfg = { get: () => ({ orgDailyQuota: 200 }) } as any;
const prismaCom = (usados: number) =>
  ({ $queryRaw: jest.fn().mockResolvedValue([{ n: usados }]) } as any);

describe('QuotaService', () => {
  it('devolve o que resta do dia', async () => {
    const s = new QuotaService(prismaCom(150), cfg);
    expect(await s.destinatariosRestantes('ORG')).toBe(50);
  });

  it('deixa passar quando cabe', async () => {
    const s = new QuotaService(prismaCom(150), cfg);
    await expect(s.garantirCota('ORG', 50)).resolves.toBeUndefined();
  });

  it('bloqueia quando estoura', async () => {
    const s = new QuotaService(prismaCom(150), cfg);
    await expect(s.garantirCota('ORG', 51)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('nunca devolve negativo', async () => {
    const s = new QuotaService(prismaCom(500), cfg);
    expect(await s.destinatariosRestantes('ORG')).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest quota`
Expected: FAIL

- [ ] **Step 3: Implementar**

```ts
import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/** Cota diária de destinatários únicos por organização.
 *
 *  Existe porque o limite da Meta é do PORTFÓLIO e compartilhado por todos os
 *  números (desde 07/10/2025). Numa WABA com vários clientes, um deles pode
 *  consumir a capacidade de todos no mesmo dia — e os outros descobrem pelo
 *  suporte. Ver spec §2. */
@Injectable()
export class QuotaService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  private limite(): number {
    return this.config.get<any>('assisted')?.orgDailyQuota ?? 200;
  }

  async destinatariosRestantes(orgId: string): Promise<number> {
    const linhas = await this.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(DISTINCT to_phone_e164)::int AS n
        FROM outbound_messages
       WHERE organization_id = ${orgId}::uuid
         AND created_at >= now() - interval '24 hours'
         AND status <> 'failed'`;
    const usados = Number(linhas?.[0]?.n ?? 0);
    return Math.max(this.limite() - usados, 0);
  }

  async garantirCota(orgId: string, novos: number): Promise<void> {
    const restam = await this.destinatariosRestantes(orgId);
    if (novos > restam) {
      throw new ForbiddenException(
        `Sua cota de hoje permite mais ${restam} destinatário(s). A cota renova em 24 horas.`,
      );
    }
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx jest quota`
Expected: PASS (4 testes)

- [ ] **Step 5: Ligar no enfileiramento**

Em `app.module.ts`, acrescentar `QuotaService` aos `providers` e exportá-lo se necessário. Em `campaigns.service.ts`, logo antes do `INSERT` em `outbound_messages` (após a supressão por opt-out/consentimento, quando o público final já está resolvido):

```ts
    await this.quota.garantirCota(orgId, publico.length);
```

- [ ] **Step 6: Verificar**

Run: `cd services/api-gateway && npx tsc --noEmit -p tsconfig.json && npx jest`
Expected: sem erro de tipo; todos os testes passam.

- [ ] **Step 7: Commit**

```bash
git add services/api-gateway/src/common/quota.service.ts services/api-gateway/src/common/quota.service.spec.ts services/api-gateway/src/campaigns/campaigns.service.ts services/api-gateway/src/app.module.ts
git commit -m "feat(billing): cota diaria de destinatarios por organizacao

O limite de mensagens da Meta e do PORTFOLIO e compartilhado por todos os
numeros desde 07/10/2025 — numa WABA com varios clientes, um deles pode
consumir a capacidade de todos no mesmo dia. A cota por organizacao e a trava
que impede isso, checada antes de enfileirar."
```

---

### Task 10: Verificação ponta a ponta

**Files:**
- Create: `scripts/verifica-conexao-assistida.cjs`

- [ ] **Step 1: Escrever o roteiro de verificação**

`scripts/verifica-conexao-assistida.cjs` — verifica contra o banco real, em transação revertida, os invariantes que teste unitário não cobre:

```js
/* Verificação da conexão assistida contra o Postgres real.
 * Tudo dentro de uma transação que termina em ROLLBACK. */
const { Client } = require('pg');

let ok = 0, fail = 0;
const check = (nome, cond, detalhe = '') => {
  cond ? ok++ : fail++;
  console.log(`  ${cond ? 'PASS ' : 'FALHA'} | ${nome}${detalhe ? ' — ' + detalhe : ''}`);
};

(async () => {
  const c = new Client({ connectionString: process.env.PGCONN, ssl: false });
  await c.connect();
  await c.query('BEGIN');
  try {
    const org = (await c.query(
      `INSERT INTO organizations (name, slug) VALUES ('T','t-${Date.now()}') RETURNING id`)).rows[0].id;

    await c.query(`INSERT INTO channel_connection_requests
      (organization_id, waba_id, phone_e164_enc, phone_hash, phone_last4, display_name, status)
      VALUES ($1,'W','enc','HASH','9999','Loja','aguardando_codigo')`, [org]);

    let erro = null;
    try {
      await c.query(`INSERT INTO channel_connection_requests
        (organization_id, waba_id, phone_e164_enc, phone_hash, phone_last4, display_name, status)
        VALUES ($1,'W','enc','HASH2','8888','Loja 2','aguardando_codigo')`, [org]);
    } catch (e) { erro = e; }
    check('só uma solicitação viva por organização', !!erro);

    const org2 = (await c.query(
      `INSERT INTO organizations (name, slug) VALUES ('T2','t2-${Date.now()}') RETURNING id`)).rows[0].id;
    erro = null;
    try {
      await c.query(`INSERT INTO channel_connection_requests
        (organization_id, waba_id, phone_e164_enc, phone_hash, phone_last4, display_name, status)
        VALUES ($1,'W','enc','HASH','9999','Outra','aguardando_codigo')`, [org2]);
    } catch (e) { erro = e; }
    check('o mesmo número não vive em duas organizações', !!erro);

    await c.query(`INSERT INTO whatsapp_channels
      (organization_id,label,phone_number_id,waba_id,access_token_enc,connected_via)
      VALUES ($1,'A','PN1','W','','assisted')`, [org]);
    check('connected_via aceita assisted', true);

    erro = null;
    try {
      await c.query(`INSERT INTO whatsapp_channels
        (organization_id,label,phone_number_id,waba_id,access_token_enc,connected_via)
        VALUES ($1,'B','PN1','W','','assisted')`, [org2]);
    } catch (e) { erro = e; }
    check('phone_number_id é único globalmente', !!erro);
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

- [ ] **Step 2: Rodar**

Run: `PGCONN="$PGCONN" node scripts/verifica-conexao-assistida.cjs`
Expected: 4 PASS, 0 FALHA

- [ ] **Step 3: Teste manual, uma vez**

Com o chip de teste (+55 85 9806-2656, marcado na memória do projeto como descartável):
1. logar no painel, ir em Configurações → aba do WhatsApp
2. percorrer os quatro passos do wizard
3. conferir na Meta que o número ficou `CONNECTED`
4. disparar uma mensagem e conferir a entrega

**Anotar no spec §4 qual formato de número a Meta aceitou** — é o ponto em aberto.

- [ ] **Step 4: Commit**

```bash
git add scripts/verifica-conexao-assistida.cjs
git commit -m "test: verificacao da conexao assistida contra o banco real

Confere os invariantes que teste unitario nao alcanca: uma solicitacao viva por
organizacao, numero unico entre organizacoes, connected_via aceitando
'assisted' e phone_number_id unico globalmente — este ultimo importa porque a
vaga do numero na Meta nao volta por API."
```

---

### Task 11: Auditoria e reconciliação de órfãos

Dois requisitos do spec (§5 e §8) que nenhuma tarefa anterior cobre.

**Files:**
- Modify: `services/api-gateway/src/channels/assisted/assisted.service.ts`
- Create: `services/api-gateway/src/channels/assisted/reconciliacao.service.ts`
- Create: `services/api-gateway/src/channels/assisted/reconciliacao.service.spec.ts`

**Interfaces:**
- Consumes: `MetaNumerosClient` (T3), `AssistedService` (T4).
- Produces: `ReconciliacaoService.orfaos(): Promise<Array<{ phoneNumberId: string; motivo: string }>>`.

- [ ] **Step 1: Auditoria no serviço**

Em `assisted.service.ts`, acrescentar um helper privado e chamá-lo nos cinco pontos. `resource_id` é o **hash**, nunca o número (LGPD — mesmo padrão de `contacts`):

```ts
  private async auditar(
    orgId: string, userId: string | null, acao: string, hash: string, metadata: any = {},
  ) {
    await this.prisma.$executeRaw`
      INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id, metadata)
      VALUES (${orgId}::uuid, ${userId}::uuid, ${acao}, 'channel_connection', ${hash}, ${JSON.stringify(metadata)}::jsonb)`;
  }
```

Chamadas: `channel.connect.requested` (após criar a linha), `channel.connect.sms_sent`
(após `pedirCodigo` ok), `channel.connect.verify_failed` (código errado, com
`{ tentativas }`), `channel.connect.registered` (após criar o canal, com
`{ canalId }`), `channel.connect.cancelled`. Em `verify_failed` e nos erros da
Meta, gravar o **código numérico** em `metadata` — é o rastro que o catálogo de
erros esconde do cliente.

- [ ] **Step 2: Escrever o teste da reconciliação (vai falhar)**

```ts
import { ReconciliacaoService } from './reconciliacao.service';

describe('ReconciliacaoService.orfaos', () => {
  const meta = (ids: string[]) =>
    ({ listarNumeros: jest.fn().mockResolvedValue({ ok: true, ids }) } as any);

  it('aponta número que está na Meta e não tem dono aqui', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ phone_number_id: 'PN1' }]),
    } as any;
    const s = new ReconciliacaoService(prisma, { get: () => ({ wabaId: 'W' }) } as any, meta(['PN1', 'PN2']));
    const r = await s.orfaos();
    expect(r.map((o) => o.phoneNumberId)).toEqual(['PN2']);
  });

  it('não aponta nada quando tudo tem dono', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ phone_number_id: 'PN1' }, { phone_number_id: 'PN2' }]),
    } as any;
    const s = new ReconciliacaoService(prisma, { get: () => ({ wabaId: 'W' }) } as any, meta(['PN1', 'PN2']));
    expect(await s.orfaos()).toEqual([]);
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `npx jest reconciliacao`
Expected: FAIL

- [ ] **Step 4: Acrescentar `listarNumeros` ao client (T3) e implementar o serviço**

Em `meta-numeros.client.ts`:

```ts
  async listarNumeros(wabaId: string): Promise<{ ok: true; ids: string[] } | Falha> {
    const r = await this.chamar(`${wabaId}/phone_numbers?fields=id`, 'GET');
    if (r.status >= 400) return falha(r.body);
    return { ok: true, ids: (r.body?.data ?? []).map((x: any) => String(x.id)) };
  }
```

`reconciliacao.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { MetaNumerosClient } from './meta-numeros.client';

/** Números que existem na WABA da Zaplane e não têm dono no banco.
 *
 *  Acontece quando a Meta aceita o número e o nosso UPDATE falha logo depois.
 *  Como `DELETE /{pnid}` não é suportado, a vaga não volta por API — este
 *  serviço só APONTA; a remoção é manual no WhatsApp Manager. Ver spec §4. */
@Injectable()
export class ReconciliacaoService {
  private readonly logger = new Logger('ReconciliacaoWABA');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly meta: MetaNumerosClient,
  ) {}

  async orfaos(): Promise<Array<{ phoneNumberId: string; motivo: string }>> {
    const wabaId = this.config.get<any>('assisted').wabaId;
    const naMeta = await this.meta.listarNumeros(wabaId);
    if (!naMeta.ok) {
      this.logger.warn(`não consegui listar os números da WABA: ${naMeta.detalhe}`);
      return [];
    }
    const conhecidos = await this.prisma.$queryRaw<Array<{ phone_number_id: string }>>`
      SELECT phone_number_id FROM whatsapp_channels WHERE phone_number_id IS NOT NULL
      UNION
      SELECT phone_number_id FROM channel_connection_requests WHERE phone_number_id IS NOT NULL`;
    const donos = new Set(conhecidos.map((r) => r.phone_number_id));
    const orfaos = naMeta.ids
      .filter((id) => !donos.has(id))
      .map((id) => ({ phoneNumberId: id, motivo: 'sem dono no banco' }));
    if (orfaos.length) {
      this.logger.warn(
        `${orfaos.length} número(s) órfão(s) ocupando vaga na WABA ${wabaId}: ${orfaos
          .map((o) => o.phoneNumberId)
          .join(', ')} — remover no WhatsApp Manager`,
      );
    }
    return orfaos;
  }
}
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx jest reconciliacao`
Expected: PASS (2 testes)

- [ ] **Step 6: Registrar no módulo e verificar**

Acrescentar `ReconciliacaoService` aos `providers` de `channels.module.ts`.

Run: `cd services/api-gateway && npx tsc --noEmit -p tsconfig.json && npx jest`
Expected: sem erro; todos os testes passam.

- [ ] **Step 7: Commit**

```bash
git add services/api-gateway/src/channels/assisted/
git commit -m "feat(channels): auditoria e reconciliacao de numeros orfaos

Cinco eventos em audit_logs com resource_id = hash do telefone, nunca o numero
em claro. O codigo de erro da Meta vai para metadata — e o rastro que o
catalogo esconde do cliente.

A reconciliacao aponta numeros que existem na WABA e nao tem dono no banco,
resultado de a Meta aceitar o numero e o UPDATE falhar depois. So aponta: como
DELETE /{pnid} nao e suportado, a vaga nao volta por API e a remocao e manual
no WhatsApp Manager."
```

---

## Ordem e dependências

```
T1 (testes + utils) → T2 (migração) → T3 (client Meta) → T4 (serviço) → T5 (rotas)
                                                                          ↓
                                          T6 (wizard) → T7 (troca a tela) → T11 (auditoria)
T8 (alerta) e T9 (cota) são independentes — podem entrar em paralelo após T2.
T10 fecha, depois de tudo.
```

**T11 depende de T4** (modifica o serviço) e de **T3** (acrescenta
`listarNumeros` ao client). Pode rodar em paralelo com T6/T7.

## Fora deste plano

Registrado no spec §11, repetido aqui para não se perder:

| Pendência | Gatilho |
|---|---|
| **Namespace de templates** — `templates.sync` importa os templates de toda a WABA para quem chamar, e como o envio usa o nome, um cliente conseguiria disparar o template de outro | **Antes de conectar o segundo cliente.** Até lá o fluxo assistido não chama `templates.sync` |
| Lista de tarefas do operador para remover número da Meta | Antes do primeiro cancelamento |
| `WHATSAPP_APP_SECRET` obrigatório em produção | Próximo deploy |

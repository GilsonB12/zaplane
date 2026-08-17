# Templates por dono — isolamento entre clientes e catálogo da plataforma

**Data:** 17/08/2026
**Contexto:** trava registrada como obrigatória no spec `2026-08-13-conexao-assistida-design.md` §11,
antes de conectar o segundo cliente.

## 1. O problema

`TemplatesService.sync()` varre `GET /{waba-id}/message_templates` e grava **tudo** que encontra na
organização que chamou. Como o envio identifica o template pelo **nome**, um cliente passa a ter
linha local apontando para o template de outro — e consegue disparar com ele.

Não é risco futuro. Verificado em produção em 17/08/2026:

- A WABA `1546948303766181` tem canais de **duas organizações diferentes**, ambos `connected_via = 'manual'`.
  Cada uma sincroniza com o próprio token contra a mesma WABA, então cada uma importa os templates da outra.
- A WABA da plataforma (`1972668750117567`) tem 2 templates sem dono no banco:
  `zaplane_teste_entrega` (APPROVED, MARKETING) e `zaplane_conexao_confirmada` (APPROVED, UTILITY).
- O banco tem 2 templates, ambos da org "Zaplane Demo (Meta Review)": `hello_world` (en_US) e
  `zaplane_call` (pt_BR). Os dois com `meta_template_id` preenchido.

## 2. O segundo problema, que o isolamento sozinho não resolve

O nome do template é único **na WABA**, não por organização. Hoje o banco tem
`UNIQUE (organization_id, name, language)`, então duas organizações podem ter `promocao` localmente —
mas na Meta a segunda submissão falha com nome duplicado.

Esse erro entrega que o template da outra existe. É o mesmo oráculo de enumeração que o catálogo
`erros.ts` fecha no fluxo de conexão, reaberto pelo lado dos templates.

## 3. O terceiro problema: cliente assistido não usa template nenhum

`sync()` e `submitToMeta()` leem o token da linha do canal (`accessTokenEnc`). No fluxo assistido essa
coluna nasce **vazia** de propósito — o token é da plataforma, não do cliente. Os dois métodos caem em
`looksConfigured() === false` e não fazem nada.

O cliente salva rascunho local, ele nunca chega na Meta, nunca é aprovado, e campanha só dispara com
`status = 'APPROVED'`. Ou seja: no estado atual, conectar um cliente assistido não basta para ele enviar.

## 4. Decisões

| Questão | Decisão | Por quê |
|---|---|---|
| Fronteira de visibilidade | **Organização**, não usuário | A atendente do petshop precisa disparar com o template que o dono criou. |
| Alcance | **Toda WABA compartilhada** | Uma regra só; fecha o vazamento atual do legado e o futuro do assistido. |
| Colisão de nomes | **Prefixo no nome da Meta** | Sem ele, dois clientes não podem ter "promoção", e o erro da Meta vira oráculo. |
| Origem do prefixo | **Id da organização**, não slug | Slug muda quando o cliente renomeia a empresa, e a Meta não aceita hífen em nome de template (`gilson-wimnt` seria inválido). |
| Quando prefixar | **Sempre**, sem classificar a WABA | Classificar WABA já falhou nesta base: no roteamento de alertas, a heurística "uma org só, logo dedicada" quebrava no lançamento. |
| Template criado direto na Meta | **Não é mais importado** | Confirmado com o usuário: só a operação da Zaplane faz isso; cliente não tem acesso ao WhatsApp Manager. |
| Templates genéricos | **Sim, escopo `platform`** | Aprovado uma vez, serve todos; cliente novo dispara no primeiro dia em vez de esperar 2 dias de análise. |
| Quem cria genérico | **Flag `is_platform_admin` no usuário** | O RBAC só tem papéis dentro da organização. Fecha também o residual da rota de órfãos. |

## 5. Restrição da Meta que molda o desenho

**Template pertence a uma WABA, e um número só dispara template da WABA dele.**

O genérico vive na WABA da Zaplane. Logo ele serve cliente assistido e **não** serve cliente legado com
WABA própria — se aparecesse na lista dele, o disparo falharia na Meta com "template não encontrado".

Regra: genérico só é visível para organização que envia pela WABA da plataforma.

Esse predicado já existe no código, em `QuotaService.sujeitaACota()` ("a organização tem canal na WABA da
plataforma, por `waba_id` ou por `connected_via = 'assisted'`"). Ele é extraído para um serviço próprio e
passa a ter um consumidor a mais. É a mesma pergunta de segurança em dois lugares: duas cópias divergem.

## 6. Modelo de dados

Migração `014`, aditiva.

```sql
ALTER TABLE templates ADD COLUMN meta_name TEXT;
UPDATE templates SET meta_name = name WHERE meta_name IS NULL;
ALTER TABLE templates ALTER COLUMN meta_name SET NOT NULL;

ALTER TABLE templates ADD COLUMN scope TEXT NOT NULL DEFAULT 'org'
  CHECK (scope IN ('org','platform'));

ALTER TABLE templates ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE templates ADD CONSTRAINT templates_escopo_dono_check CHECK (
  (scope = 'org'      AND organization_id IS NOT NULL) OR
  (scope = 'platform' AND organization_id IS NULL)
);

-- NULL é distinto de NULL no unique existente, então dois genéricos poderiam
-- ter o mesmo nome sem esta parcial
CREATE UNIQUE INDEX idx_templates_plataforma ON templates (name, language)
  WHERE scope = 'platform';

ALTER TABLE users ADD COLUMN is_platform_admin BOOLEAN NOT NULL DEFAULT false;
```

Os 2 templates existentes recebem `meta_name = name` (sem prefixo, de WABA dedicada) e `scope = 'org'`.
Nada quebra.

**Não** é criado unique global em `meta_name`: duas WABAs dedicadas podem legitimamente ter
`hello_world`. A unicidade dentro da WABA compartilhada é garantida por construção, pelo prefixo.

## 7. O nome na Meta

```
cliente digita:   Promoção de Banho
name:             Promoção de Banho             ← o que ele vê no painel
meta_name:        zcc96458b_promocao_de_banho   ← o que a Meta conhece e o que vai no envio
```

Prefixo de organização: `z` + 8 primeiros caracteres do UUID. O `z` inicial evita nome começando por
dígito e marca o template como gerado pela Zaplane.

Prefixo de plataforma: `zaplane_`. Os dois templates que já estão na WABA carregam esse prefixo, então
são adotados como genéricos no primeiro sync, sem migração especial.

Normalização do nome de exibição para o sufixo: minúsculas, acentos removidos, tudo fora de `[a-z0-9]`
vira `_`, repetições colapsadas, bordas aparadas. A Meta só aceita `[a-z0-9_]`.

## 8. Sincronização

Duas regras:

1. **Atualiza** qualquer template que já rastreamos por `meta_template_id`. É o que mantém o legado
   funcionando, inclusive o `hello_world` sem prefixo.
2. **Cria linha nova** só para template cujo nome na Meta comece com o prefixo desta organização —
   ou com `zaplane_`, que vira `scope = 'platform'`.

Template desconhecido e sem prefixo nunca vira linha de ninguém. É isso que fecha o vazamento nas duas
WABAs compartilhadas sem precisar saber que elas são compartilhadas.

Para canal assistido, `sync()` e `submitToMeta()` usam o **token da plataforma** e a **WABA da
plataforma**, em vez do token vazio da linha do canal.

## 9. Envio

Três pontos usam `template.name` e passam a usar `meta_name`:

- `campaigns.service.ts:243` (payload da campanha)
- `messages.service.ts:43` (envio avulso)
- `templates.service.ts:153` (submissão à Meta)

E a busca do template em campanha e envio avulso — hoje `findFirst({ id, organizationId: orgId })` —
passa a aceitar "template desta organização **ou** genérico visível para ela". Sem isso, genérico nunca
seria encontrado, porque genérico não tem dono.

## 10. Autorização

`is_platform_admin` em `users`, default `false`, ligado por SQL para a operação.

Um guard novo protege as rotas de plataforma:

- criação de template com `scope = 'platform'`
- `GET /channels/assisted/orphans`, hoje em `@Roles('owner')` — papel **dentro** da organização, então
  o dono de qualquer cliente alcança a rota

## 11. Testes

Cada um prova um jeito específico de errar:

- **O vazamento**: duas organizações sincronizando a mesma WABA, e a segunda não enxerga o template da
  primeira. É o teste que justifica o trabalho todo.
- **O genérico na WABA errada**: organização de WABA própria não vê template de plataforma — senão o
  disparo dela morreria na Meta com "template não encontrado".
- **O envio usa `meta_name`**: falha se alguém voltar a usar `name`.
- **O guard**: owner de cliente comum leva 403 ao criar genérico.
- **A geração do prefixo**: acento, espaço, maiúscula, nome longo, nome que vira vazio depois da
  normalização.
- **O CHECK do par escopo/dono**: contra o banco real, genérico com dono e template de org sem dono são
  ambos rejeitados.

## 12. Fora deste spec

| Pendência | Gatilho |
|---|---|
| Renomear os templates que já existem nas WABAs compartilhadas do legado, com janela de transição para não quebrar campanha em andamento | Quando as duas orgs da WABA `1546948303766181` precisarem de nomes iguais |
| Fila de revisão da Zaplane antes de submeter template de cliente à Meta | Se aparecer cliente submetendo conteúdo que arrisque a reputação da WABA compartilhada |
| Papel de admin de plataforma no RBAC, em vez de flag booleana | Quando houver mais de um nível de permissão de operação |

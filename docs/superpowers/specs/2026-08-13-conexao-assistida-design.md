# Conexão assistida — design

**Data:** 2026-08-13
**Estado:** aprovado, aguardando plano de implementação

## 1. O problema

Hoje o cliente conecta o número de duas formas, e as duas cobram dele um preço
que ele não consegue pagar:

- **Embedded Signup** — exige conta no Facebook, cartão cadastrado na Meta e
  verificação da empresa **dele**. Sem verificação, o portfólio dele nasce em
  250 conversas/dia.
- **Conectar manualmente** — pede `phoneNumberId`, `wabaId`, `accessToken`,
  `appId` e `appSecret`. São dados **da Zaplane**. Nenhum cliente leigo tem como
  preencher isso.

A plataforma existe justamente para poupar o cliente da burocracia da Meta, e as
duas telas fazem o oposto.

**Conexão assistida:** o número do cliente passa a viver na WABA da própria
Zaplane, que já é verificada. O cliente informa o número e lê um SMS. Todo o
resto — WABA, token, app, PIN — é da Zaplane e nunca aparece para ele.

## 2. A restrição que define tudo

> *"Messaging limits are calculated and set at the **business portfolio level**
> and are **shared by all business phone numbers** within a portfolio."*
> — [Meta, Messaging Limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits)

Desde 07/10/2025 o limite é do **portfólio**, não do número nem da WABA. A
hierarquia é:

```
Portfólio "Zaplane" (1538578761319193)   ← o limite mora aqui
├── WABA 946357611807755
├── WABA 1972668750117567   ← destino da conexão assistida
└── WABA 1585631720233640
     └── números
```

Consequências que o design precisa respeitar:

1. **Todos os clientes dividem um pote só.** Um cliente disparando forte
   consome a cota dos outros no mesmo dia. Por isso a **cota diária por
   organização é obrigatória**, não um refinamento.
2. **Criar uma WABA nova não aumenta a capacidade de envio.** Resolve só o teto
   de ~20 números por WABA. Mais capacidade vem de subir de tier
   (2.000 → 10.000 → 100.000 → ilimitado, automático com volume e qualidade) ou
   de um segundo portfólio.
3. **O texto do produto não pode prometer "1.000/dia por cliente".** O tier de
   1.000 nem existe mais; empresa verificada começa em 2.000, compartilhados.

## 3. Decisões tomadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Nível de controle | **Autosserviço com travas** | O operador não vira gargalo, mas o estrago possível é limitado por assinatura ativa e cota por organização. |
| Estado parcial | **Persistido, com retomada** | O número ocupa vaga na Meta assim que é adicionado — antes do SMS. Sem persistir, abandono vira número órfão invisível. |
| Pré-requisito | **Passo 0 com aceite obrigatório** | "Número não pode ter WhatsApp ativo" é o atrito nº 1 e não é detectável antes. Melhor o cliente saber antes de investir tempo. |
| Escopo da remoção | **Tirar da tela, manter no backend** | `/channels/manual` continua servindo casos especiais (cliente grande com WABA própria) sem custo de manutenção. |
| Nome de exibição | **Pré-preenchido, editável** | Reduz erro; o cliente revisa porque é o campo que a Meta analisa. |

## 4. Chamadas da Meta — verificadas em produção

Executadas com sucesso em 13/08/2026 contra a WABA real. Este é o contrato
exato; não re-derivar por leitura de documentação.

```
POST /{waba_id}/phone_numbers
     cc=55 & phone_number=8598062656 & verified_name=<nome>
     → 200 { "id": "<phone_number_id>" }
```

**Formato do número — ponto em aberto.** A chamada que funcionou usou `cc=55`
separado e `phone_number=8598062656`, ou seja **DDD + 8 dígitos**. Mas esse
número específico é antigo e a Meta o guarda sem o nono dígito
(`display_phone_number: "+55 85 9806-2656"`).

**Um caso não generaliza.** A maioria dos celulares brasileiros tem 9 dígitos
após o DDD, e não sabemos se a Meta aceita `85999999999` ou exige alguma
normalização. A implementação precisa:

1. testar com um número de 9 dígitos antes de fixar o formato;
2. até lá, tentar o número como o usuário digitou e, em caso de erro de
   parâmetro, tentar a variante sem o nono dígito — registrando no log qual
   funcionou;
3. anotar o resultado aqui quando houver certeza.

Não decidir isso por leitura de documentação: a doc é ambígua e já nos levou a
conclusão errada uma vez nesta feature.

```
POST /{pnid}/request_code   code_method=SMS & language=pt_BR   → 200 {"success":true}
POST /{pnid}/verify_code    code=<6 dígitos>                   → 200 {"success":true}
POST /{pnid}/register       messaging_product=whatsapp & pin=<6 dígitos>
POST /{waba_id}/subscribed_apps                                → 200 {"success":true}
```

Após `register`, o número passa de `PENDING` para:
`status=CONNECTED`, `quality_rating=GREEN`, `throughput.level=STANDARD`.

**`subscribed_apps` é obrigatório por WABA.** Sem ele o número envia
normalmente e **nenhum status volta** — entrega não registrada, cobrança não
lançada, opt-out perdido. Uma WABA nova não vem inscrita.

### Fato refutado

Uma pesquisa afirmou que `name_status: PENDING_REVIEW` bloqueia envio e
recebimento. **É falso.** Em 13/08/2026 o número `1187817141092237` estava em
`PENDING_REVIEW` e entregou mensagem normalmente. Não existe estado de espera
após o registro: **conectou, dispara.** O único efeito é cosmético — enquanto a
análise não sai, o destinatário vê o número em vez do nome.

### Sem volta por API

`DELETE /{pnid}` responde `Unsupported delete request`. A vaga do número na
WABA **não volta por API** — só por remoção manual no WhatsApp Manager. O
design precisa contabilizar a vaga como ocupada até a baixa manual.

## 5. Modelo de dados

**Invariante:** uma linha em `whatsapp_channels` significa **canal verificado,
registrado e pronto para enviar**. O estado parcial vive fora dela.

Isso importa porque o `ClaimBatch` do dispatcher faz `JOIN whatsapp_channels`
sem filtrar `status` — um canal meia-boca nessa tabela seria uma armadilha na
parte mais sensível do sistema.

### Tabela nova: `channel_connection_requests`

| Coluna | Tipo | Observação |
|---|---|---|
| `id` | UUID PK | |
| `organization_id` | UUID FK → organizations | `ON DELETE CASCADE` |
| `created_by` | UUID FK → users | auditoria |
| `waba_id` | TEXT | destino; vem de config, nunca hardcoded |
| `phone_e164_enc` | TEXT | **cifrado** (AES-GCM, `crypto.util.ts`) |
| `phone_hash` | TEXT | HMAC — unicidade e cooldown sem expor PII |
| `phone_last4` | TEXT | só para a UI mascarar (`(85) 9••••-••99`) |
| `display_name` | TEXT | nome enviado à Meta |
| `phone_number_id` | TEXT | devolvido pela Meta; gravado **antes** do passo seguinte |
| `register_pin_enc` | TEXT | PIN gerado no servidor, cifrado, nunca exibido |
| `status` | TEXT | `criando`, `aguardando_codigo`, `concluida`, `falhou`, `cancelada` |
| `code_requests` | INT | máx 3 em 24h |
| `code_attempts` | INT | máx 5 |
| `last_code_sent_at` | TIMESTAMPTZ | cooldown de 60s |
| `error_code` / `error_detail` | TEXT | diagnóstico interno |
| `channel_id` | UUID FK → whatsapp_channels | preenchido ao concluir |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

**O código de 6 dígitos nunca é persistido** — só contadores e horários.

### Estados

```
criando ──▶ aguardando_codigo ──▶ concluida
   │              │
   └──────────────┴──▶ falhou | cancelada
```

A linha é gravada em `criando` **antes** da primeira chamada à Meta. Se a
chamada falhar, vira `falhou`. Assim nunca existe número na WABA sem registro
correspondente.

Para o caso raro de a Meta aceitar e o nosso `UPDATE` falhar, a rotina de
reconciliação lista os números da WABA, cruza com as solicitações, e o que
estiver na Meta sem dono aqui entra na lista de remoção manual do operador.

### Migração `013_conexao_assistida.sql`

1. `CREATE TABLE IF NOT EXISTS channel_connection_requests` + índices
2. `DROP CONSTRAINT IF EXISTS whatsapp_channels_connected_via_check` e recriar
   com `'assisted'` incluído — o CHECK de `003` rejeita o valor novo, e o nome
   da constraint é auto-gerado, daí o `IF EXISTS`
3. `CREATE UNIQUE INDEX` em `whatsapp_channels(phone_number_id)` — **global,
   incluindo linhas `disabled`**, porque a vaga na Meta não volta
4. `ALTER TABLE whatsapp_channels ADD COLUMN register_pin_enc TEXT`
5. `COMMENT ON` explicando cada coluna nova

Depois: `npx prisma db pull` + `prisma generate`.

### Configuração

`ZAPLANE_WABA_ID`, `ZAPLANE_WABA_PHONE_CAP` (default 20), `ORG_MAX_CHANNELS`
(default 1) e `ORG_DAILY_MESSAGE_QUOTA` em `configuration.ts` e nos
`.env.example`. Nada hardcoded (CLAUDE.md §9).

O token de System User da Zaplane já existe no ambiente do gateway; o fluxo
assistido o usa a partir da configuração e **nunca** o grava em
`whatsapp_channels.access_token_enc` de um canal assistido — lá vai um
sentinela, e o dispatcher já resolve o token pelo fallback do ambiente
(`resolveToken` em `worker.go`).

## 6. Fluxo e endpoints

| Rota | Faz |
|---|---|
| `GET /channels/assisted/current` | solicitação em andamento (retomada) |
| `POST /channels/assisted` | cria a request → adiciona na WABA → pede SMS |
| `POST /channels/assisted/:id/resend` | reenvia (`SMS` ou `VOICE`) |
| `POST /channels/assisted/:id/verify` | verifica → registra → **cria o canal** |
| `DELETE /channels/assisted/:id` | cancela |

Todas: `JwtAuthGuard` + `RolesGuard` com `@Roles('owner','admin')` + assinatura
ativa. `POST /channels/assisted` e `/resend` levam `@Throttle` apertado — cada
chamada consome uma vaga da WABA ou dispara um SMS real.

Antes da primeira chamada à Meta, dentro da mesma transação:
1. assinatura ativa?
2. a organização já atingiu o limite de canais? (`ORG_MAX_CHANNELS`, default
   **1**) — e já existe solicitação em andamento? (sempre no máximo 1)
3. `phone_hash` já existe em outra organização, mesmo em canal `disabled`? →
   falha fechado
4. a WABA tem vaga? (contagem contra `ZAPLANE_WABA_PHONE_CAP`)

## 7. Telas

**Estado vazio** — um caminho só, sem escolha:
> **Conecte seu número do WhatsApp** · Leva cerca de 3 minutos. `[Conectar meu número]`

**Passo 0 — pré-requisito**
> - O número **não pode ter WhatsApp ativo**. Se tiver, é preciso apagar a conta antes — e o histórico se perde.
> - O número vai **receber um SMS**. Tenha o aparelho em mãos.
>
> ☐ *Confirmo que este número não tem WhatsApp ativo, ou que posso apagá-lo.*
>
> Dica discreta: *"use um chip novo, dedicado ao disparo."*

**Passo 1 — dados**
`+55` fixo · número · nome de exibição (pré-preenchido com o nome da
organização, editável), com o aviso de que **até a Meta analisar, o
destinatário vê o número**.

**Passo 2 — código**
Número mascarado, campo de 6 dígitos, `Reenviar em 0:47`, alternativa por
ligação.

**Passo 3 — pronto**
> ✅ Número conectado. Você já pode criar campanhas.

**Retomada:** havendo solicitação em `aguardando_codigo`, a tela abre direto no
passo 2, com `Cancelar e recomeçar`.

## 8. Erros

O erro cru da Meta **nunca** vai para o cliente — ele transformaria a rota num
oráculo de enumeração de números já cadastrados. Mesmo padrão do
`forgot-password`.

| Situação | Texto ao cliente |
|---|---|
| Número em uso (aqui ou em outra conta) | *"Não foi possível usar este número. Verifique se ele não tem WhatsApp ativo."* |
| Número inválido | **a mesma** mensagem, indistinguível de propósito |
| Limite de SMS | *"Aguarde alguns minutos para pedir um novo código."* |
| Código errado | *"Código incorreto. Restam N tentativas."* |
| WABA lotada | *"Estamos com a capacidade cheia. Nossa equipe entra em contato."* |

Código e `fbtrace_id` vão para o log do servidor e para `audit_logs`, com
`resource_id = phone_hash`.

Eventos de auditoria, na mesma transação dos contadores:
`channel.connect.requested`, `.sms_sent`, `.verify_failed`, `.registered`,
`.cancelled`.

## 9. Mudanças fora da tela

1. **`VIA_META`** ([Configuracoes.jsx:19](../../services/web/src/screens/Configuracoes.jsx)) ganha `assisted` → rótulo *"Conectado pela Zaplane"*; o ternário de
   [Dashboard.jsx:213](../../services/web/src/screens/Dashboard.jsx) passa a consultar o mesmo mapa (hoje rotularia o
   canal assistido como "Manual").
2. **Banner de forma de pagamento** — filtrado por `connectedVia !== 'assisted'`.
   Não deletar: canais legados ainda precisam dele, e gravar `payment_ack_at`
   num canal assistido seria mentira no banco.
3. **`handleAccountAlert`** — hoje faz `updateMany` por `waba_id`, o que
   marcaria **CRITICAL no painel de todos os clientes** sobre um problema que
   nenhum deles pode resolver. Passa a propagar só quando o payload identifica o
   número; senão vira alerta de plataforma, visível só para a operação.
4. **Cota diária por organização** — contador de destinatários únicos em 24h,
   checado antes de enfileirar. É a trava que impede um cliente de consumir o
   pote do portfólio inteiro.

## 10. Testes

- **Unidade:** máquina de estados; cooldown de SMS; contador de tentativas;
  catálogo de erros (nenhuma mensagem vaza código da Meta).
- **Integração (banco real, transação revertida):** unicidade cross-org de
  `phone_hash` e `phone_number_id`; limite de canais por organização; retomada
  de solicitação; reconciliação de órfãos.
- **Contrato com a Meta:** mocar as chamadas da seção 4 e verificar que o token
  segue por header `Authorization`, nunca em query string, e que nenhuma
  resposta de API expõe token, PIN ou `app_secret`.
- **Formato do número:** teste real com um celular de 9 dígitos, para fechar o
  ponto em aberto da seção 4.
- **Manual, uma vez:** conectar de ponta a ponta com o chip de teste
  (+55 85 9806-2656) e disparar.

## 11. Fora de escopo, com gatilho

Registrado explicitamente para não virar dívida esquecida:

| Pendência | Por que fica fora | Gatilho |
|---|---|---|
| **Namespace de templates** — `templates.sync` importa *todos* os templates da WABA para a org que chamar, e como o envio usa o **nome**, o cliente B consegue disparar o template do cliente A | Trabalho próprio (prefixo por org, coluna `meta_name`, filtro no sync, migração) e só se manifesta com dois clientes na mesma WABA | **Obrigatório antes de conectar o segundo cliente.** Até lá o fluxo assistido **não chama `templates.sync`** |
| **Lista de tarefas do operador** para remover número da Meta | `DELETE /{pnid}` não funciona; exige interface | Antes do primeiro cancelamento de cliente |
| **`WHATSAPP_APP_SECRET` obrigatório em produção** — hoje o default é `''`, e vazio faz **toda** validação de webhook falhar em silêncio | One-liner, não pertence a este fluxo | Próximo deploy |

## 12. Riscos conhecidos

- **Concentração:** todos os clientes na mesma WABA e no mesmo portfólio. Um
  cliente com qualidade ruim afeta a reputação compartilhada. Mitigação: opt-out
  já é obrigatório, e a cota por organização limita o dano.
- **Teto de clientes:** ~20 números por WABA e capacidade de envio do portfólio
  inteiro. Precisa de alarme em 70% da ocupação.
- **Custo:** a fatura da Meta passa a ser da Zaplane. A cota grátis de 200
  marketing na assinatura vira caixa real saindo — precisa de teto por
  organização, não só contabilidade.

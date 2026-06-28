# Banco de dados na AWS — recomendação (Zaplane)

> Resposta curta: **continue no PostgreSQL** e use **serviço gerenciado** (RDS → Aurora).
> Comece com **RDS for PostgreSQL**, migre para **Aurora PostgreSQL (I/O-Optimized)**
> quando precisar de réplicas de leitura/HA. **Não use Aurora DSQL** com este schema.

---

## 1. Qual banco? (e por que NÃO trocar)

Todo o sistema já é construído sobre PostgreSQL e usa recursos que são justamente o que
dá performance e simplicidade: `JSONB` (payload da mensagem), **foreign keys**, **triggers**
(`updated_at`), **extensão** `pgcrypto`, índices parciais e — crucial — `SELECT ... FOR
UPDATE SKIP LOCKED` para a fila. Trocar de banco jogaria fora essa base. Então a pergunta
real não é "qual banco", e sim **"qual sabor de PostgreSQL gerenciado na AWS"**.

### Gerenciado sim — não rode você mesmo
Use serviço gerenciado (RDS ou Aurora). Você não quer cuidar de patch, backup, failover,
replicação e tuning de SO na mão. As duas opções relevantes:

| Opção | O que é | Quando usar |
|------|---------|-------------|
| **RDS for PostgreSQL** | Postgres "padrão" gerenciado (instância + Multi-AZ + réplicas) | Início/MVP, carga previsível, custo enxuto. ~10–20% mais barato que Aurora em cargas pequenas. |
| **Aurora PostgreSQL** | Engine compatível com Postgres, storage distribuído (até ~3x throughput), até 15 réplicas, failover rápido, storage cresce sozinho até 256 TiB | Quando precisar de leitura escalável, alta disponibilidade e throughput de escrita maior. |
| **Aurora Serverless** (ex-"Serverless v2", renomeado em abr/2026) | Aurora que autoescala a capacidade (ACUs), podendo reduzir a ~zero quando ocioso | Carga **espinhada** (ex.: disparos em horários de pico e silêncio fora deles). |

### ⚠️ NÃO use Aurora DSQL (nem Limitless, por ora)
O **Aurora DSQL** (GA em mai/2025) é um SQL distribuído lindo, mas **incompatível com este
projeto**: não tem **triggers**, **foreign keys**, **sequences**, **extensões**, **views**,
tem limite de 10.000 linhas por transação e exige `CREATE INDEX ASYNC`. Nossa fila depende
de `SKIP LOCKED` e o schema usa FKs/triggers/`pgcrypto`. Logo, DSQL está fora.
**Aurora Limitless** (sharding) também tem restrições de DDL e só faz sentido em escala
extrema — não é o caso agora.

---

## 2. Recomendação faseada (casado com o crescimento)

**Fase A — MVP / seus dois casos atuais (petshop + consórcio, até ~dezenas de milhares de
msgs/dia):**
- **RDS for PostgreSQL 16**, **Multi-AZ** (failover automático), instância Graviton
  (`db.m7g.large` ou `t4g` para começar).
- **RDS Proxy** na frente (pooling — ver §3).
- Mantém a **fila no Postgres** (`SKIP LOCKED`). Simples, barato, robusto.

**Fase B — crescimento (dashboards pesados, HA, mais throughput):**
- Migrar para **Aurora PostgreSQL**, modo **I/O-Optimized** (a fila é write/IO-intensiva;
  se o I/O passar de ~25% da fatura, o I/O-Optimized sai 30–40% mais barato e mais
  previsível).
- 1 **writer** + 1–2 **readers**; rotear leituras de painel/relatório para os readers.
- Opcional **Aurora Serverless** se a carga for muito espinhada.

**Fase C — escala (alto volume sustentado):**
- **Tirar a fila quente do banco** e usar **Amazon SQS** para o despacho (ver §4). O Postgres
  continua como verdade/estado; o SQS absorve o churn de enfileiramento.
- **ElastiCache (Redis)** para cache de config quente (templates, canais, rate limits).
- Particionar tabelas históricas (ver §3). Só pensar em sharding/Limitless se um único
  writer saturar.

---

## 3. Como estruturar o banco para velocidade

O gargalo deste produto é a tabela **`outbound_messages`**: muito INSERT (enfileirar) e
muito UPDATE (transições de status). Isso gera *bloat* e pressão de autovacuum. As medidas
abaixo atacam exatamente isso.

1. **`fillfactor` na tabela da fila (ganho grande e barato).**
   Deixe espaço na página para *HOT updates* (atualização de status sem reescrever índices):
   ```sql
   ALTER TABLE outbound_messages SET (fillfactor = 80);
   ```
   Como atualizamos `status` na mesma linha o tempo todo, isso reduz muito o I/O de escrita.

2. **Autovacuum agressivo na fila** (ela muda muito):
   ```sql
   ALTER TABLE outbound_messages SET (
     autovacuum_vacuum_scale_factor = 0.02,
     autovacuum_vacuum_cost_delay   = 2
   );
   ```

3. **Particionamento por tempo** nas tabelas que só crescem
   (`outbound_messages`, `inbound_messages`, `audit_logs`): partição por `created_at`
   (mensal/semanal). Mantém a partição "quente" pequena (índices e vacuum rápidos) e o
   **expurgo vira `DROP PARTITION`** — instantâneo e ótimo para retenção/LGPD.

4. **Índices alinhados ao acesso (e não mais que isso).**
   - Fila: manter o índice **parcial** `WHERE status='queued'` (já existe). Não criar
     índices extras na fila — cada índice penaliza INSERT/UPDATE.
   - Painel: `(organization_id, created_at DESC)`, `(campaign_id, status)`.
   - Tabelas append-only enormes (logs/inbound): considerar **BRIN** em `created_at`
     (índice minúsculo, perfeito para dados ordenados no tempo).

5. **Chave primária com UUID v7 (time-ordered) nas tabelas de alto INSERT.**
   Hoje usamos `gen_random_uuid()` (v4, aleatório), que fragmenta o índice. **UUID v7** é
   ordenado no tempo → melhor localidade de B-tree e inserts mais rápidos. Gere no app
   (Node/Go) ou via extensão `pg_uuidv7`. Otimização opcional, vale a pena em escala.

6. **Separar leitura de escrita.** Escrita + fila no **writer**; listagens, métricas e
   relatórios nas **read replicas** (Aurora torna isso barato e com baixo lag).

7. **Multi-tenant fica em 1 banco.** `organization_id` + índices + **RLS** escala para
   milhares de tenants. Só sharding em escala extrema.

8. **Connection pooling é obrigatório.** Três serviços (NestJS/Prisma, Go/pgx, Python) ×
   várias instâncias = muitas conexões. Use **RDS Proxy** (gerenciado) ou PgBouncer em modo
   *transaction*. Sem isso, o Postgres esgota conexões sob autoscaling.

---

## 4. A decisão de arquitetura mais importante para velocidade: a fila

`SKIP LOCKED` no Postgres é excelente e **suficiente para a Fase A/B** (milhares–dezenas de
milhares/dia). Mas, conforme o volume sobe, a tabela de fila vira o ponto de maior churn.
Na AWS, o caminho idiomático em escala é:

- **Manter o Postgres** como registro durável (campanhas, contatos, status final).
- **Mover o despacho** para **Amazon SQS** (fila gerenciada, escala "infinita", *dead-letter
  queue* nativa, desacopla o worker do banco).

O scaffold já isola isso: o **worker Go acessa a fila por uma interface (`store`)**. Trocar
`SKIP LOCKED` por SQS é mudar essa camada, sem tocar no resto. Ou seja: comece simples com
Postgres e migre a fila para SQS só quando os números pedirem — sem reescrever o sistema.

---

## 5. Resumo executivo

- **Banco:** PostgreSQL gerenciado. **RDS for PostgreSQL** agora; **Aurora PostgreSQL
  I/O-Optimized** quando precisar de réplicas/HA/throughput.
- **RDS vs Aurora:** RDS é mais barato e simples no início; Aurora ganha em leitura
  escalável, failover e I/O previsível. Migração RDS→Aurora é suportada (snapshot/replica).
- **Evitar:** Aurora DSQL e Limitless (incompatíveis/excessivos para este schema).
- **Velocidade:** `fillfactor`+autovacuum na fila, particionamento por tempo, índices certos
  (parcial/BRIN), UUID v7, read replicas, **RDS Proxy** e, em escala, **SQS** para o despacho.
- **Sempre gerenciado** (RDS/Aurora) — não auto-hospedar Postgres em EC2.

> Me diga o volume-alvo (msgs/dia e nº de tenants) e a prioridade (custo × performance ×
> simplicidade) que eu fecho o desenho exato: classe de instância, nº de réplicas, e se já
> vale começar com Aurora Serverless ou RDS provisionado.

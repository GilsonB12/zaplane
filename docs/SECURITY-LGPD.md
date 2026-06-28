# Segurança & LGPD — Zaplane

> Conformidade não é um módulo — é uma propriedade de todo o sistema. Este documento
> descreve o que **já está embutido no scaffold** e o que **precisa ser concluído** antes
> de produção.

## 1. Princípios LGPD aplicados

| Princípio (LGPD art. 6º)        | Como o sistema atende |
|---------------------------------|-----------------------|
| Finalidade / Adequação          | Cada contato carrega `consent_source` e `purpose`; campanhas verificam base legal. |
| Necessidade (minimização)       | Coletamos só telefone + nome + tags. Sem dados sensíveis. |
| Livre acesso / Consentimento    | `consent_at`, `consent_source`, histórico em `consent_events`. |
| Transparência                   | Endpoints de exportação (`/privacy/data-requests`). |
| Segurança / Prevenção           | Criptografia, RBAC, auditoria, rate limit (ver abaixo). |
| Não discriminação               | — |
| Responsabilização (accountability) | `audit_logs` imutável + `consent_events`. |

## 2. Base legal e consentimento

- Todo contato tem **status de consentimento**: `granted`, `pending`, `denied`,
  `opted_out`, `unknown`.
- O import exige que o cliente **declare a base legal** (`consent_source`: ex.
  `cadastro_loja`, `formulario_site`, `relacao_contratual`). Sem isso, o contato entra
  como `unknown` e é **suprimido em campanhas de marketing**.
- `consent_events` registra cada mudança (quem, quando, origem) — trilha de auditoria do
  consentimento.

### Opt-out obrigatório
- Webhook inbound detecta palavras-chave (`PARAR`, `SAIR`, `STOP`, `CANCELAR`,
  `DESCADASTRAR`, `UNSUBSCRIBE`) → marca `opted_out=true` e dispara `consent_events`.
- Opt-out manual via `POST /contacts/:id/opt-out`.
- Contatos `opted_out` **nunca** são incluídos em novas campanhas (filtro no nível da query
  de resolução de público + checagem final no Dispatcher).

> **Aviso de produto (importante):** disparo frio em massa para pessoas sem
> relacionamento/consentimento (ex.: 1.000+ desconhecidos/dia) **viola a política da Meta
> e a LGPD**, e tende a derrubar o número por baixa "quality rating". A plataforma deve
> orientar o cliente a usar listas com base legal e oferecer aquecimento gradual do número.

## 3. Direitos do titular (LGPD art. 18)

`POST /privacy/data-requests` cobre:
- **Confirmação/Acesso/Portabilidade** (`type=export`): retorna todo o dado do titular
  (contato, mensagens, consentimento) em JSON.
- **Eliminação** (`type=delete`): anonimização/remoção do titular e suas mensagens,
  preservando apenas o que a lei exige reter (logs de auditoria pseudonimizados).
- Toda solicitação vira um registro rastreável (`data_subject_requests`) com SLA.

## 4. Segurança técnica

### Autenticação & autorização
- **JWT** access (curto) + refresh (rotativo); senhas com **Argon2id**.
- **RBAC** por papel e **isolamento por tenant**: todo acesso a dados filtra por
  `organization_id` (guard + escopo no service). *Recomendado:* habilitar **RLS**
  (Row-Level Security) no Postgres como segunda barreira (ver `db/migrations`).
- Rate limiting por IP/usuário (`@nestjs/throttler`) e por organização.

### Proteção de dados (PII)
- **Em trânsito:** TLS em todas as bordas (terminação no reverse proxy em produção).
- **Em repouso:**
  - *Mínimo:* full-disk/TDE no Postgres gerenciado.
  - *Recomendado neste domínio:* **criptografia em nível de aplicação** do telefone
    (AES-256-GCM com chave em KMS/secret manager) + **coluna de hash** (`phone_hash`,
    HMAC-SHA256) para busca/dedup sem expor o número. O scaffold já reserva
    `phone_e164_enc` e `phone_hash` no schema — a cifragem é um TODO marcado no código.
- **Segredos** fora do código: `.env` local (gitignored) → secret manager em produção.

### Webhook seguro
- Verificação de **`X-Hub-Signature-256`** (HMAC do corpo cru com `APP_SECRET`) antes de
  processar qualquer payload da Meta. Corpo cru preservado por um middleware específico.
- Verificação do `hub.verify_token` no handshake (GET).

### Auditoria
- `audit_logs` append-only: ação, ator, recurso, `organization_id`, IP, timestamp.
  Eventos sensíveis: login, export/delete LGPD, criação de campanha, mudança de
  consentimento.

## 5. Checklist pré-produção (pendências marcadas como TODO no código)

- [ ] Implementar a cifragem real de `phone_e164_enc` (hoje stub) + rotação de chave.
- [ ] Habilitar RLS no Postgres e políticas por `organization_id`.
- [ ] DPA/contratos e registro de **operador vs. controlador** (o cliente é controlador;
      a plataforma é operadora — definir no contrato).
- [ ] Retenção e expurgo automático (TTL configurável por tenant).
- [ ] Pen-test e revisão de dependências (SCA) no CI.
- [ ] Política de privacidade + termos exibidos no cadastro.
- [ ] Aquecimento de número e monitor de *quality rating* da Meta.

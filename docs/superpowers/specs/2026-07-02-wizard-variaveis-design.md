# Spec — Variáveis no wizard de campanha (claras, reativas e funcionais)

> Data: 2026-07-02 · Status: aprovado · Origem: feedback de uso real ("não entendi como
> criar com variáveis e onde elas ficam no texto") + TODO da Fatia 1 (inputs decorativos).

## 1. Problema

No passo "Template" do wizard NovaCampanha:
- Os campos de variável são **fixos e falsos** ("{{1}} — Nome: Mariana", "{{2}} — Pedido:
  #48213") — não refletem o template escolhido.
- O que o usuário digita é **descartado**: a campanha sempre envia `templateParams: {}`.
- A prévia (WhatsAppBubble) mostra valores de demonstração hardcoded, não os digitados —
  impossível ver onde a variável cai no texto.
- O backend já resolve `{{name}}` → nome do contato no disparo
  (`campaigns.service.resolveVar`), mas a UI nunca expôs isso.

## 2. Decisões (aprovadas)

- **Escopo de personalização:** valor fixo por variável + botão "Nome do contato"
  (`{{name}}`, resolvido por destinatário no gateway). Sem outros atributos (YAGNI).
- **Zero mudança de backend.** Contrato existente: `templateParams: {"1": v1, "2": v2}`.

## 3. Design

### Passo 2 — Template
1. **Inputs gerados do template real**: escanear o corpo por `{{n}}` (regex, únicos,
   ordenados) e renderizar um campo por variável. Rótulo de cada campo inclui um
   **trecho do texto** onde a variável cai (`…Your order number is ___…`).
2. **Chip «Nome do contato»** ao lado de cada campo: seta o valor para `{{name}}`;
   o campo vira um token visual (com X para voltar a valor fixo).
3. **Prévia ao vivo**: o balão atualiza a cada tecla. Preenchida → valor digitado;
   `{{name}}` → token `«nome do contato»` (estilo esmeralda); vazia → `⟦variável N⟧`
   destacada em âmbar (pendência).
4. **Validação**: "Continuar" desabilitado até todas as variáveis terem valor; dica
   "Preencha as N variáveis do template" no card.
5. Trocar de template **limpa os valores** (evita parâmetro órfão).

### Passo 3 — Revisão
- Balão "Mensagem final" usa os valores preenchidos (mesma função de prévia).
- Resumo ganha uma linha por variável (`Variável {{1}} → Nome do contato`, …).
- `confirmar()` envia `templateParams` real construído de `valores`.

### Técnica
- `screens/Campanhas.jsx`: estado `valores` (`{1:"...", 2:"{{name}}"}`), helpers
  `extrairVariaveis(corpo)`, `contextoDaVariavel(corpo, n)`, `preencherCorpo(corpo,
  vars, valores)`.
- `components/ui.jsx` (`WhatsAppBubble`): além do negrito `*x*`, renderizar tokens
  `⟦x⟧` (âmbar/pendente) e `«x»` (esmeralda/dinâmico). Comportamento legado (substituir
  `{{1}}`/`{{2}}` por valores demo quando o corpo cru é passado) preservado — a galeria
  de Templates continua igual.
- Template sem variáveis: seção não aparece; validação passa direto.

## 4. Verificação
Sem framework de teste (padrão do projeto): `npm run build` verde + teste real pela UI
(criar campanha com `jaspers_market_order_confirmation_v1` preenchendo variáveis e
disparar para o WhatsApp do usuário).

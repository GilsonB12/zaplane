# Prompt para o Claude gerar o design do painel (Zaplane)

Cole o bloco abaixo em uma conversa nova com o Claude (modo artifacts) para gerar a UI.
Depois de gerada, eu conecto os componentes aos endpoints do API Gateway
(`docs/ARCHITECTURE.md` §4). Peça o resultado como **um único arquivo `.jsx` (React +
Tailwind)**.

---

## ⤵️ PROMPT (copie a partir daqui)

Você é um designer de produto sênior. Crie a interface de um **SaaS de envio de mensagens
em massa via WhatsApp** chamado **Zaplane**, voltado ao mercado brasileiro. Entregue como
**um único artifact React (.jsx) com Tailwind**, sem dependências externas além de
`lucide-react` e `recharts`. Use dados mockados (sem chamadas de rede). Componha como um
app de painel com navegação lateral; foque em clareza, confiança e conformidade.

**Identidade visual**
- Tom: profissional, confiável, "fintech-clean". Nada de cara de ferramenta de spam.
- Cor primária: verde WhatsApp sóbrio (#0F8C5A / #128C7E) como destaque, base neutra
  (zinc/slate), bom contraste, cantos arredondados 2xl, sombras suaves.
- Modo claro como padrão, com suporte visual a modo escuro.
- Tipografia limpa (sans). Densidade de informação média, respirável.

**Telas / componentes (todos no mesmo artifact, navegáveis por uma sidebar):**
1. **Dashboard**: cartões de métricas (contatos ativos, enviadas hoje, taxa de entrega,
   opt-outs), um gráfico de envios nos últimos 14 dias (recharts), lista das últimas
   campanhas com status (rascunho/enviando/concluída/falha) e barra de progresso.
2. **Contatos**: tabela com busca, filtros (DDD/região, tag, status de consentimento),
   chips de consentimento (Consentido / Pendente / Opt-out), ações por linha
   (editar, remover, enviar mensagem), e botão **"Importar contatos"** que abre um modal
   de upload (arraste CSV/JSON/XLSX) com pré-visualização de validação:
   "X válidos, Y duplicados, Z inválidos" e seleção da **base legal/consentimento**.
3. **Nova campanha** (wizard de 3 passos): (1) escolher público — lista ou segmento
   dinâmico por DDD/região/tag, mostrando o total estimado e quantos serão **suprimidos**
   por opt-out/sem consentimento; (2) escolher **template aprovado** (com prévia do balão
   de mensagem do WhatsApp e variáveis preenchíveis); (3) revisão com **estimativa de
   custo** (por categoria/país) e botão de confirmar disparo.
4. **Campanhas**: lista + tela de detalhe com progresso em tempo real (enviadas, entregues,
   lidas, falhas) e timeline.
5. **Templates**: galeria dos templates com categoria (Marketing/Utility/Authentication) e
   status de aprovação da Meta (Aprovado/Em análise/Rejeitado).
6. **Configurações**: conexão com a Meta (Phone Number ID, WABA, status do número e
   "quality rating"), membros/equipe (RBAC: Owner/Admin/Operador/Leitor), e billing/plano.

**Conformidade visível (diferencial do produto):**
- Banner/aviso quando uma campanha incluir contatos sem base legal.
- Selo de "LGPD" e link de política em pontos-chave.
- Sempre mostrar opção de opt-out e contagem de suprimidos.

**Requisitos técnicos do artifact:**
- Um componente React default export, sem props obrigatórias, sem localStorage.
- Estado com `useState`; navegação entre telas por estado (não usar router).
- Somente classes utilitárias core do Tailwind. Ícones via `lucide-react`. Gráficos via
  `recharts`. Layout responsivo (desktop primeiro).

## ⤴️ FIM DO PROMPT

---

### Como eu conecto depois
1. Você gera o `.jsx` e me envia (ou cola aqui).
2. Eu extraio as telas em componentes, troco os mocks por chamadas ao API Gateway
   (`/api/v1/...`), adiciono o cliente HTTP com o token JWT e o upload real para
   `/contacts/import`.
3. Servimos o frontend como app estático (Vite/React) apontando para o gateway local.

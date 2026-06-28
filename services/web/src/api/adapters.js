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

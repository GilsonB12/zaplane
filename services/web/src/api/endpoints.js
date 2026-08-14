// Funções por endpoint, casadas com o contrato do gateway (docs/ARCHITECTURE.md §4).
import { api, setToken, setRefreshToken, getRefreshToken, clearSession } from "./client.js";

/* ---- Auth ---- */
// Guardamos o refreshToken junto do access: é ele que mantém a sessão viva
// além dos 15 minutos do access token (o client.js renova sozinho no 401).
export async function login(email, password) {
  const r = await api.post("/auth/login", { email, password });
  setToken(r.accessToken);
  setRefreshToken(r.refreshToken);
  return r;
}
export async function register(dto) {
  const r = await api.post("/auth/register", dto); // {organizationName,name,email,password}
  setToken(r.accessToken);
  setRefreshToken(r.refreshToken);
  return r;
}
// Perfil do usuário logado — usado para exibir quem está na sessão (e para
// reidratar a identidade após um F5, quando só o token sobrevive).
export const getMe = () => api.get("/auth/me");

// Recuperação de senha. O forgot responde igual exista o e-mail ou não —
// não expõe quem tem conta.
export const forgotPassword = (email) => api.post("/auth/forgot-password", { email });
export const resetPassword = (token, password) =>
  api.post("/auth/reset-password", { token, password });

/* ---- Equipe ---- */
export const listMembers = () => api.get("/members");

/* ---- Métricas ---- */
export const getDashboardMetrics = () => api.get("/metrics/dashboard");

/* ---- Contatos ---- */
export const listContacts = (query = {}) => {
  const qs = new URLSearchParams(query).toString();
  return api.get(`/contacts${qs ? `?${qs}` : ""}`);
};
export const createContact = (dto) => api.post("/contacts", dto);
export const updateContact = (id, dto) => api.patch(`/contacts/${id}`, dto);
export const removeContact = (id) => api.del(`/contacts/${id}`);
export const optOutContact = (id) => api.post(`/contacts/${id}/opt-out`);

// import multipart → POST /contacts/import (file + base legal)
export function importContacts(file, consentStatus, consentSource, defaultCountry = "BR") {
  const f = new FormData();
  f.append("file", file);
  f.append("consentStatus", consentStatus);
  f.append("consentSource", consentSource);
  f.append("defaultCountry", defaultCountry);
  return api.postForm("/contacts/import", f);
}

/* ---- Listas / Templates ---- */
export const listLists = () => api.get("/lists");
export const listTemplates = () => api.get("/templates");
export const createTemplate = (dto) => api.post("/templates", dto);
export const syncTemplates = () => api.post("/templates/sync"); // puxa status/categoria da Meta

/* ---- Campanhas ---- */
export const createCampaign = (dto) => api.post("/campaigns", dto);
export const getCampaign = (id) => api.get(`/campaigns/${id}`);
export const cancelCampaign = (id) => api.post(`/campaigns/${id}/cancel`);
export const listCampaigns = (query = {}) => {
  const qs = new URLSearchParams(query).toString();
  return api.get(`/campaigns${qs ? `?${qs}` : ""}`);
};

/* ---- Conversas (inbox 1:1) ---- */
export const listConversations = () => api.get("/conversations");
export const getConversation = (phone) =>
  api.get(`/conversations/${encodeURIComponent(String(phone).replace(/\D/g, ""))}/messages`);
export const getWindows = () => api.get("/conversations/windows");

/* ---- Envio avulso / Privacidade (LGPD) ---- */
export const sendSingle = (dto) => api.post("/messages/send", dto);   // template p/ 1 número
export const sendText = (dto) => api.post("/messages/text", dto);     // texto livre (janela 24h)
export const createDataRequest = (dto) => api.post("/privacy/data-requests", dto);

/* ---- Canais (Conexão Meta) ---- */
export const listChannels = () => api.get("/channels");
export const connectChannelManual = (dto) => api.post("/channels/manual", dto);
export const esExchange = (dto) => api.post("/channels/es/exchange", dto);
export const disconnectChannel = (id) => api.del(`/channels/${id}`);
// Cliente confirma que cadastrou a forma de pagamento na Meta. Não é
// verificação (a Meta não expõe isso a Tech Provider) — serve para o painel
// parar de lembrar do passo.
export const ackChannelPayment = (id, confirmado = true) =>
  api.post(`/channels/${id}/payment-ack`, { confirmado });

/* ---- Conexão assistida (número do próprio cliente) ---- */
export const conexaoAtual = () => api.get("/channels/assisted/current");
export const iniciarConexao = (dto) => api.post("/channels/assisted", dto);
export const reenviarCodigo = (id, metodo) => api.post(`/channels/assisted/${id}/resend`, { metodo });
export const verificarCodigo = (id, codigo) => api.post(`/channels/assisted/${id}/verify`, { codigo });
export const cancelarConexao = (id) => api.del(`/channels/assisted/${id}`);

/* ---- Billing ---- */
export const getBillingSummary = () => api.get("/billing/summary");
export const getWallet = () => api.get("/billing/wallet");
export const getSubscription = () => api.get("/billing/subscription");
// cpfCnpj: opcional. Enviado quando o responsável pela cobrança ainda não tem
// documento salvo (obrigatório em produção — o Asaas exige CPF/CNPJ válido).
export const buyCredits = (amountCents, cpfCnpj) =>
  api.post("/billing/credits", { amountCents, ...(cpfCnpj ? { cpfCnpj } : {}) });
export const activateSubscription = (cpfCnpj) =>
  api.post("/billing/subscription/activate", cpfCnpj ? { cpfCnpj } : {});

/* ---- Sessão ---- */
// Avisa o servidor para revogar o refresh token — sem isso, um token roubado
// continuaria válido por 30 dias mesmo depois de o usuário sair. A limpeza
// local acontece de qualquer jeito, mesmo se a chamada falhar.
export function logout() {
  const rt = getRefreshToken();
  if (rt) api.post("/auth/logout", { refreshToken: rt }).catch(() => {});
  clearSession();
}

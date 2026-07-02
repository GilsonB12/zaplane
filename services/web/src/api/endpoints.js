// Funções por endpoint, casadas com o contrato do gateway (docs/ARCHITECTURE.md §4).
import { api, setToken } from "./client.js";

/* ---- Auth ---- */
export async function login(email, password) {
  const r = await api.post("/auth/login", { email, password });
  setToken(r.accessToken);
  return r;
}
export async function register(dto) {
  const r = await api.post("/auth/register", dto); // {organizationName,name,email,password}
  setToken(r.accessToken);
  return r;
}

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

/* ---- Sessão ---- */
export function logout() { setToken(null); }

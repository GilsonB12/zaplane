// Cliente HTTP do painel Zaplane → API Gateway (NestJS).
// O token JWT é persistido em localStorage. Em dev, a base é /api/v1 (Vite faz proxy p/ :3000).

const BASE = import.meta.env.VITE_API_URL || "/api/v1";
const TOKEN_KEY = "zaplane_token";

let token = localStorage.getItem(TOKEN_KEY);
export function setToken(t) {
  token = t || null;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}
export function getToken() { return token; }
export function isAuthenticated() { return !!token; }

// O AuthContext registra aqui o que fazer quando a API responde 401.
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function request(path, { method = "GET", body, isForm = false } = {}) {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let payload = body;
  if (body && !isForm) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });

  if (res.status === 401) {
    setToken(null);
    if (onUnauthorized) onUnauthorized();
  }
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch { detail = await res.text(); }
    throw new Error(`HTTP ${res.status} — ${detail}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

export const api = {
  get: (p) => request(p),
  post: (p, b) => request(p, { method: "POST", body: b }),
  patch: (p, b) => request(p, { method: "PATCH", body: b }),
  del: (p) => request(p, { method: "DELETE" }),
  postForm: (p, form) => request(p, { method: "POST", body: form, isForm: true }),
};

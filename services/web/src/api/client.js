// Cliente HTTP do painel Zaplane → API Gateway (NestJS).
// Em dev, a base é /api/v1 (Vite faz proxy p/ :3000).
//
// O access token dura 15 minutos. Quando ele expira, este cliente troca o
// refresh token por um par novo e REFAZ a requisição original — o usuário não
// percebe nada. Antes disso, qualquer 401 derrubava a sessão na hora e quem
// estivesse no meio do wizard de campanha perdia tudo.

const BASE = import.meta.env.VITE_API_URL || "/api/v1";
const TOKEN_KEY = "zaplane_token";
const REFRESH_KEY = "zaplane_refresh";

let token = localStorage.getItem(TOKEN_KEY);
let refreshToken = localStorage.getItem(REFRESH_KEY);

export function setToken(t) {
  token = t || null;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}
export function setRefreshToken(t) {
  refreshToken = t || null;
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  else localStorage.removeItem(REFRESH_KEY);
}
export function getToken() { return token; }
export function getRefreshToken() { return refreshToken; }
export function isAuthenticated() { return !!token; }
export function clearSession() { setToken(null); setRefreshToken(null); }

// O AuthContext registra aqui o que fazer quando a sessão realmente acaba.
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

// Uma renovação por vez: se três requisições receberem 401 juntas, todas
// esperam a MESMA troca em vez de gastarem três refresh tokens em paralelo
// (o backend faz rotação, então as concorrentes seriam recusadas e derrubariam
// a sessão sem necessidade).
let renovacaoEmCurso = null;

async function renovarSessao() {
  if (!refreshToken) return false;
  if (!renovacaoEmCurso) {
    renovacaoEmCurso = (async () => {
      try {
        const res = await fetch(`${BASE}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return false;
        const data = await res.json();
        if (!data?.accessToken) return false;
        setToken(data.accessToken);
        if (data.refreshToken) setRefreshToken(data.refreshToken);
        return true;
      } catch {
        return false; // rede caiu: não derruba a sessão, só falha a tentativa
      } finally {
        renovacaoEmCurso = null;
      }
    })();
  }
  return renovacaoEmCurso;
}

function montar(path, { method = "GET", body, isForm = false } = {}) {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let payload = body;
  if (body && !isForm) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  return fetch(`${BASE}${path}`, { method, headers, body: payload });
}

async function request(path, opts = {}) {
  let res = await montar(path, opts);

  // 401: tenta renovar uma vez e refazer a requisição. A própria rota de
  // refresh é exceção — se ELA responde 401, a sessão acabou de verdade.
  if (res.status === 401 && !path.startsWith("/auth/refresh")) {
    const renovou = await renovarSessao();
    if (renovou) {
      res = await montar(path, opts);
    } else {
      clearSession();
      if (onUnauthorized) onUnauthorized();
    }
  }

  if (res.status === 401) {
    clearSession();
    if (onUnauthorized) onUnauthorized();
  }

  if (!res.ok) {
    let detail = "";
    let json = null;
    try { json = await res.json(); detail = JSON.stringify(json); } catch { detail = await res.text(); }
    const err = new Error(`HTTP ${res.status} — ${detail}`);
    // corpo estruturado (ex.: {ok:false, etapas:[...], message}) — telas que precisam
    // de mais que uma string (ex.: pipeline de conexão de canal) leem err.body/err.status.
    err.status = res.status;
    err.body = json;
    throw err;
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

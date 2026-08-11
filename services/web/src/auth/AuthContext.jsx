import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { isAuthenticated, setUnauthorizedHandler } from "../api/client.js";
import {
  login as apiLogin,
  register as apiRegister,
  logout as apiLogout,
  getMe,
} from "../api/endpoints.js";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [authed, setAuthed] = useState(isAuthenticated());
  // Usuário da sessão. Vem do /auth/me — antes o painel exibia um nome fixo
  // escrito no JSX, igual para todo mundo.
  const [user, setUser] = useState(null);
  const [carregandoUser, setCarregandoUser] = useState(isAuthenticated());

  const carregarUser = useCallback(async () => {
    try {
      setUser(await getMe());
    } catch {
      // 401 já é tratado pelo client (derruba a sessão); qualquer outra falha
      // não deve travar o painel — a barra superior mostra um estado neutro.
      setUser(null);
    } finally {
      setCarregandoUser(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => { setAuthed(false); setUser(null); });
  }, []);

  // carrega o perfil quando a sessão existe (inclusive ao recarregar a página)
  useEffect(() => {
    if (!authed) { setUser(null); setCarregandoUser(false); return; }
    setCarregandoUser(true);
    carregarUser();
  }, [authed, carregarUser]);

  async function login(email, password) {
    const r = await apiLogin(email, password);
    if (r?.user) setUser(r.user); // pinta a identidade na hora; /auth/me completa depois
    setAuthed(true);
  }
  async function register(dto) {
    const r = await apiRegister(dto);
    if (r?.user) setUser(r.user);
    setAuthed(true);
  }
  function logout() {
    apiLogout();
    setUser(null);
    setAuthed(false);
  }

  return (
    <AuthCtx.Provider value={{ authed, user, carregandoUser, login, register, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth deve ser usado dentro de AuthProvider");
  return ctx;
}

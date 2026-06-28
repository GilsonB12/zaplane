import React, { createContext, useContext, useEffect, useState } from "react";
import { isAuthenticated, setUnauthorizedHandler } from "../api/client.js";
import { login as apiLogin, register as apiRegister, logout as apiLogout } from "../api/endpoints.js";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [authed, setAuthed] = useState(isAuthenticated());

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false));
  }, []);

  async function login(email, password) {
    await apiLogin(email, password);
    setAuthed(true);
  }
  async function register(dto) {
    await apiRegister(dto);
    setAuthed(true);
  }
  function logout() {
    apiLogout();
    setAuthed(false);
  }

  return (
    <AuthCtx.Provider value={{ authed, login, register, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth deve ser usado dentro de AuthProvider");
  return ctx;
}

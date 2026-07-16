import React, { useState } from "react";
import { Zap } from "lucide-react";
import { BRAND, TEAL } from "../components/ui.jsx";
import { useAuth } from "../auth/AuthContext.jsx";

export default function Login() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState("login"); // "login" | "register"
  const [form, setForm] = useState({ organizationName: "", name: "", email: "", password: "" });
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (mode === "login") await login(form.email, form.password);
      else await register({
        organizationName: form.organizationName, name: form.name,
        email: form.email, password: form.password,
      });
    } catch (err) {
      setError(err.message || "Falha na autenticação.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-7 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl text-white" style={{ background: `linear-gradient(135deg, ${BRAND}, ${TEAL})` }}>
            <Zap className="h-5 w-5" />
          </div>
          <div className="text-[15px] font-semibold text-zinc-900 dark:text-white">Zaplane</div>
        </div>

        <h1 className="text-lg font-semibold text-zinc-900 dark:text-white">
          {mode === "login" ? "Entrar" : "Criar conta"}
        </h1>
        <p className="mb-5 text-[13px] text-zinc-500 dark:text-zinc-400">
          {mode === "login" ? "Acesse o painel da sua organização." : "Crie sua organização e o usuário owner."}
        </p>

        <form onSubmit={submit} className="space-y-3">
          {mode === "register" && (
            <>
              <input required value={form.organizationName} onChange={set("organizationName")} placeholder="Nome da organização"
                className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />
              <input required value={form.name} onChange={set("name")} placeholder="Seu nome"
                className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />
            </>
          )}
          <input required type="email" value={form.email} onChange={set("email")} placeholder="E-mail"
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />
          <input required type="password" value={form.password} onChange={set("password")} placeholder="Senha"
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />

          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

          <button type="submit" disabled={pending}
            className="w-full rounded-xl py-2 text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: BRAND }}>
            {pending ? "Aguarde…" : mode === "login" ? "Entrar" : "Criar conta"}
          </button>
        </form>

        <button onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}
          className="mt-4 w-full text-center text-[13px] font-medium text-[#0F8C5A] hover:underline dark:text-emerald-300">
          {mode === "login" ? "Não tem conta? Criar agora" : "Já tem conta? Entrar"}
        </button>
      </div>
    </div>
  );
}

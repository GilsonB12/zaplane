import React, { useEffect, useState } from "react";
import { Zap, ArrowLeft, MailCheck } from "lucide-react";
import { BRAND, TEAL } from "../components/ui.jsx";
import { useAuth } from "../auth/AuthContext.jsx";
import { forgotPassword, resetPassword } from "../api/endpoints.js";

const INPUT =
  "w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-base outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 sm:py-2 sm:text-sm";

export default function Login() {
  const { login, register } = useAuth();
  // "login" | "register" | "esqueci" | "redefinir"
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ organizationName: "", name: "", email: "", password: "" });
  const [error, setError] = useState(null);
  const [aviso, setAviso] = useState(null);
  const [pending, setPending] = useState(false);
  // token de redefinição vindo do link do e-mail (?redefinir=...)
  const [tokenReset, setTokenReset] = useState(null);
  const [novaSenha, setNovaSenha] = useState("");

  // O e-mail manda o usuário para /?redefinir=TOKEN — abrimos direto na tela
  // de nova senha e limpamos a URL (o token não deve ficar no histórico).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("redefinir");
    if (t) {
      setTokenReset(t);
      setMode("redefinir");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function trocarModo(novo) {
    setMode(novo);
    setError(null);
    setAviso(null);
  }

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setAviso(null);
    setPending(true);
    try {
      if (mode === "login") {
        await login(form.email, form.password);
      } else if (mode === "register") {
        await register({
          organizationName: form.organizationName, name: form.name,
          email: form.email, password: form.password,
        });
      } else if (mode === "esqueci") {
        const r = await forgotPassword(form.email);
        setAviso(r?.message || "Se este e-mail estiver cadastrado, enviamos as instruções.");
      } else if (mode === "redefinir") {
        await resetPassword(tokenReset, novaSenha);
        setAviso("Senha redefinida. Entre com a nova senha.");
        setMode("login");
        setNovaSenha("");
      }
    } catch (err) {
      setError(err.body?.message || err.message || "Falha na autenticação.");
    } finally {
      setPending(false);
    }
  }

  const titulo = {
    login: "Entrar",
    register: "Criar conta",
    esqueci: "Recuperar senha",
    redefinir: "Escolher nova senha",
  }[mode];

  const subtitulo = {
    login: "Acesse o painel da sua organização.",
    register: "Crie sua organização e o usuário owner.",
    esqueci: "Informe seu e-mail e enviaremos um link para criar uma nova senha.",
    redefinir: "Digite a nova senha da sua conta.",
  }[mode];

  const rotulo = {
    login: "Entrar",
    register: "Criar conta",
    esqueci: "Enviar link de recuperação",
    redefinir: "Salvar nova senha",
  }[mode];

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-7 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl text-white" style={{ background: `linear-gradient(135deg, ${BRAND}, ${TEAL})` }}>
            <Zap className="h-5 w-5" />
          </div>
          <div className="text-[15px] font-semibold text-zinc-900 dark:text-white">Zaplane</div>
        </div>

        <h1 className="text-lg font-semibold text-zinc-900 dark:text-white">{titulo}</h1>
        <p className="mb-5 text-[13px] text-zinc-500 dark:text-zinc-400">{subtitulo}</p>

        <form onSubmit={submit} className="space-y-3">
          {mode === "register" && (
            <>
              <input required value={form.organizationName} onChange={set("organizationName")} placeholder="Nome da organização" className={INPUT} />
              <input required value={form.name} onChange={set("name")} placeholder="Seu nome" className={INPUT} />
            </>
          )}

          {mode !== "redefinir" && (
            <input required type="email" value={form.email} onChange={set("email")} placeholder="E-mail" className={INPUT} />
          )}

          {(mode === "login" || mode === "register") && (
            <input required type="password" value={form.password} onChange={set("password")} placeholder="Senha" className={INPUT} />
          )}

          {mode === "redefinir" && (
            <>
              <input
                required type="password" minLength={8}
                value={novaSenha} onChange={(e) => setNovaSenha(e.target.value)}
                placeholder="Nova senha (mínimo 8 caracteres)" className={INPUT}
              />
              <p className="text-[11px] text-zinc-400">
                Ao salvar, as sessões abertas em outros dispositivos serão encerradas.
              </p>
            </>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>
          )}
          {aviso && (
            <div className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
              <MailCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {aviso}
            </div>
          )}

          <button type="submit" disabled={pending}
            className="w-full rounded-xl py-2.5 text-sm font-semibold text-white disabled:opacity-60 sm:py-2" style={{ backgroundColor: BRAND }}>
            {pending ? "Aguarde…" : rotulo}
          </button>
        </form>

        {mode === "login" && (
          <div className="mt-4 flex flex-col gap-2 text-center">
            <button onClick={() => trocarModo("esqueci")}
              className="text-[13px] font-medium text-zinc-500 hover:underline dark:text-zinc-400">
              Esqueci minha senha
            </button>
            <button onClick={() => trocarModo("register")}
              className="text-[13px] font-medium text-[#0F8C5A] hover:underline dark:text-emerald-300">
              Não tem conta? Criar agora
            </button>
          </div>
        )}

        {mode === "register" && (
          <button onClick={() => trocarModo("login")}
            className="mt-4 w-full text-center text-[13px] font-medium text-[#0F8C5A] hover:underline dark:text-emerald-300">
            Já tem conta? Entrar
          </button>
        )}

        {(mode === "esqueci" || mode === "redefinir") && (
          <button onClick={() => trocarModo("login")}
            className="mt-4 inline-flex w-full items-center justify-center gap-1.5 text-[13px] font-medium text-zinc-500 hover:underline dark:text-zinc-400">
            <ArrowLeft className="h-3.5 w-3.5" /> Voltar para o login
          </button>
        )}
      </div>
    </div>
  );
}

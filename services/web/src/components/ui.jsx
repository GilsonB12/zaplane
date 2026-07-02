import React from "react";
import {
  CheckCheck, BadgeCheck, Clock, XCircle, Zap, ShieldCheck, Sun, Moon,
  LayoutDashboard, Users, Send, Megaphone, LayoutTemplate, Settings, LogOut,
} from "lucide-react";

/* ----------------------------- Tokens de cor ----------------------------- */
export const BRAND = "#0F8C5A";
export const BRAND_DARK = "#0c7a4e";
export const TEAL = "#128C7E";

/* ----------------------------- Metadados de status de campanha ----------------------------- */
export const STATUS_META = {
  enviando:  { label: "Enviando",  cls: "bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-500/10 dark:text-blue-300", dot: "bg-blue-500" },
  concluida: { label: "Concluída", cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300", dot: "bg-emerald-500" },
  rascunho:  { label: "Rascunho",  cls: "bg-zinc-100 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-700/40 dark:text-zinc-300", dot: "bg-zinc-400" },
  falha:     { label: "Falha",     cls: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300", dot: "bg-red-500" },
};

/* ----------------------------- Metadados de consentimento ----------------------------- */
export const CONSENT_META = {
  consentido: { label: "Consentido", cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300" },
  pendente:   { label: "Pendente",   cls: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300" },
  optout:     { label: "Opt-out",    cls: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300" },
};

/* ----------------------------- Metadados de status de template ----------------------------- */
export const TPL_STATUS = {
  aprovado:   { label: "Aprovado",  cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300", icon: BadgeCheck },
  em_analise: { label: "Em análise", cls: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300", icon: Clock },
  rejeitado:  { label: "Rejeitado", cls: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300", icon: XCircle },
};

/* ----------------------------- Metadados de categoria de template ----------------------------- */
export const CAT_META = {
  Marketing:      "bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-500/10 dark:text-violet-300",
  Utility:        "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300",
  Authentication: "bg-zinc-100 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-700/40 dark:text-zinc-300",
};

/* ----------------------------- Itens de navegação lateral ----------------------------- */
export const NAV = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "contatos", label: "Contatos", icon: Users },
  { id: "nova", label: "Nova campanha", icon: Send },
  { id: "campanhas", label: "Campanhas", icon: Megaphone },
  { id: "templates", label: "Templates", icon: LayoutTemplate },
  { id: "config", label: "Configurações", icon: Settings },
];

/* ----------------------------- Card ----------------------------- */
export function Card({ children, className = "" }) {
  return (
    <div className={`rounded-2xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${className}`}>
      {children}
    </div>
  );
}

/* ----------------------------- StatusBadge ----------------------------- */
export function StatusBadge({ status }) {
  const m = STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${m.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot} ${status === "enviando" ? "animate-pulse" : ""}`} />
      {m.label}
    </span>
  );
}

/* ----------------------------- ConsentChip ----------------------------- */
export function ConsentChip({ consent }) {
  const m = CONSENT_META[consent];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${m.cls}`}>{m.label}</span>;
}

/* ----------------------------- TplStatusBadge ----------------------------- */
export function TplStatusBadge({ status }) {
  const m = TPL_STATUS[status]; const I = m.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${m.cls}`}>
      <I className="h-3 w-3" /> {m.label}
    </span>
  );
}

/* ----------------------------- CategoryTag ----------------------------- */
export function CategoryTag({ cat }) {
  return <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${CAT_META[cat]}`}>{cat}</span>;
}

/* ----------------------------- ProgressBar ----------------------------- */
export function ProgressBar({ value, total, color = BRAND }) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}

/* ----------------------------- WhatsAppBubble ----------------------------- */
export function WhatsAppBubble({ corpo, botoes = [], nome = "Mariana" }) {
  // Tokens de prévia: *negrito*, ⟦pendente⟧ (âmbar) e «dinâmico» (esmeralda).
  // Corpo cru com {{1}}/{{2}} ganha valores demo (comportamento da galeria).
  const texto = corpo
    .replace(/\{\{1\}\}/g, nome)
    .replace(/\{\{2\}\}/g, "#48213")
    .split(/(\*[^*]+\*|⟦[^⟧]+⟧|«[^»]+»)/g)
    .map((p, i) => {
      if (p.startsWith("*") && p.endsWith("*")) return <strong key={i}>{p.slice(1, -1)}</strong>;
      if (p.startsWith("⟦") && p.endsWith("⟧"))
        return (
          <span key={i} className="rounded bg-amber-200/80 px-1 font-medium text-amber-800 dark:bg-amber-500/25 dark:text-amber-200">
            {p.slice(1, -1)}
          </span>
        );
      if (p.startsWith("«") && p.endsWith("»"))
        return (
          <span key={i} className="rounded bg-emerald-200/70 px-1 font-medium text-emerald-800 dark:bg-emerald-500/25 dark:text-emerald-200">
            {p.slice(1, -1)}
          </span>
        );
      return <span key={i}>{p}</span>;
    });
  return (
    <div className="rounded-2xl bg-[#E5DDD5] p-4 dark:bg-zinc-800/60">
      <div className="ml-auto max-w-[88%]">
        <div className="relative rounded-xl rounded-tr-sm bg-[#DCF8C6] px-3 py-2 text-[13px] leading-snug text-zinc-800 shadow-sm dark:bg-[#075E54]/90 dark:text-zinc-50">
          <p className="whitespace-pre-wrap">{texto}</p>
          <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-zinc-500 dark:text-zinc-300">
            12:04 <CheckCheck className="h-3 w-3 text-sky-500" />
          </div>
        </div>
        {botoes.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {botoes.map((b) => (
              <div key={b} className="rounded-lg bg-white px-3 py-1.5 text-center text-[13px] font-medium text-[#128C7E] shadow-sm dark:bg-zinc-700 dark:text-emerald-300">{b}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- Sidebar ----------------------------- */
export function Sidebar({ screen, setScreen }) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-white px-3 py-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2.5 px-2 pb-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl text-white shadow-sm" style={{ background: `linear-gradient(135deg, ${BRAND}, ${TEAL})` }}>
          <Zap className="h-5 w-5" />
        </div>
        <div>
          <div className="text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-white">Zaplane</div>
          <div className="text-[11px] text-zinc-400">WhatsApp Business API</div>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {NAV.map((n) => {
          const active = screen === n.id || (screen === "campanha-detalhe" && n.id === "campanhas");
          const I = n.icon;
          return (
            <button key={n.id} onClick={() => setScreen(n.id)}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                active ? "bg-emerald-50 text-[#0F8C5A] dark:bg-emerald-500/10 dark:text-emerald-300"
                       : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"}`}>
              <I className="h-[18px] w-[18px]" />
              {n.label}
              {n.id === "campanhas" && <span className="ml-auto rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-300">1</span>}
            </button>
          );
        })}
      </nav>

      <div className="mt-4 rounded-xl border border-emerald-200/60 bg-emerald-50/60 p-3 dark:border-emerald-500/20 dark:bg-emerald-500/5">
        <div className="flex items-center gap-2 text-xs font-semibold text-[#0F8C5A] dark:text-emerald-300">
          <ShieldCheck className="h-4 w-4" /> Conformidade LGPD
        </div>
        <p className="mt-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
          Base de consentimento ativa. <a href="#" className="font-medium text-[#0F8C5A] underline-offset-2 hover:underline dark:text-emerald-300">Política de privacidade</a>
        </p>
      </div>
    </aside>
  );
}

/* ----------------------------- Topbar ----------------------------- */
export function Topbar({ title, subtitle, dark, setDark, actions, onLogout }) {
  return (
    <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-zinc-200 bg-white/80 px-7 py-4 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80">
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold tracking-tight text-zinc-900 dark:text-white">{title}</h1>
        {subtitle && <p className="truncate text-[13px] text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
      </div>
      <div className="ml-auto flex items-center gap-2">
        {actions}
        <button onClick={() => setDark(!dark)} title="Alternar tema"
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-200 text-zinc-500 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800">
          {dark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </button>
        <div className="flex items-center gap-2 rounded-xl border border-zinc-200 py-1.5 pl-1.5 pr-3 dark:border-zinc-800">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-900 text-xs font-semibold text-white dark:bg-zinc-700">AB</div>
          <div className="leading-tight whitespace-nowrap">
            <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-100">Ana Beatriz</div>
            <div className="text-[10px] text-zinc-400">Owner</div>
          </div>
        </div>
        {onLogout && (
          <button onClick={onLogout} title="Sair"
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-200 text-zinc-500 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800">
            <LogOut className="h-[18px] w-[18px]" />
          </button>
        )}
      </div>
    </header>
  );
}

/* ----------------------------- PrimaryBtn ----------------------------- */
export function PrimaryBtn({ children, onClick, className = "", disabled = false }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${className}`}
      style={{ backgroundColor: BRAND }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.backgroundColor = BRAND_DARK; }}
      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = BRAND)}>
      {children}
    </button>
  );
}

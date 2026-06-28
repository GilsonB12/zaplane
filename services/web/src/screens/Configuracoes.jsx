import React, { useState } from "react";
import {
  Plus, MoreVertical,
  Phone, CreditCard, UserCog,
  Info, CircleDot, BadgeCheck, Star,
} from "lucide-react";
import { BRAND, Card, ProgressBar, PrimaryBtn } from "../components/ui.jsx";

/* ----------------------------- Dados de exemplo (equipe) ----------------------------- */
// Equipe ainda é exemplo — será ligada à API na Fatia 2
const MEMBROS = [
  { id: 1, nome: "Ana Beatriz",   email: "ana@zaplane.com.br",    papel: "Owner" },
  { id: 2, nome: "Carlos Eduardo", email: "carlos@zaplane.com.br", papel: "Admin" },
  { id: 3, nome: "Renata Souza",  email: "renata@zaplane.com.br", papel: "Operador" },
  { id: 4, nome: "Tiago Melo",    email: "tiago@zaplane.com.br",  papel: "Leitor" },
];

const RBAC_DESC = {
  Owner:    "Acesso total, billing e exclusão da conta.",
  Admin:    "Gerencia campanhas, contatos, templates e equipe.",
  Operador: "Cria e dispara campanhas. Sem acesso a billing.",
  Leitor:   "Apenas visualização de relatórios.",
};
const RBAC_CLS = {
  Owner:    "bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-500/10 dark:text-violet-300",
  Admin:    "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300",
  Operador: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300",
  Leitor:   "bg-zinc-100 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-700/40 dark:text-zinc-300",
};

/* ----------------------------- Configurações ----------------------------- */
export default function Configuracoes() {
  const [tab, setTab] = useState("meta");
  const tabs = [
    { id: "meta",    label: "Conexão Meta",   icon: Phone },
    { id: "equipe",  label: "Equipe (RBAC)",  icon: UserCog },
    { id: "billing", label: "Plano & billing", icon: CreditCard },
  ];

  return (
    <div className="space-y-5 p-7">
      {/* Banner de aviso — dados de exemplo */}
      <div className="rounded-xl bg-amber-50 px-4 py-2 text-[13px] text-amber-800 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300">
        Dados de exemplo — Conexão, Equipe e Billing entram na próxima fatia.
      </div>

      <div
        className="flex items-center gap-1 rounded-xl border border-zinc-200 bg-white p-1 dark:border-zinc-800 dark:bg-zinc-900"
        style={{ width: "fit-content" }}
      >
        {tabs.map((t) => {
          const I = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                tab === t.id
                  ? "bg-emerald-50 text-[#0F8C5A] dark:bg-emerald-500/10 dark:text-emerald-300"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
              }`}
            >
              <I className="h-4 w-4" /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === "meta" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="p-6 lg:col-span-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">WhatsApp Business Platform</h2>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300">
                <CircleDot className="h-3 w-3" /> Conectado
              </span>
            </div>
            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {[
                ["Phone Number ID", "109523847710042"],
                ["WABA ID", "204417752298813"],
                ["Número de exibição", "+55 11 5555-0042"],
                ["Nome verificado", "Zaplane Tecnologia"],
              ].map(([k, v]) => (
                <div key={k}>
                  <div className="text-[11px] uppercase tracking-wide text-zinc-400">{k}</div>
                  <div className="mt-0.5 inline-flex items-center gap-1.5 text-[13px] font-medium tabular-nums text-zinc-800 dark:text-zinc-100">
                    {v} {k === "Nome verificado" && <BadgeCheck className="h-4 w-4 text-sky-500" />}
                  </div>
                </div>
              ))}
            </div>
          </Card>
          <Card className="p-6">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Quality rating</h2>
            <div className="mt-4 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 dark:bg-emerald-500/10">
                <div className="h-5 w-5 rounded-full bg-emerald-500" />
              </div>
              <div>
                <div className="text-base font-semibold text-emerald-600 dark:text-emerald-400">Verde · Alta</div>
                <div className="text-[12px] text-zinc-400">Tier de mensagens: 100k/dia</div>
              </div>
            </div>
            <div className="mt-4 space-y-2 text-[12px] text-zinc-500 dark:text-zinc-400">
              <div className="flex items-center justify-between">
                <span>Status do número</span><span className="font-medium text-zinc-700 dark:text-zinc-200">Ativo</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Limite atual</span><span className="font-medium text-zinc-700 dark:text-zinc-200">100.000 / dia</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Bloqueios (7d)</span><span className="font-medium text-zinc-700 dark:text-zinc-200">0</span>
              </div>
            </div>
          </Card>
        </div>
      )}

      {tab === "equipe" && (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Membros da equipe</h2>
            <PrimaryBtn><Plus className="h-4 w-4" /> Convidar membro</PrimaryBtn>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-zinc-100 bg-zinc-50/60 text-left text-[11px] uppercase tracking-wide text-zinc-400 dark:border-zinc-800 dark:bg-zinc-800/40">
                <th className="px-5 py-2.5 font-medium">Membro</th>
                <th className="px-3 py-2.5 font-medium">Papel</th>
                <th className="px-3 py-2.5 font-medium">Permissões</th>
                <th className="px-5 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {MEMBROS.map((m) => (
                <tr key={m.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
                        {m.nome.split(" ").map((n) => n[0]).slice(0, 2).join("")}
                      </div>
                      <div>
                        <div className="font-medium text-zinc-800 dark:text-zinc-100">{m.nome}</div>
                        <div className="text-[12px] text-zinc-400">{m.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${RBAC_CLS[m.papel]}`}>
                      {m.papel}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-[12px] text-zinc-500 dark:text-zinc-400">{RBAC_DESC[m.papel]}</td>
                  <td className="px-5 py-3 text-right">
                    <button className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                      <MoreVertical className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {tab === "billing" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="p-6 lg:col-span-2">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-400">Plano atual</div>
                <div className="mt-1 text-xl font-semibold text-zinc-900 dark:text-white">Growth</div>
                <div className="text-[13px] text-zinc-500 dark:text-zinc-400">R$ 499/mês + uso por conversa</div>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium text-white" style={{ backgroundColor: BRAND }}>
                <Star className="h-3 w-3" /> Ativo
              </span>
            </div>
            <div className="mt-5">
              <div className="mb-1.5 flex items-center justify-between text-[12px]">
                <span className="text-zinc-500 dark:text-zinc-400">Conversas no ciclo</span>
                <span className="font-medium text-zinc-700 dark:text-zinc-200">38.420 / 60.000</span>
              </div>
              <ProgressBar value={38420} total={60000} />
            </div>
            <div className="mt-5 grid grid-cols-3 gap-3">
              <div className="rounded-xl bg-zinc-50 p-4 dark:bg-zinc-800/40">
                <div className="text-[11px] text-zinc-400">Gasto no mês</div>
                <div className="mt-0.5 text-lg font-semibold text-zinc-900 dark:text-white">R$ 2.901</div>
              </div>
              <div className="rounded-xl bg-zinc-50 p-4 dark:bg-zinc-800/40">
                <div className="text-[11px] text-zinc-400">Crédito disponível</div>
                <div className="mt-0.5 text-lg font-semibold text-zinc-900 dark:text-white">R$ 1.100</div>
              </div>
              <div className="rounded-xl bg-zinc-50 p-4 dark:bg-zinc-800/40">
                <div className="text-[11px] text-zinc-400">Próx. fatura</div>
                <div className="mt-0.5 text-lg font-semibold text-zinc-900 dark:text-white">01/07</div>
              </div>
            </div>
          </Card>
          <Card className="p-6">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Forma de pagamento</h2>
            <div className="mt-4 flex items-center gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="flex h-9 w-12 items-center justify-center rounded-lg bg-zinc-900 text-[10px] font-bold text-white">VISA</div>
              <div>
                <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">•••• 4242</div>
                <div className="text-[11px] text-zinc-400">Expira 09/28</div>
              </div>
            </div>
            <button className="mt-3 w-full rounded-xl border border-zinc-200 py-2 text-[13px] font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800">
              Gerenciar cobrança
            </button>
            <p className="mt-3 inline-flex items-start gap-1.5 text-[11px] text-zinc-400">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Cobrança por conversa segue a tabela da Meta por categoria e país.
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}

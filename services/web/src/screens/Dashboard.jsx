import React from "react";
import {
  Users, CheckCheck, ShieldCheck, Send,
  ChevronRight,
} from "lucide-react";
import { TEAL, Card, ProgressBar } from "../components/ui.jsx";
import { useResource } from "../hooks/useResource.js";
import { toUiCampaign } from "../api/adapters.js";
import { listContacts, listCampaigns } from "../api/endpoints.js";

/* ----------------------------- Dashboard parcial-live ----------------------------- */
export default function Dashboard({ setScreen, openCampaign }) {
  // Dados reais: total de contatos e últimas campanhas
  const contatosRes = useResource(() => listContacts({ pageSize: 1 }), []);
  const campRes     = useResource(() => listCampaigns({ pageSize: 5 }), []);

  const totalContatos = contatosRes.data?.total ?? 0;
  const ultimas       = (campRes.data?.items ?? []).map(toUiCampaign);

  // KPIs: apenas "Contatos ativos" é live; os demais são placeholders para a próxima fatia
  const kpis = [
    { id: "contatos", label: "Contatos ativos", valueNode: contatosRes.loading ? "…" : totalContatos.toLocaleString("pt-BR"), icon: Users, live: true },
    { id: "enviadas", label: "Enviadas hoje",   valueNode: "—",   icon: Send,        live: false },
    { id: "entrega",  label: "Taxa de entrega", valueNode: "—",   icon: CheckCheck,  live: false },
    { id: "optout",   label: "Opt-outs (30d)",  valueNode: "—",   icon: ShieldCheck, live: false },
  ];

  // Estado agregado da lista de campanhas (compartilhado pelas visões mobile e desktop)
  const estadoLista = campRes.loading
    ? { texto: "Carregando…", cls: "text-zinc-400" }
    : campRes.error
    ? { texto: "Erro ao carregar campanhas.", cls: "text-red-400" }
    : ultimas.length === 0
    ? { texto: "Nenhuma campanha ainda.", cls: "text-zinc-400" }
    : null;

  return (
    <div className="space-y-4 p-4 sm:space-y-6 sm:p-6 lg:p-7">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {kpis.map((k) => {
          const I = k.icon;
          return (
            <Card key={k.id} className="p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-[#0F8C5A] dark:bg-emerald-500/10 dark:text-emerald-300">
                  <I className="h-[18px] w-[18px]" />
                </div>
                {k.live ? (
                  <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300">
                    ao vivo
                  </span>
                ) : (
                  <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-500">
                    em breve
                  </span>
                )}
              </div>
              <div className="mt-3 break-words text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white sm:mt-4">
                {k.valueNode}
              </div>
              <div className="text-[13px] text-zinc-500 dark:text-zinc-400">{k.label}</div>
            </Card>
          );
        })}
      </div>

      {/* Saúde do número — placeholder rotulado */}
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Saúde do número</h2>
            <p className="text-[13px] text-zinc-500 dark:text-zinc-400">Canal de envio</p>
          </div>
          <span className="inline-flex w-fit shrink-0 items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-400 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-500">
            em breve — Fatia 2
          </span>
        </div>
        <p className="mt-3 text-[13px] text-zinc-400 dark:text-zinc-500">
          Os dados de quality rating, limite diário e status do número serão exibidos quando a integração de canais estiver disponível.
        </p>
      </Card>

      {/* Últimas campanhas — live */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3.5 sm:px-5 sm:py-4">
          <h2 className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-white">Últimas campanhas</h2>
          <button
            onClick={() => setScreen("campanhas")}
            className="-my-2 inline-flex shrink-0 items-center gap-1 py-2 text-xs font-medium text-[#0F8C5A] hover:underline dark:text-emerald-300"
          >
            Ver todas <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Mobile: lista de cards (o dedo agradece) */}
        <div className="lg:hidden">
          {estadoLista ? (
            <div className={`border-t border-zinc-100 px-4 py-6 text-center text-[13px] dark:border-zinc-800 ${estadoLista.cls}`}>
              {estadoLista.texto}
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800/60 dark:border-zinc-800">
              {ultimas.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => openCampaign(c.id)}
                    className="flex w-full flex-col gap-2 px-4 py-3.5 text-left active:bg-zinc-50 dark:active:bg-zinc-800/20"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0 flex-1 break-words text-sm font-medium text-zinc-800 dark:text-zinc-100">
                        {c.nome}
                      </span>
                      <span className="inline-flex shrink-0 items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-700/40 dark:text-zinc-300">
                        {c.status}
                      </span>
                    </div>
                    <ProgressBar value={c.enviadas} total={c.total || 1} color={TEAL} />
                    <div className="flex items-center justify-between gap-3 text-[12px] text-zinc-400">
                      <span className="min-w-0 truncate">{c.quando}</span>
                      <span className="shrink-0 tabular-nums text-zinc-600 dark:text-zinc-300">
                        {c.enviadas.toLocaleString("pt-BR")} enviadas
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Desktop: tabela completa */}
        <div className="hidden overflow-x-auto lg:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-zinc-100 bg-zinc-50/60 text-left text-[11px] uppercase tracking-wide text-zinc-400 dark:border-zinc-800 dark:bg-zinc-800/40">
                <th className="px-5 py-2.5 font-medium">Campanha</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Progresso</th>
                <th className="px-3 py-2.5 text-right font-medium">Enviadas</th>
                <th className="px-5 py-2.5 font-medium">Quando</th>
              </tr>
            </thead>
            <tbody>
              {estadoLista ? (
                <tr>
                  <td colSpan={5} className={`px-5 py-6 text-center text-[13px] ${estadoLista.cls}`}>
                    {estadoLista.texto}
                  </td>
                </tr>
              ) : (
                ultimas.map((c) => (
                  <tr
                    key={c.id}
                    className="cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-800/20"
                    onClick={() => openCampaign(c.id)}
                  >
                    <td className="px-5 py-3 font-medium text-zinc-800 dark:text-zinc-100">{c.nome}</td>
                    <td className="px-3 py-3">
                      <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-700/40 dark:text-zinc-300">
                        {c.status}
                      </span>
                    </td>
                    <td className="px-3 py-3 min-w-[120px]">
                      <ProgressBar value={c.enviadas} total={c.total || 1} color={TEAL} />
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-zinc-600 dark:text-zinc-300">
                      {c.enviadas.toLocaleString("pt-BR")}
                    </td>
                    <td className="px-5 py-3 text-zinc-400">{c.quando}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

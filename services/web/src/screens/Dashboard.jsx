import React from "react";
import {
  Users, CheckCheck, ShieldCheck, Send,
  ChevronRight, AlertTriangle, Info,
} from "lucide-react";
import { TEAL, Card, ProgressBar } from "../components/ui.jsx";
import { useResource } from "../hooks/useResource.js";
import { toUiCampaign } from "../api/adapters.js";
import { listCampaigns, getDashboardMetrics } from "../api/endpoints.js";

/* ----------------------------- Dashboard ----------------------------- */
export default function Dashboard({ setScreen, openCampaign }) {
  // Todos os indicadores vêm de /metrics/dashboard (contagens reais no banco).
  const metricsRes = useResource(getDashboardMetrics, []);
  const campRes    = useResource(() => listCampaigns({ pageSize: 5 }), []);

  const m       = metricsRes.data ?? null;
  const ultimas = (campRes.data?.items ?? []).map(toUiCampaign);

  const num = (v) => (v ?? 0).toLocaleString("pt-BR");
  // enquanto carrega mostra "…"; taxa de entrega sem envios no dia é "—" com
  // legenda explicando (0% sugeriria falha, o que seria mentira)
  const val = (fn) => (metricsRes.loading ? "…" : metricsRes.error ? "—" : fn());

  const kpis = [
    {
      id: "contatos", label: "Contatos ativos", icon: Users,
      valueNode: val(() => num(m?.contatosAtivos)),
      hint: "Contatos que não saíram da base",
    },
    {
      id: "enviadas", label: "Enviadas hoje", icon: Send,
      valueNode: val(() => num(m?.enviadasHoje)),
      hint: m?.falhasHoje ? `${num(m.falhasHoje)} falha(s) hoje` : "Mensagens que saíram hoje",
    },
    {
      id: "entrega", label: "Taxa de entrega", icon: CheckCheck,
      valueNode: val(() => (m?.taxaEntregaPct == null ? "—" : `${m.taxaEntregaPct}%`)),
      hint: m?.taxaEntregaPct == null ? "Sem envios hoje" : `${num(m?.entreguesHoje)} de ${num(m?.enviadasHoje)} entregues`,
    },
    {
      id: "optout", label: "Opt-outs (30d)", icon: ShieldCheck,
      valueNode: val(() => num(m?.optOuts30d)),
      hint: "Pediram para não receber",
    },
  ];

  const canal = m?.canal ?? null;
  const QUALIDADE = {
    GREEN:  { label: "Alta",  cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300" },
    YELLOW: { label: "Média", cls: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300" },
    RED:    { label: "Baixa", cls: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300" },
  };
  const qual = canal?.qualityRating ? QUALIDADE[canal.qualityRating] : null;

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
      {/* Alerta ativo da Meta (pagamento pendente, qualidade, restrição).
          É o único aviso que recebemos sobre a saúde da conta do cliente. */}
      {canal?.alerta && (
        <div className={`flex items-start gap-3 rounded-xl border p-4 ${
          canal.alerta.severidade === "CRITICAL"
            ? "border-red-200 bg-red-50 dark:border-red-500/20 dark:bg-red-500/5"
            : "border-amber-200 bg-amber-50 dark:border-amber-500/20 dark:bg-amber-500/5"
        }`}>
          <AlertTriangle className={`mt-0.5 h-5 w-5 shrink-0 ${
            canal.alerta.severidade === "CRITICAL" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"
          }`} />
          <div className="min-w-0">
            <div className={`text-sm font-semibold ${
              canal.alerta.severidade === "CRITICAL" ? "text-red-800 dark:text-red-300" : "text-amber-800 dark:text-amber-300"
            }`}>
              A Meta sinalizou um problema no seu número
            </div>
            <p className={`mt-0.5 break-words text-[13px] ${
              canal.alerta.severidade === "CRITICAL" ? "text-red-700 dark:text-red-300" : "text-amber-700 dark:text-amber-300"
            }`}>
              {canal.alerta.mensagem || "Verifique a situação da conta no WhatsApp Manager."}
            </p>
            <a
              href="https://business.facebook.com/wa/manage/"
              target="_blank" rel="noopener noreferrer"
              className="mt-1.5 inline-block text-[13px] font-medium underline underline-offset-2"
            >
              Abrir o WhatsApp Manager
            </a>
          </div>
        </div>
      )}

      {/* Passo pendente: forma de pagamento na Meta. Não conseguimos verificar
          isso por API (é restrito a Solution Provider), então orientamos assim
          que o número é conectado — sem esse cartão, a Meta trava os envios. */}
      {canal && !canal.alerta && (
        <details className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <summary className="cursor-pointer list-none text-sm font-medium text-zinc-800 dark:text-zinc-100">
            <span className="inline-flex items-center gap-2">
              <Info className="h-4 w-4 shrink-0 text-zinc-400" />
              Já cadastrou a forma de pagamento na Meta?
            </span>
          </summary>
          <div className="mt-3 space-y-2 text-[13px] leading-snug text-zinc-600 dark:text-zinc-300">
            <p>
              A Meta cobra você diretamente por mensagem entregue — separado da sua assinatura do
              Zaplane. Sem um cartão cadastrado na sua conta do WhatsApp Business, os envios param
              depois de um período inicial de cortesia.
            </p>
            <a
              href="https://business.facebook.com/wa/manage/"
              target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-semibold text-white hover:opacity-90"
              style={{ backgroundColor: "#0F8C5A" }}
            >
              Cadastrar na Meta
            </a>
            <p className="text-[12px] text-zinc-400">
              Configurações de pagamento → Adicionar forma de pagamento (Brasil, BRL).
            </p>
          </div>
        </details>
      )}

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
              </div>
              <div className="mt-3 break-words text-2xl font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-white sm:mt-4">
                {k.valueNode}
              </div>
              <div className="text-[13px] text-zinc-500 dark:text-zinc-400">{k.label}</div>
              {k.hint && <div className="mt-0.5 text-[11px] text-zinc-400">{k.hint}</div>}
            </Card>
          );
        })}
      </div>

      {/* Saúde do número — dados reais do canal conectado */}
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Saúde do número</h2>
            <p className="truncate text-[13px] text-zinc-500 dark:text-zinc-400">
              {canal ? (canal.displayNumber || canal.label) : "Canal de envio"}
            </p>
          </div>
          {qual && (
            <span className={`inline-flex w-fit shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${qual.cls}`}>
              Qualidade: {qual.label}
            </span>
          )}
        </div>

        {metricsRes.loading ? (
          <p className="mt-3 text-[13px] text-zinc-400">Carregando…</p>
        ) : canal ? (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <div className="text-[11px] text-zinc-400">Status</div>
              <div className="mt-0.5 text-sm font-medium text-zinc-800 dark:text-zinc-100">
                {canal.status === "active" ? "Conectado" : canal.status}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-zinc-400">Qualidade</div>
              <div className="mt-0.5 text-sm font-medium text-zinc-800 dark:text-zinc-100">
                {qual?.label ?? "Sem dados ainda"}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-zinc-400">Limite por segundo</div>
              <div className="mt-0.5 text-sm font-medium tabular-nums text-zinc-800 dark:text-zinc-100">
                {canal.throughputLimit ?? "—"}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-zinc-400">Conectado via</div>
              <div className="mt-0.5 text-sm font-medium text-zinc-800 dark:text-zinc-100">
                {canal.connectedVia === "embedded_signup" ? "WhatsApp" : "Manual"}
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-col items-start gap-2">
            <p className="text-[13px] text-zinc-500 dark:text-zinc-400">
              Nenhum número conectado. Conecte um número do WhatsApp Business para disparar campanhas.
            </p>
            <button
              onClick={() => setScreen("config")}
              className="text-[13px] font-medium text-[#0F8C5A] hover:underline dark:text-emerald-300"
            >
              Conectar número
            </button>
          </div>
        )}
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

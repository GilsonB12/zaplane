import React, { useState, useEffect } from "react";
import {
  Search, Plus, Upload, MoreVertical, Edit2, Trash2, MessageSquare,
  Check, Send, X, ChevronRight, ChevronLeft,
  Users, CheckCheck, ShieldCheck, BadgeCheck, Zap,
  AlertTriangle, Phone, CreditCard, UserCog,
  Filter, FileText, Info, ArrowUpRight, ArrowDownRight, CircleDot,
  Star, FileSpreadsheet, FileJson, ChevronDown,
} from "lucide-react";
import {
  BRAND, BRAND_DARK, TEAL, Card, StatusBadge, ConsentChip, TplStatusBadge,
  CategoryTag, ProgressBar, WhatsAppBubble, PrimaryBtn, Topbar, Sidebar, NAV,
} from "./components/ui.jsx";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";

/* ----------------------------- Mock data ----------------------------- */
const KPIS = [
  { id: "contatos", label: "Contatos ativos", value: "18.420", delta: "+4,2%", up: true, icon: Users },
  { id: "enviadas", label: "Enviadas hoje", value: "6.128", delta: "+12,8%", up: true, icon: Send },
  { id: "entrega", label: "Taxa de entrega", value: "97,3%", delta: "+0,4 p.p.", up: true, icon: CheckCheck },
  { id: "optout", label: "Opt-outs (30d)", value: "214", delta: "+1,1%", up: false, icon: ShieldCheck },
];

const ENVIOS_14D = [
  { dia: "12/06", enviadas: 3120 }, { dia: "13/06", enviadas: 2890 },
  { dia: "14/06", enviadas: 1740 }, { dia: "15/06", enviadas: 1980 },
  { dia: "16/06", enviadas: 4210 }, { dia: "17/06", enviadas: 5380 },
  { dia: "18/06", enviadas: 4960 }, { dia: "19/06", enviadas: 5510 },
  { dia: "20/06", enviadas: 6120 }, { dia: "21/06", enviadas: 3340 },
  { dia: "22/06", enviadas: 2210 }, { dia: "23/06", enviadas: 5870 },
  { dia: "24/06", enviadas: 6420 }, { dia: "25/06", enviadas: 6128 },
];

const CAMPANHAS = [
  { id: "c1", nome: "Black Friday — Aquecimento", template: "bf_aquecimento_v2", status: "enviando",
    total: 8400, enviadas: 5210, entregues: 5012, lidas: 3380, falhas: 198, categoria: "Marketing", quando: "Hoje, 09:12" },
  { id: "c2", nome: "Confirmação de pedido", template: "pedido_confirmado", status: "concluida",
    total: 1240, enviadas: 1240, entregues: 1228, lidas: 1102, falhas: 12, categoria: "Utility", quando: "Ontem, 18:40" },
  { id: "c3", nome: "Recuperação de carrinho", template: "carrinho_abandonado", status: "concluida",
    total: 3120, enviadas: 3120, entregues: 2998, lidas: 1870, falhas: 122, categoria: "Marketing", quando: "23/06, 14:20" },
  { id: "c4", nome: "Pesquisa NPS pós-venda", template: "nps_pos_venda", status: "rascunho",
    total: 2050, enviadas: 0, entregues: 0, lidas: 0, falhas: 0, categoria: "Utility", quando: "—" },
  { id: "c5", nome: "Código de verificação", template: "otp_login", status: "falha",
    total: 640, enviadas: 410, entregues: 120, lidas: 0, falhas: 290, categoria: "Authentication", quando: "22/06, 11:05" },
];

const CONTATOS = [
  { id: 1, nome: "Mariana Alves", tel: "+55 11 98123-4477", ddd: "11", regiao: "Sudeste", tag: "Cliente VIP", consent: "consentido" },
  { id: 2, nome: "Bruno Carvalho", tel: "+55 21 99654-1209", ddd: "21", regiao: "Sudeste", tag: "Lead", consent: "pendente" },
  { id: 3, nome: "Carla Menezes", tel: "+55 71 98877-3321", ddd: "71", regiao: "Nordeste", tag: "Cliente VIP", consent: "consentido" },
  { id: 4, nome: "Diego Fontes", tel: "+55 51 99123-8890", ddd: "51", regiao: "Sul", tag: "Newsletter", consent: "optout" },
  { id: 5, nome: "Eduarda Lima", tel: "+55 85 98456-1122", ddd: "85", regiao: "Nordeste", tag: "Lead", consent: "consentido" },
  { id: 6, nome: "Felipe Souza", tel: "+55 41 99765-0099", ddd: "41", regiao: "Sul", tag: "Cliente", consent: "pendente" },
  { id: 7, nome: "Gabriela Pinto", tel: "+55 62 98321-7766", ddd: "62", regiao: "Centro-Oeste", tag: "Cliente", consent: "consentido" },
  { id: 8, nome: "Henrique Dias", tel: "+55 11 99888-1234", ddd: "11", regiao: "Sudeste", tag: "Newsletter", consent: "consentido" },
  { id: 9, nome: "Isabela Rocha", tel: "+55 92 98112-4567", ddd: "92", regiao: "Norte", tag: "Lead", consent: "optout" },
  { id: 10, nome: "João Marques", tel: "+55 31 99543-8821", ddd: "31", regiao: "Sudeste", tag: "Cliente VIP", consent: "consentido" },
];

const TEMPLATES = [
  { id: "t1", nome: "bf_aquecimento_v2", categoria: "Marketing", status: "aprovado", idioma: "pt_BR",
    corpo: "Oi {{1}}! 🛍️ A Black Friday da nossa loja começou. Você tem *15% OFF* exclusivo até amanhã. Toque para ver as ofertas.", botoes: ["Ver ofertas", "Sair da lista"] },
  { id: "t2", nome: "pedido_confirmado", categoria: "Utility", status: "aprovado", idioma: "pt_BR",
    corpo: "Olá {{1}}, seu pedido *{{2}}* foi confirmado e já está em separação. Acompanhe o status pelo link.", botoes: ["Acompanhar pedido"] },
  { id: "t3", nome: "carrinho_abandonado", categoria: "Marketing", status: "em_analise", idioma: "pt_BR",
    corpo: "{{1}}, você esqueceu alguns itens no carrinho 👀 Finalize agora e ganhe frete grátis.", botoes: ["Finalizar compra"] },
  { id: "t4", nome: "otp_login", categoria: "Authentication", status: "aprovado", idioma: "pt_BR",
    corpo: "Seu código de verificação é *{{1}}*. Ele expira em 5 minutos. Não compartilhe com ninguém.", botoes: ["Copiar código"] },
  { id: "t5", nome: "nps_pos_venda", categoria: "Utility", status: "em_analise", idioma: "pt_BR",
    corpo: "Olá {{1}}! Como foi sua experiência com a {{2}}? Responda de 0 a 10 — leva 10 segundos. 🙏", botoes: [] },
  { id: "t6", nome: "promo_relampago", categoria: "Marketing", status: "rejeitado", idioma: "pt_BR",
    corpo: "🔥🔥 PROMOÇÃO IMPERDÍVEL!!! CLIQUE JÁ E GANHE!!! Não perca essa chance ÚNICA!!!", botoes: ["GANHAR AGORA"] },
];

const MEMBROS = [
  { id: 1, nome: "Ana Beatriz", email: "ana@zaplane.com.br", papel: "Owner" },
  { id: 2, nome: "Carlos Eduardo", email: "carlos@zaplane.com.br", papel: "Admin" },
  { id: 3, nome: "Renata Souza", email: "renata@zaplane.com.br", papel: "Operador" },
  { id: 4, nome: "Tiago Melo", email: "tiago@zaplane.com.br", papel: "Leitor" },
];

/* ----------------------------- Dashboard ----------------------------- */
function Dashboard({ setScreen, openCampaign }) {
  return (
    <div className="space-y-6 p-7">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {KPIS.map((k) => {
          const I = k.icon;
          return (
            <Card key={k.id} className="p-5">
              <div className="flex items-center justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-50 text-[#0F8C5A] dark:bg-emerald-500/10 dark:text-emerald-300">
                  <I className="h-[18px] w-[18px]" />
                </div>
                <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${k.up ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}`}>
                  {k.up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}{k.delta}
                </span>
              </div>
              <div className="mt-4 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white">{k.value}</div>
              <div className="text-[13px] text-zinc-500 dark:text-zinc-400">{k.label}</div>
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Envios — últimos 14 dias</h2>
              <p className="text-[13px] text-zinc-500 dark:text-zinc-400">Total no período: 60.728 mensagens</p>
            </div>
            <span className="rounded-lg bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">Diário</span>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={ENVIOS_14D} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={BRAND} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={BRAND} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-zinc-200 dark:text-zinc-800" vertical={false} />
                <XAxis dataKey="dia" tick={{ fontSize: 11, fill: "currentColor" }} className="text-zinc-400" tickLine={false} axisLine={false} interval={1} />
                <YAxis tick={{ fontSize: 11, fill: "currentColor" }} className="text-zinc-400" tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ borderRadius: 12, border: "1px solid #e4e4e7", fontSize: 12, boxShadow: "0 4px 16px rgba(0,0,0,.08)" }}
                  labelStyle={{ fontWeight: 600 }} formatter={(v) => [v.toLocaleString("pt-BR"), "Enviadas"]} />
                <Area type="monotone" dataKey="enviadas" stroke={BRAND} strokeWidth={2.5} fill="url(#g)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Saúde do número</h2>
          <p className="text-[13px] text-zinc-500 dark:text-zinc-400">+55 11 5555-0042</p>
          <div className="mt-5 space-y-4">
            <div>
              <div className="flex items-center justify-between text-xs"><span className="text-zinc-500 dark:text-zinc-400">Quality rating</span><span className="font-semibold text-emerald-600 dark:text-emerald-400">Verde · Alta</span></div>
              <div className="mt-1.5"><ProgressBar value={92} total={100} /></div>
            </div>
            <div>
              <div className="flex items-center justify-between text-xs"><span className="text-zinc-500 dark:text-zinc-400">Limite diário (tier)</span><span className="font-semibold text-zinc-700 dark:text-zinc-200">100.000 / dia</span></div>
              <div className="mt-1.5"><ProgressBar value={6128} total={100000} color={TEAL} /></div>
            </div>
            <div className="rounded-xl bg-emerald-50/70 p-3 text-[12px] leading-snug text-emerald-800 dark:bg-emerald-500/5 dark:text-emerald-300">
              <BadgeCheck className="mb-1 h-4 w-4" />
              Número conectado e em conformidade. Próxima revisão de qualidade em 12 dias.
            </div>
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Últimas campanhas</h2>
          <button onClick={() => setScreen("campanhas")} className="inline-flex items-center gap-1 text-xs font-medium text-[#0F8C5A] hover:underline dark:text-emerald-300">
            Ver todas <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="overflow-x-auto">
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
              {CAMPANHAS.map((c) => (
                <tr key={c.id} onClick={() => openCampaign(c.id)} className="cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50/80 dark:border-zinc-800/60 dark:hover:bg-zinc-800/30">
                  <td className="px-5 py-3">
                    <div className="font-medium text-zinc-800 dark:text-zinc-100">{c.nome}</div>
                    <div className="text-[11px] text-zinc-400">{c.template} · <CategoryTag cat={c.categoria} /></div>
                  </td>
                  <td className="px-3 py-3"><StatusBadge status={c.status} /></td>
                  <td className="px-3 py-3"><div className="w-32"><ProgressBar value={c.enviadas} total={c.total} color={c.status === "falha" ? "#ef4444" : BRAND} /></div></td>
                  <td className="px-3 py-3 text-right tabular-nums text-zinc-600 dark:text-zinc-300">{c.enviadas.toLocaleString("pt-BR")}<span className="text-zinc-300 dark:text-zinc-600"> / {c.total.toLocaleString("pt-BR")}</span></td>
                  <td className="px-5 py-3 text-[13px] text-zinc-500 dark:text-zinc-400">{c.quando}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ----------------------------- Contatos ----------------------------- */
function Contatos({ openImport }) {
  const [q, setQ] = useState("");
  const [regiao, setRegiao] = useState("");
  const [tag, setTag] = useState("");
  const [consent, setConsent] = useState("");

  const regioes = [...new Set(CONTATOS.map((c) => c.regiao))];
  const tags = [...new Set(CONTATOS.map((c) => c.tag))];

  const filtrados = CONTATOS.filter((c) =>
    (!q || c.nome.toLowerCase().includes(q.toLowerCase()) || c.tel.includes(q) || c.ddd.includes(q)) &&
    (!regiao || c.regiao === regiao) && (!tag || c.tag === tag) && (!consent || c.consent === consent));

  const sel = (v, set, opts, ph) => (
    <div className="relative">
      <select value={v} onChange={(e) => set(e.target.value)}
        className="appearance-none rounded-xl border border-zinc-200 bg-white py-2 pl-3 pr-8 text-sm text-zinc-600 outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
        <option value="">{ph}</option>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
    </div>
  );

  return (
    <div className="space-y-4 p-7">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome, telefone ou DDD…"
            className="w-full rounded-xl border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm outline-none placeholder:text-zinc-400 focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />
        </div>
        <div className="flex items-center gap-1.5 text-zinc-400"><Filter className="h-4 w-4" /></div>
        {sel(regiao, setRegiao, regioes, "Região / DDD")}
        {sel(tag, setTag, tags, "Tag")}
        {sel(consent, setConsent, ["consentido", "pendente", "optout"].map((x) => x), "Consentimento")}
        <div className="ml-auto" />
        <PrimaryBtn onClick={openImport}><Upload className="h-4 w-4" /> Importar contatos</PrimaryBtn>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3 text-[13px] dark:border-zinc-800">
          <span className="text-zinc-500 dark:text-zinc-400"><span className="font-semibold text-zinc-700 dark:text-zinc-200">{filtrados.length}</span> contatos</span>
          <span className="inline-flex items-center gap-1.5 text-zinc-400"><ShieldCheck className="h-3.5 w-3.5 text-[#0F8C5A]" /> Suprimidos por opt-out são ocultados de disparos automaticamente</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 bg-zinc-50/60 text-left text-[11px] uppercase tracking-wide text-zinc-400 dark:border-zinc-800 dark:bg-zinc-800/40">
                <th className="px-5 py-2.5 font-medium">Contato</th>
                <th className="px-3 py-2.5 font-medium">DDD / Região</th>
                <th className="px-3 py-2.5 font-medium">Tag</th>
                <th className="px-3 py-2.5 font-medium">Consentimento</th>
                <th className="px-5 py-2.5 text-right font-medium">Ações</th>
              </tr>
            </thead>
            <tbody>
              {filtrados.map((c) => (
                <tr key={c.id} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/80 dark:border-zinc-800/60 dark:hover:bg-zinc-800/30">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">{c.nome.split(" ").map((n) => n[0]).slice(0, 2).join("")}</div>
                      <div><div className="font-medium text-zinc-800 dark:text-zinc-100">{c.nome}</div><div className="text-[12px] tabular-nums text-zinc-400">{c.tel}</div></div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-zinc-600 dark:text-zinc-300">DDD {c.ddd} · <span className="text-zinc-400">{c.regiao}</span></td>
                  <td className="px-3 py-3"><span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{c.tag}</span></td>
                  <td className="px-3 py-3"><ConsentChip consent={c.consent} /></td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button title="Enviar mensagem" disabled={c.consent === "optout"} className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-[#0F8C5A] disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-zinc-800"><MessageSquare className="h-4 w-4" /></button>
                      <button title="Editar" className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"><Edit2 className="h-4 w-4" /></button>
                      <button title="Remover" className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtrados.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-12 text-center text-sm text-zinc-400">Nenhum contato encontrado com esses filtros.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ----------------------------- Import modal ----------------------------- */
function ImportModal({ onClose }) {
  const [base, setBase] = useState("consentimento");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-xl rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-zinc-100 px-6 py-4 dark:border-zinc-800">
          <div>
            <h3 className="text-base font-semibold text-zinc-900 dark:text-white">Importar contatos</h3>
            <p className="text-[13px] text-zinc-500 dark:text-zinc-400">Arquivos CSV, JSON ou XLSX até 20 MB</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X className="h-5 w-5" /></button>
        </div>

        <div className="space-y-5 p-6">
          <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-zinc-200 bg-zinc-50/60 px-6 py-9 text-center dark:border-zinc-700 dark:bg-zinc-800/30">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 text-[#0F8C5A] dark:bg-emerald-500/10 dark:text-emerald-300"><Upload className="h-6 w-6" /></div>
            <p className="mt-3 text-sm font-medium text-zinc-700 dark:text-zinc-200">Arraste o arquivo aqui ou <span className="text-[#0F8C5A] dark:text-emerald-300">selecione</span></p>
            <div className="mt-3 flex items-center gap-2 text-[11px] text-zinc-400">
              <span className="inline-flex items-center gap-1"><FileSpreadsheet className="h-3.5 w-3.5" /> CSV</span>
              <span className="inline-flex items-center gap-1"><FileJson className="h-3.5 w-3.5" /> JSON</span>
              <span className="inline-flex items-center gap-1"><FileSpreadsheet className="h-3.5 w-3.5" /> XLSX</span>
            </div>
          </div>

          {/* validation preview */}
          <div>
            <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-zinc-700 dark:text-zinc-200">
              <FileSpreadsheet className="h-4 w-4 text-zinc-400" /> contatos_junho.csv <span className="text-zinc-400">· 2.481 linhas</span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl border border-emerald-200/60 bg-emerald-50/60 p-3 dark:border-emerald-500/20 dark:bg-emerald-500/5">
                <div className="text-lg font-semibold text-emerald-700 dark:text-emerald-300">2.318</div>
                <div className="text-[11px] text-emerald-700/70 dark:text-emerald-300/70">válidos</div>
              </div>
              <div className="rounded-xl border border-amber-200/60 bg-amber-50/60 p-3 dark:border-amber-500/20 dark:bg-amber-500/5">
                <div className="text-lg font-semibold text-amber-700 dark:text-amber-300">142</div>
                <div className="text-[11px] text-amber-700/70 dark:text-amber-300/70">duplicados</div>
              </div>
              <div className="rounded-xl border border-red-200/60 bg-red-50/60 p-3 dark:border-red-500/20 dark:bg-red-500/5">
                <div className="text-lg font-semibold text-red-700 dark:text-red-300">21</div>
                <div className="text-[11px] text-red-700/70 dark:text-red-300/70">inválidos</div>
              </div>
            </div>
          </div>

          {/* base legal */}
          <div>
            <label className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-zinc-700 dark:text-zinc-200">
              <ShieldCheck className="h-4 w-4 text-[#0F8C5A]" /> Base legal / consentimento (LGPD)
            </label>
            <div className="grid grid-cols-1 gap-2">
              {[
                { v: "consentimento", t: "Consentimento explícito", d: "O titular autorizou o recebimento (opt-in)." },
                { v: "legitimo", t: "Legítimo interesse", d: "Relação comercial existente, com opt-out disponível." },
                { v: "contrato", t: "Execução de contrato", d: "Mensagens transacionais de um serviço contratado." },
              ].map((o) => (
                <label key={o.v} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${base === o.v ? "border-[#0F8C5A] bg-emerald-50/50 dark:bg-emerald-500/5" : "border-zinc-200 dark:border-zinc-800"}`}>
                  <input type="radio" name="base" checked={base === o.v} onChange={() => setBase(o.v)} className="mt-0.5 accent-[#0F8C5A]" />
                  <div><div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{o.t}</div><div className="text-[12px] text-zinc-500 dark:text-zinc-400">{o.d}</div></div>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-6 py-4 dark:border-zinc-800">
          <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400"><Info className="h-3.5 w-3.5" /> Inválidos e duplicados são ignorados na importação.</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-xl border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800">Cancelar</button>
            <PrimaryBtn onClick={onClose}><Check className="h-4 w-4" /> Importar 2.318 contatos</PrimaryBtn>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Nova campanha (wizard) ----------------------------- */
function NovaCampanha({ setScreen }) {
  const [step, setStep] = useState(1);
  const [publico, setPublico] = useState("vip");
  const [tplId, setTplId] = useState("t1");
  const tpl = TEMPLATES.find((t) => t.id === tplId);

  const PUBLICOS = {
    vip:    { nome: "Lista · Clientes VIP", total: 4280, suprimidos: 96 },
    sudeste:{ nome: "Segmento · DDD do Sudeste (11,21,31…)", total: 9120, suprimidos: 410 },
    leads:  { nome: "Segmento · Tag “Lead” + consentido", total: 2640, suprimidos: 612 },
  };
  const p = PUBLICOS[publico];
  const elegiveis = p.total - p.suprimidos;
  const aprovados = TEMPLATES.filter((t) => t.status === "aprovado");

  const steps = ["Público", "Template", "Revisão"];

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-7">
      {/* stepper */}
      <div className="flex items-center gap-2">
        {steps.map((s, i) => {
          const n = i + 1; const done = step > n; const active = step === n;
          return (
            <React.Fragment key={s}>
              <div className="flex items-center gap-2">
                <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                  active ? "text-white" : done ? "bg-emerald-100 text-[#0F8C5A] dark:bg-emerald-500/15 dark:text-emerald-300" : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800"}`}
                  style={active ? { backgroundColor: BRAND } : undefined}>
                  {done ? <Check className="h-4 w-4" /> : n}
                </div>
                <span className={`text-[13px] font-medium ${active ? "text-zinc-900 dark:text-white" : "text-zinc-400"}`}>{s}</span>
              </div>
              {i < steps.length - 1 && <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />}
            </React.Fragment>
          );
        })}
      </div>

      {/* STEP 1 */}
      {step === 1 && (
        <Card className="p-6">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-white">Quem vai receber?</h2>
          <p className="text-[13px] text-zinc-500 dark:text-zinc-400">Escolha uma lista ou um segmento dinâmico por DDD, região ou tag.</p>
          <div className="mt-5 space-y-2.5">
            {Object.entries(PUBLICOS).map(([k, v]) => (
              <label key={k} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-4 transition-colors ${publico === k ? "border-[#0F8C5A] bg-emerald-50/40 dark:bg-emerald-500/5" : "border-zinc-200 dark:border-zinc-800"}`}>
                <input type="radio" checked={publico === k} onChange={() => setPublico(k)} className="accent-[#0F8C5A]" />
                <div className="flex-1">
                  <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{v.nome}</div>
                  <div className="text-[12px] text-zinc-400">{v.total.toLocaleString("pt-BR")} contatos na base</div>
                </div>
                <div className="text-right"><div className="text-sm font-semibold text-zinc-900 dark:text-white">{(v.total - v.suprimidos).toLocaleString("pt-BR")}</div><div className="text-[11px] text-zinc-400">elegíveis</div></div>
              </label>
            ))}
          </div>

          <div className="mt-5 grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-zinc-50 p-4 text-center dark:bg-zinc-800/40"><div className="text-xl font-semibold text-zinc-900 dark:text-white">{p.total.toLocaleString("pt-BR")}</div><div className="text-[11px] text-zinc-500 dark:text-zinc-400">total estimado</div></div>
            <div className="rounded-xl bg-red-50/70 p-4 text-center dark:bg-red-500/5"><div className="text-xl font-semibold text-red-600 dark:text-red-300">−{p.suprimidos}</div><div className="text-[11px] text-red-500/80 dark:text-red-300/70">suprimidos (opt-out / sem base)</div></div>
            <div className="rounded-xl p-4 text-center text-white" style={{ backgroundColor: BRAND }}><div className="text-xl font-semibold">{elegiveis.toLocaleString("pt-BR")}</div><div className="text-[11px] opacity-90">vão receber</div></div>
          </div>

          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-200/70 bg-amber-50/70 p-3.5 dark:border-amber-500/20 dark:bg-amber-500/5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-[12px] leading-snug text-amber-800 dark:text-amber-300">
              <strong>{p.suprimidos} contatos sem base legal</strong> serão automaticamente suprimidos para manter a conformidade com a LGPD. Eles não entram no disparo nem na cobrança.
            </p>
          </div>
        </Card>
      )}

      {/* STEP 2 */}
      {step === 2 && (
        <Card className="p-6">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-white">Escolha um template aprovado</h2>
          <p className="text-[13px] text-zinc-500 dark:text-zinc-400">Apenas templates com aprovação da Meta podem ser disparados.</p>
          <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
            <div className="space-y-2">
              {aprovados.map((t) => (
                <label key={t.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors ${tplId === t.id ? "border-[#0F8C5A] bg-emerald-50/40 dark:bg-emerald-500/5" : "border-zinc-200 dark:border-zinc-800"}`}>
                  <input type="radio" checked={tplId === t.id} onChange={() => setTplId(t.id)} className="accent-[#0F8C5A]" />
                  <div className="flex-1"><div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{t.nome}</div><div className="mt-0.5"><CategoryTag cat={t.categoria} /></div></div>
                  <BadgeCheck className="h-4 w-4 text-emerald-500" />
                </label>
              ))}
              <div className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/40">
                <div className="mb-2 text-[12px] font-medium text-zinc-600 dark:text-zinc-300">Variáveis</div>
                <div className="space-y-2">
                  <div><div className="mb-1 text-[11px] text-zinc-400">{"{{1}}"} — Nome</div><input defaultValue="Mariana" className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-[#0F8C5A] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100" /></div>
                  {tpl.corpo.includes("{{2}}") && <div><div className="mb-1 text-[11px] text-zinc-400">{"{{2}}"} — Pedido</div><input defaultValue="#48213" className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-[#0F8C5A] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100" /></div>}
                </div>
              </div>
            </div>
            <div>
              <div className="mb-2 text-[12px] font-medium text-zinc-500 dark:text-zinc-400">Prévia</div>
              <WhatsAppBubble corpo={tpl.corpo} botoes={tpl.botoes} />
            </div>
          </div>
        </Card>
      )}

      {/* STEP 3 */}
      {step === 3 && (
        <Card className="p-6">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-white">Revisão e disparo</h2>
          <p className="text-[13px] text-zinc-500 dark:text-zinc-400">Confira os detalhes antes de confirmar.</p>
          <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
            <div className="space-y-3">
              {[
                ["Público", p.nome],
                ["Destinatários elegíveis", elegiveis.toLocaleString("pt-BR")],
                ["Suprimidos", `${p.suprimidos} (opt-out / sem base)`],
                ["Template", `${tpl.nome}`],
                ["Categoria", tpl.categoria],
                ["País", "Brasil (+55)"],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between border-b border-zinc-100 pb-2.5 text-[13px] last:border-0 dark:border-zinc-800">
                  <span className="text-zinc-500 dark:text-zinc-400">{k}</span>
                  <span className="font-medium text-zinc-800 dark:text-zinc-100">{v}</span>
                </div>
              ))}

              <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
                <div className="mb-2 text-[12px] font-medium text-zinc-500 dark:text-zinc-400">Estimativa de custo</div>
                <div className="flex items-center justify-between text-[13px]"><span className="text-zinc-600 dark:text-zinc-300">{elegiveis.toLocaleString("pt-BR")} × R$ 0,0625 <span className="text-zinc-400">({tpl.categoria}, BR)</span></span><span className="font-semibold text-zinc-900 dark:text-white">R$ {(elegiveis * 0.0625).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
                <div className="mt-2 flex items-center justify-between border-t border-zinc-100 pt-2 text-[13px] dark:border-zinc-800"><span className="font-medium text-zinc-700 dark:text-zinc-200">Total estimado</span><span className="text-base font-semibold" style={{ color: BRAND }}>R$ {(elegiveis * 0.0625).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
              </div>
            </div>
            <div>
              <div className="mb-2 text-[12px] font-medium text-zinc-500 dark:text-zinc-400">Mensagem final</div>
              <WhatsAppBubble corpo={tpl.corpo} botoes={tpl.botoes} />
              <div className="mt-3 flex items-start gap-2 rounded-xl bg-emerald-50/70 p-3 text-[12px] text-emerald-800 dark:bg-emerald-500/5 dark:text-emerald-300">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                Todas as mensagens incluem opção de opt-out. {p.suprimidos} contatos foram suprimidos por conformidade.
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* footer nav */}
      <div className="flex items-center justify-between">
        <button onClick={() => (step === 1 ? setScreen("campanhas") : setStep(step - 1))}
          className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800">
          <ChevronLeft className="h-4 w-4" /> {step === 1 ? "Cancelar" : "Voltar"}
        </button>
        {step < 3 ? (
          <PrimaryBtn onClick={() => setStep(step + 1)}>Continuar <ChevronRight className="h-4 w-4" /></PrimaryBtn>
        ) : (
          <PrimaryBtn onClick={() => setScreen("campanhas")}><Send className="h-4 w-4" /> Confirmar disparo · {elegiveis.toLocaleString("pt-BR")} envios</PrimaryBtn>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- Campanhas (lista) ----------------------------- */
function Campanhas({ openCampaign, setScreen }) {
  return (
    <div className="space-y-4 p-7">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {CAMPANHAS.map((c) => {
          const pct = c.total ? Math.round((c.enviadas / c.total) * 100) : 0;
          return (
            <Card key={c.id} className="cursor-pointer p-5 transition-shadow hover:shadow-md" >
              <div onClick={() => openCampaign(c.id)}>
                <div className="flex items-start justify-between">
                  <StatusBadge status={c.status} />
                  <button className="rounded-lg p-1 text-zinc-300 hover:bg-zinc-100 hover:text-zinc-500 dark:hover:bg-zinc-800"><MoreVertical className="h-4 w-4" /></button>
                </div>
                <h3 className="mt-3 text-[15px] font-semibold text-zinc-900 dark:text-white">{c.nome}</h3>
                <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-zinc-400">{c.template} <CategoryTag cat={c.categoria} /></div>
                <div className="mt-4">
                  <div className="mb-1.5 flex items-center justify-between text-[12px]"><span className="text-zinc-500 dark:text-zinc-400">{c.enviadas.toLocaleString("pt-BR")} / {c.total.toLocaleString("pt-BR")}</span><span className="font-medium tabular-nums text-zinc-600 dark:text-zinc-300">{pct}%</span></div>
                  <ProgressBar value={c.enviadas} total={c.total} color={c.status === "falha" ? "#ef4444" : BRAND} />
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div><div className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{c.entregues.toLocaleString("pt-BR")}</div><div className="text-[10px] text-zinc-400">entregues</div></div>
                  <div><div className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{c.lidas.toLocaleString("pt-BR")}</div><div className="text-[10px] text-zinc-400">lidas</div></div>
                  <div><div className="text-sm font-semibold text-red-500">{c.falhas}</div><div className="text-[10px] text-zinc-400">falhas</div></div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------- Campanha — detalhe ----------------------------- */
function CampanhaDetalhe({ campaignId, setScreen }) {
  const base = CAMPANHAS.find((c) => c.id === campaignId) || CAMPANHAS[0];
  const [live, setLive] = useState(base);

  // tempo real (somente p/ "enviando")
  useEffect(() => {
    if (base.status !== "enviando") return;
    const t = setInterval(() => {
      setLive((s) => {
        if (s.enviadas >= s.total) return s;
        const inc = Math.floor(Math.random() * 40) + 10;
        const enviadas = Math.min(s.total, s.enviadas + inc);
        return { ...s, enviadas, entregues: Math.round(enviadas * 0.96), lidas: Math.round(enviadas * 0.64), falhas: Math.round(enviadas * 0.038) };
      });
    }, 1400);
    return () => clearInterval(t);
  }, [base]);

  const metrics = [
    { k: "Enviadas", v: live.enviadas, total: live.total, color: BRAND },
    { k: "Entregues", v: live.entregues, total: live.total, color: TEAL },
    { k: "Lidas", v: live.lidas, total: live.total, color: "#3b82f6" },
    { k: "Falhas", v: live.falhas, total: live.total, color: "#ef4444" },
  ];

  const timeline = [
    { t: live.quando, label: "Campanha iniciada", desc: `${live.total.toLocaleString("pt-BR")} destinatários na fila`, icon: Send, done: true },
    { t: "+0m12s", label: "Aquecimento do número", desc: "Envio escalonado para preservar a qualidade", icon: Zap, done: true },
    { t: "agora", label: live.status === "enviando" ? "Enviando em tempo real" : "Envio concluído", desc: `${live.entregues.toLocaleString("pt-BR")} entregues · ${live.lidas.toLocaleString("pt-BR")} lidas`, icon: CheckCheck, done: live.status !== "enviando" },
    { t: "—", label: "Relatório final", desc: "Disponível ao término do disparo", icon: FileText, done: false },
  ];

  return (
    <div className="space-y-6 p-7">
      <button onClick={() => setScreen("campanhas")} className="inline-flex items-center gap-1 text-[13px] font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"><ChevronLeft className="h-4 w-4" /> Campanhas</button>

      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="flex items-center gap-3"><h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-white">{live.nome}</h1><StatusBadge status={live.status} /></div>
          <p className="mt-0.5 text-[13px] text-zinc-500 dark:text-zinc-400">{live.template} · <CategoryTag cat={live.categoria} /> · iniciada {live.quando}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {metrics.map((m) => (
          <Card key={m.k} className="p-5">
            <div className="text-[13px] text-zinc-500 dark:text-zinc-400">{m.k}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight" style={{ color: m.color }}>{m.v.toLocaleString("pt-BR")}</div>
            <div className="mt-3"><ProgressBar value={m.v} total={m.total} color={m.color} /></div>
            <div className="mt-1.5 text-[11px] text-zinc-400">{Math.round((m.v / m.total) * 100)}% do total</div>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-white">Timeline</h2>
          <div className="space-y-1">
            {timeline.map((item, i) => {
              const I = item.icon;
              return (
                <div key={i} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div className={`flex h-8 w-8 items-center justify-center rounded-full ${item.done ? "text-white" : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800"}`} style={item.done ? { backgroundColor: BRAND } : undefined}><I className="h-4 w-4" /></div>
                    {i < timeline.length - 1 && <div className="my-1 w-px flex-1 bg-zinc-200 dark:bg-zinc-800" />}
                  </div>
                  <div className="pb-5">
                    <div className="flex items-center gap-2"><span className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{item.label}</span><span className="text-[11px] text-zinc-400">{item.t}</span></div>
                    <p className="text-[12px] text-zinc-500 dark:text-zinc-400">{item.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-white">Conformidade</h2>
          <div className="space-y-3 text-[13px]">
            <div className="flex items-center justify-between"><span className="text-zinc-500 dark:text-zinc-400">Base legal</span><span className="font-medium text-zinc-800 dark:text-zinc-100">Consentimento</span></div>
            <div className="flex items-center justify-between"><span className="text-zinc-500 dark:text-zinc-400">Suprimidos (opt-out)</span><span className="font-medium text-zinc-800 dark:text-zinc-100">96</span></div>
            <div className="flex items-center justify-between"><span className="text-zinc-500 dark:text-zinc-400">Opt-out na mensagem</span><span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400"><Check className="h-3.5 w-3.5" /> Incluído</span></div>
            <div className="mt-2 flex items-start gap-2 rounded-xl bg-emerald-50/70 p-3 text-[12px] text-emerald-800 dark:bg-emerald-500/5 dark:text-emerald-300"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /> Disparo em conformidade com a LGPD. <a href="#" className="underline">Ver política</a></div>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ----------------------------- Templates ----------------------------- */
function Templates() {
  const [cat, setCat] = useState("Todas");
  const cats = ["Todas", "Marketing", "Utility", "Authentication"];
  const list = TEMPLATES.filter((t) => cat === "Todas" || t.categoria === cat);
  return (
    <div className="space-y-5 p-7">
      <div className="flex items-center gap-2">
        {cats.map((c) => (
          <button key={c} onClick={() => setCat(c)}
            className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${cat === c ? "text-white" : "border border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
            style={cat === c ? { backgroundColor: BRAND } : undefined}>{c}</button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {list.map((t) => (
          <Card key={t.id} className="flex flex-col overflow-hidden">
            <div className="flex items-start justify-between p-4 pb-3">
              <div><div className="text-[13px] font-semibold text-zinc-900 dark:text-white">{t.nome}</div><div className="mt-1 flex items-center gap-1.5"><CategoryTag cat={t.categoria} /><span className="text-[11px] text-zinc-400">{t.idioma}</span></div></div>
              <TplStatusBadge status={t.status} />
            </div>
            <div className="px-4 pb-4"><WhatsAppBubble corpo={t.corpo} botoes={t.botoes} /></div>
          </Card>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------- Configurações ----------------------------- */
const RBAC_DESC = {
  Owner: "Acesso total, billing e exclusão da conta.",
  Admin: "Gerencia campanhas, contatos, templates e equipe.",
  Operador: "Cria e dispara campanhas. Sem acesso a billing.",
  Leitor: "Apenas visualização de relatórios.",
};
const RBAC_CLS = {
  Owner: "bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-500/10 dark:text-violet-300",
  Admin: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300",
  Operador: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300",
  Leitor: "bg-zinc-100 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-700/40 dark:text-zinc-300",
};

function Configuracoes() {
  const [tab, setTab] = useState("meta");
  const tabs = [{ id: "meta", label: "Conexão Meta", icon: Phone }, { id: "equipe", label: "Equipe (RBAC)", icon: UserCog }, { id: "billing", label: "Plano & billing", icon: CreditCard }];
  return (
    <div className="space-y-5 p-7">
      <div className="flex items-center gap-1 rounded-xl border border-zinc-200 bg-white p-1 dark:border-zinc-800 dark:bg-zinc-900" style={{ width: "fit-content" }}>
        {tabs.map((t) => { const I = t.icon; return (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors ${tab === t.id ? "bg-emerald-50 text-[#0F8C5A] dark:bg-emerald-500/10 dark:text-emerald-300" : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"}`}>
            <I className="h-4 w-4" /> {t.label}
          </button>
        ); })}
      </div>

      {tab === "meta" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="p-6 lg:col-span-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">WhatsApp Business Platform</h2>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300"><CircleDot className="h-3 w-3" /> Conectado</span>
            </div>
            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {[
                ["Phone Number ID", "109523847710042"],
                ["WABA ID", "204417752298813"],
                ["Número de exibição", "+55 11 5555-0042"],
                ["Nome verificado", "Zaplane Tecnologia"],
              ].map(([k, v]) => (
                <div key={k}><div className="text-[11px] uppercase tracking-wide text-zinc-400">{k}</div><div className="mt-0.5 inline-flex items-center gap-1.5 text-[13px] font-medium tabular-nums text-zinc-800 dark:text-zinc-100">{v} {k === "Nome verificado" && <BadgeCheck className="h-4 w-4 text-sky-500" />}</div></div>
              ))}
            </div>
          </Card>
          <Card className="p-6">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Quality rating</h2>
            <div className="mt-4 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 dark:bg-emerald-500/10"><div className="h-5 w-5 rounded-full bg-emerald-500" /></div>
              <div><div className="text-base font-semibold text-emerald-600 dark:text-emerald-400">Verde · Alta</div><div className="text-[12px] text-zinc-400">Tier de mensagens: 100k/dia</div></div>
            </div>
            <div className="mt-4 space-y-2 text-[12px] text-zinc-500 dark:text-zinc-400">
              <div className="flex items-center justify-between"><span>Status do número</span><span className="font-medium text-zinc-700 dark:text-zinc-200">Ativo</span></div>
              <div className="flex items-center justify-between"><span>Limite atual</span><span className="font-medium text-zinc-700 dark:text-zinc-200">100.000 / dia</span></div>
              <div className="flex items-center justify-between"><span>Bloqueios (7d)</span><span className="font-medium text-zinc-700 dark:text-zinc-200">0</span></div>
            </div>
          </Card>
        </div>
      )}

      {tab === "equipe" && (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4"><h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Membros da equipe</h2><PrimaryBtn><Plus className="h-4 w-4" /> Convidar membro</PrimaryBtn></div>
          <table className="w-full text-sm">
            <thead><tr className="border-y border-zinc-100 bg-zinc-50/60 text-left text-[11px] uppercase tracking-wide text-zinc-400 dark:border-zinc-800 dark:bg-zinc-800/40"><th className="px-5 py-2.5 font-medium">Membro</th><th className="px-3 py-2.5 font-medium">Papel</th><th className="px-3 py-2.5 font-medium">Permissões</th><th className="px-5 py-2.5"></th></tr></thead>
            <tbody>
              {MEMBROS.map((m) => (
                <tr key={m.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                  <td className="px-5 py-3"><div className="flex items-center gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">{m.nome.split(" ").map((n) => n[0]).slice(0, 2).join("")}</div><div><div className="font-medium text-zinc-800 dark:text-zinc-100">{m.nome}</div><div className="text-[12px] text-zinc-400">{m.email}</div></div></div></td>
                  <td className="px-3 py-3"><span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${RBAC_CLS[m.papel]}`}>{m.papel}</span></td>
                  <td className="px-3 py-3 text-[12px] text-zinc-500 dark:text-zinc-400">{RBAC_DESC[m.papel]}</td>
                  <td className="px-5 py-3 text-right"><button className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><MoreVertical className="h-4 w-4" /></button></td>
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
              <div><div className="text-[11px] uppercase tracking-wide text-zinc-400">Plano atual</div><div className="mt-1 text-xl font-semibold text-zinc-900 dark:text-white">Growth</div><div className="text-[13px] text-zinc-500 dark:text-zinc-400">R$ 499/mês + uso por conversa</div></div>
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium text-white" style={{ backgroundColor: BRAND }}><Star className="h-3 w-3" /> Ativo</span>
            </div>
            <div className="mt-5">
              <div className="mb-1.5 flex items-center justify-between text-[12px]"><span className="text-zinc-500 dark:text-zinc-400">Conversas no ciclo</span><span className="font-medium text-zinc-700 dark:text-zinc-200">38.420 / 60.000</span></div>
              <ProgressBar value={38420} total={60000} />
            </div>
            <div className="mt-5 grid grid-cols-3 gap-3">
              <div className="rounded-xl bg-zinc-50 p-4 dark:bg-zinc-800/40"><div className="text-[11px] text-zinc-400">Gasto no mês</div><div className="mt-0.5 text-lg font-semibold text-zinc-900 dark:text-white">R$ 2.901</div></div>
              <div className="rounded-xl bg-zinc-50 p-4 dark:bg-zinc-800/40"><div className="text-[11px] text-zinc-400">Crédito disponível</div><div className="mt-0.5 text-lg font-semibold text-zinc-900 dark:text-white">R$ 1.100</div></div>
              <div className="rounded-xl bg-zinc-50 p-4 dark:bg-zinc-800/40"><div className="text-[11px] text-zinc-400">Próx. fatura</div><div className="mt-0.5 text-lg font-semibold text-zinc-900 dark:text-white">01/07</div></div>
            </div>
          </Card>
          <Card className="p-6">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Forma de pagamento</h2>
            <div className="mt-4 flex items-center gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800"><div className="flex h-9 w-12 items-center justify-center rounded-lg bg-zinc-900 text-[10px] font-bold text-white">VISA</div><div><div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">•••• 4242</div><div className="text-[11px] text-zinc-400">Expira 09/28</div></div></div>
            <button className="mt-3 w-full rounded-xl border border-zinc-200 py-2 text-[13px] font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800">Gerenciar cobrança</button>
            <p className="mt-3 inline-flex items-start gap-1.5 text-[11px] text-zinc-400"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Cobrança por conversa segue a tabela da Meta por categoria e país.</p>
          </Card>
        </div>
      )}
    </div>
  );
}

/* ----------------------------- App ----------------------------- */
const TITLES = {
  dashboard: ["Dashboard", "Visão geral da sua operação de mensagens"],
  contatos: ["Contatos", "Gerencie sua base e o consentimento (LGPD)"],
  nova: ["Nova campanha", "Configure público, template e disparo"],
  campanhas: ["Campanhas", "Acompanhe disparos em tempo real"],
  "campanha-detalhe": ["Detalhe da campanha", "Progresso e métricas em tempo real"],
  templates: ["Templates", "Modelos aprovados pela Meta"],
  config: ["Configurações", "Conexão, equipe e billing"],
};

export default function Zaplane() {
  const [screen, setScreen] = useState("dashboard");
  const [dark, setDark] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [campaignId, setCampaignId] = useState(null);

  const openCampaign = (id) => { setCampaignId(id); setScreen("campanha-detalhe"); };
  const [title, subtitle] = TITLES[screen] || TITLES.dashboard;

  const topActions =
    screen === "campanhas" ? <PrimaryBtn onClick={() => setScreen("nova")}><Plus className="h-4 w-4" /> Nova campanha</PrimaryBtn> :
    screen === "dashboard" ? <PrimaryBtn onClick={() => setScreen("nova")}><Send className="h-4 w-4" /> Disparar campanha</PrimaryBtn> :
    null;

  return (
    <div className={dark ? "dark" : ""}>
      <div className="flex h-screen overflow-hidden bg-zinc-50 font-sans text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        <Sidebar screen={screen} setScreen={(s) => { setScreen(s); }} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar title={title} subtitle={subtitle} dark={dark} setDark={setDark} actions={topActions} />
          <main className="flex-1 overflow-y-auto">
            {screen === "dashboard" && <Dashboard setScreen={setScreen} openCampaign={openCampaign} />}
            {screen === "contatos" && <Contatos openImport={() => setImportOpen(true)} />}
            {screen === "nova" && <NovaCampanha setScreen={setScreen} />}
            {screen === "campanhas" && <Campanhas openCampaign={openCampaign} setScreen={setScreen} />}
            {screen === "campanha-detalhe" && <CampanhaDetalhe campaignId={campaignId} setScreen={setScreen} />}
            {screen === "templates" && <Templates />}
            {screen === "config" && <Configuracoes />}
          </main>
        </div>
        {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}
      </div>
    </div>
  );
}

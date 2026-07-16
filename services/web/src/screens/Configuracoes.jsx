import React, { useState } from "react";
import {
  Plus, MoreVertical, Trash2,
  Phone, CreditCard, UserCog,
  Info, AlertTriangle, Wallet, Receipt,
} from "lucide-react";
import { Card, PrimaryBtn } from "../components/ui.jsx";
import { useResource, useMutation } from "../hooks/useResource.js";
import { listChannels, disconnectChannel, getBillingSummary, buyCredits } from "../api/endpoints.js";
import { formatBRL } from "../utils/money.js";
import ConectarWhatsAppButton from "../components/ConectarWhatsAppButton.jsx";
import ConectarManualModal from "../components/ConectarManualModal.jsx";

/* ----------------------------- Metadados da aba Conexão ----------------------------- */
const VIA_META = {
  manual:           { label: "Manual",           cls: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300" },
  embedded_signup:  { label: "Embedded Signup",   cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300" },
  bootstrap:        { label: "Inicial (seed)",    cls: "bg-zinc-100 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-700/40 dark:text-zinc-300" },
};
const STATUS_CANAL = {
  active:   { label: "Ativo",         cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300" },
  disabled: { label: "Desconectado",  cls: "bg-zinc-100 text-zinc-500 ring-zinc-500/20 dark:bg-zinc-700/40 dark:text-zinc-400" },
};
const QUALIDADE_META = {
  GREEN:   { label: "Alta",   cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300" },
  YELLOW:  { label: "Média",  cls: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300" },
  RED:     { label: "Baixa",  cls: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300" },
  UNKNOWN: { label: "Desconhecida", cls: "bg-zinc-100 text-zinc-500 ring-zinc-500/20 dark:bg-zinc-700/40 dark:text-zinc-400" },
};

/* ----------------------------- Metadados da aba Billing ----------------------------- */
const STATUS_ASSINATURA = {
  active:   { label: "Ativa",     cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300" },
  inactive: { label: "Inativa",   cls: "bg-zinc-100 text-zinc-500 ring-zinc-500/20 dark:bg-zinc-700/40 dark:text-zinc-400" },
  past_due: { label: "Vencida",   cls: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300" },
  canceled: { label: "Cancelada", cls: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300" },
};
const PAGAMENTO_KIND = { subscription: "Assinatura", credit_topup: "Créditos" };
const PAGAMENTO_STATUS = {
  paid:     { label: "Pago",         cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300" },
  pending:  { label: "Pendente",     cls: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300" },
  overdue:  { label: "Vencido",      cls: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300" },
  canceled: { label: "Cancelado",    cls: "bg-zinc-100 text-zinc-500 ring-zinc-500/20 dark:bg-zinc-700/40 dark:text-zinc-400" },
  refunded: { label: "Reembolsado",  cls: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300" },
};
const VALORES_COMPRA = [2000, 5000, 10000]; // R$ 20 / 50 / 100 em centavos

/* ----------------------------- Aba Plano & billing (live) ----------------------------- */
function AbaBilling() {
  const billingRes = useResource(getBillingSummary, []);
  const comprar = useMutation(buyCredits);
  const [seletorAberto, setSeletorAberto] = useState(false);
  const [mensagemCompra, setMensagemCompra] = useState(null);
  const [notaAtivar, setNotaAtivar] = useState(false);

  async function onComprar(valorCents) {
    setMensagemCompra(null);
    try {
      await comprar.run(valorCents);
      setMensagemCompra({ tipo: "sucesso", texto: "Créditos adicionados com sucesso." });
      billingRes.reload();
    } catch (e) {
      setMensagemCompra({
        tipo: "info",
        texto: e.body?.message || "Compra de créditos disponível em breve (Asaas).",
      });
    } finally {
      setSeletorAberto(false);
    }
  }

  if (billingRes.loading) {
    return (
      <div className="flex items-center justify-center py-16 text-[13px] text-zinc-400">
        Carregando informações de billing…
      </div>
    );
  }

  if (billingRes.error) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <div className="rounded-lg bg-red-50 px-4 py-3 text-[13px] text-red-700 dark:bg-red-500/10 dark:text-red-300">
          Falha ao carregar billing: {billingRes.error.message || String(billingRes.error)}
        </div>
        <button
          onClick={billingRes.reload}
          className="rounded-xl border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  const sub = billingRes.data?.subscription ?? null;
  const wallet = billingRes.data?.wallet ?? { balanceCents: 0 };
  const pagamentos = billingRes.data?.recentPayments ?? [];
  const status = sub?.status ?? "inactive";
  const st = STATUS_ASSINATURA[status] ?? STATUS_ASSINATURA.inactive;
  const precoCents = sub?.priceCents ?? 13500;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* Assinatura */}
      <Card className="p-6 lg:col-span-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-zinc-400">Assinatura Zaplane</div>
            <div className="mt-1 text-xl font-semibold text-zinc-900 dark:text-white">{formatBRL(precoCents)}/mês</div>
            <div className="text-[13px] text-zinc-500 dark:text-zinc-400">
              Libera criação de campanhas e envio de mensagens (template/avulso).
            </div>
          </div>
          <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${st.cls}`}>
            {st.label}
          </span>
        </div>

        {status === "active" && sub?.currentPeriodEnd && (
          <div className="mt-5 inline-block rounded-xl bg-zinc-50 p-4 dark:bg-zinc-800/40">
            <div className="text-[11px] text-zinc-400">Próximo vencimento</div>
            <div className="mt-0.5 text-lg font-semibold text-zinc-900 dark:text-white">
              {new Date(sub.currentPeriodEnd).toLocaleDateString("pt-BR")}
            </div>
          </div>
        )}

        {status === "past_due" && sub?.gracePeriodEndsAt && (
          <div className="mt-5 flex items-start gap-2 rounded-xl border border-amber-200/70 bg-amber-50/70 p-3.5 dark:border-amber-500/20 dark:bg-amber-500/5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-[12px] leading-snug text-amber-800 dark:text-amber-300">
              Pagamento pendente. Você tem carência até{" "}
              <strong>{new Date(sub.gracePeriodEndsAt).toLocaleDateString("pt-BR")}</strong>{" "}
              antes do envio de mensagens ser bloqueado.
            </p>
          </div>
        )}

        {status !== "active" && (
          <div className="mt-5">
            <PrimaryBtn onClick={() => setNotaAtivar(true)}>
              <CreditCard className="h-4 w-4" /> Ativar assinatura
            </PrimaryBtn>
            {notaAtivar && (
              <p className="mt-2.5 inline-flex items-start gap-1.5 text-[12px] text-zinc-500 dark:text-zinc-400">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Pagamento online (Pix/boleto via Asaas) chega em breve nesta tela. Por enquanto, fale
                com o suporte Zaplane para ativar sua assinatura manualmente.
              </p>
            )}
          </div>
        )}
      </Card>

      {/* Créditos (carteira) */}
      <Card className="p-6">
        <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-white">
          <Wallet className="h-4 w-4" /> Créditos (carteira)
        </h2>
        <div className="mt-3 rounded-xl bg-zinc-50 p-4 dark:bg-zinc-800/40">
          <div className="text-[11px] text-zinc-400">Saldo disponível</div>
          <div className="mt-0.5 text-2xl font-semibold text-zinc-900 dark:text-white">
            {formatBRL(wallet.balanceCents)}
          </div>
        </div>

        <button
          onClick={() => { setSeletorAberto((v) => !v); setMensagemCompra(null); }}
          className="mt-3 w-full rounded-xl border border-zinc-200 py-2 text-[13px] font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Comprar créditos
        </button>

        {seletorAberto && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            {VALORES_COMPRA.map((v) => (
              <button
                key={v}
                disabled={comprar.pending}
                onClick={() => onComprar(v)}
                className="rounded-lg border border-zinc-200 py-2 text-[13px] font-medium text-zinc-700 transition-colors hover:border-[#0F8C5A] hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-emerald-500/10"
              >
                {formatBRL(v)}
              </button>
            ))}
          </div>
        )}

        {mensagemCompra && (
          <p className={`mt-3 inline-flex items-start gap-1.5 text-[12px] ${mensagemCompra.tipo === "sucesso" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}>
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {mensagemCompra.texto}
          </p>
        )}

        <p className="mt-3 inline-flex items-start gap-1.5 text-[11px] text-zinc-400">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Cada mensagem de template entregue pela Meta debita R$ 0,43 da carteira.
        </p>
      </Card>

      {/* Extrato/pagamentos */}
      <Card className="overflow-hidden lg:col-span-3">
        <div className="flex items-center gap-1.5 px-5 py-4">
          <Receipt className="h-4 w-4 text-zinc-400" />
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Extrato de pagamentos</h2>
        </div>
        {pagamentos.length === 0 ? (
          <div className="px-5 pb-9 pt-1 text-center text-[13px] text-zinc-400">
            Nenhuma movimentação ainda.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-zinc-100 bg-zinc-50/60 text-left text-[11px] uppercase tracking-wide text-zinc-400 dark:border-zinc-800 dark:bg-zinc-800/40">
                  <th className="px-5 py-2.5 font-medium">Tipo</th>
                  <th className="px-3 py-2.5 font-medium">Valor</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Método</th>
                  <th className="px-5 py-2.5 font-medium">Data</th>
                </tr>
              </thead>
              <tbody>
                {pagamentos.map((p) => {
                  const pst = PAGAMENTO_STATUS[p.status] ?? PAGAMENTO_STATUS.pending;
                  const quando = p.paidAt ?? p.dueAt ?? p.createdAt;
                  return (
                    <tr key={p.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                      <td className="px-5 py-3 font-medium text-zinc-800 dark:text-zinc-100">
                        {PAGAMENTO_KIND[p.kind] ?? p.kind}
                      </td>
                      <td className="px-3 py-3 tabular-nums text-zinc-600 dark:text-zinc-300">
                        {formatBRL(p.amountCents)}
                        {p.kind === "credit_topup" && p.creditedCents != null && (
                          <span className="ml-1 text-[11px] text-zinc-400">
                            (creditou {formatBRL(p.creditedCents)})
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${pst.cls}`}>
                          {pst.label}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-zinc-500 dark:text-zinc-400">{p.method ?? "—"}</td>
                      <td className="px-5 py-3 text-zinc-400">
                        {quando ? new Date(quando).toLocaleDateString("pt-BR") : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

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
  const [modalManualAberto, setModalManualAberto] = useState(false);
  const [erroDesconectar, setErroDesconectar] = useState(null);
  const tabs = [
    { id: "meta",    label: "Conexão Meta",   icon: Phone },
    { id: "equipe",  label: "Equipe (RBAC)",  icon: UserCog },
    { id: "billing", label: "Plano & billing", icon: CreditCard },
  ];

  const canaisRes = useResource(listChannels, []);
  const canais = canaisRes.data?.items ?? [];
  const desconectar = useMutation(disconnectChannel);

  async function onDesconectar(id) {
    if (!window.confirm(
      "Isso desconecta o número do Zaplane, mas NÃO desfaz a configuração na Meta " +
      "(o app continua inscrito na WABA). Deseja continuar?",
    )) return;
    setErroDesconectar(null);
    try {
      await desconectar.run(id);
      canaisRes.reload();
    } catch (e) {
      setErroDesconectar(e.message || "Falha ao desconectar o canal.");
    }
  }

  const botoesConectar = (
    <div className="flex flex-wrap items-start gap-3">
      <ConectarWhatsAppButton onConnected={canaisRes.reload} primary />
      <button
        onClick={() => setModalManualAberto(true)}
        className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        <Plus className="h-4 w-4" /> Conectar manualmente
      </button>
    </div>
  );

  return (
    <div className="space-y-5 p-7">
      {/* Banner de aviso — dados de exemplo (Equipe segue mock; Conexão e Billing já são live) */}
      {tab === "equipe" && (
        <div className="rounded-xl bg-amber-50 px-4 py-2 text-[13px] text-amber-800 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300">
          Dados de exemplo — Equipe entra na próxima fatia.
        </div>
      )}

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
        <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Números conectados</h2>
              <p className="text-[13px] text-zinc-500 dark:text-zinc-400">
                Conecte pelo menos um número do WhatsApp Business para disparar campanhas.
              </p>
            </div>
            {canais.length > 0 && botoesConectar}
          </div>

          {erroDesconectar && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:bg-red-500/10 dark:text-red-300">
              {erroDesconectar}
            </div>
          )}

          {canaisRes.loading && (
            <div className="flex items-center justify-center py-16 text-[13px] text-zinc-400">
              Carregando canais…
            </div>
          )}

          {canaisRes.error && !canaisRes.loading && (
            <div className="flex flex-col items-center gap-3 py-16">
              <div className="rounded-lg bg-red-50 px-4 py-3 text-[13px] text-red-700 dark:bg-red-500/10 dark:text-red-300">
                Falha ao carregar canais: {canaisRes.error.message || String(canaisRes.error)}
              </div>
              <button
                onClick={canaisRes.reload}
                className="rounded-xl border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Tentar novamente
              </button>
            </div>
          )}

          {!canaisRes.loading && !canaisRes.error && (
            canais.length === 0 ? (
              <Card className="flex flex-col items-center gap-4 p-10 text-center">
                <p className="text-[13px] text-zinc-500 dark:text-zinc-400">
                  Nenhum número conectado ainda. Conecte pelo popup oficial da Meta ou cole as
                  credenciais manualmente.
                </p>
                {botoesConectar}
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {canais.map((c) => {
                  const via = VIA_META[c.connectedVia] ?? { label: c.connectedVia, cls: VIA_META.bootstrap.cls };
                  const st = STATUS_CANAL[c.status] ?? STATUS_CANAL.disabled;
                  const qual = c.qualityRating ? (QUALIDADE_META[c.qualityRating] ?? QUALIDADE_META.UNKNOWN) : null;
                  return (
                    <Card key={c.id} className="flex flex-col gap-3 p-5">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-[13px] font-semibold tabular-nums text-zinc-900 dark:text-white">
                            {c.displayNumber || c.phoneNumberId}
                          </div>
                          <div className="text-[12px] text-zinc-400">{c.label}</div>
                        </div>
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${st.cls}`}>
                          {st.label}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${via.cls}`}>
                          {via.label}
                        </span>
                        {qual && (
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${qual.cls}`}>
                            Qualidade: {qual.label}
                          </span>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-[11px] text-zinc-400">
                        <div>
                          Phone Number ID
                          <div className="tabular-nums text-zinc-600 dark:text-zinc-300">{c.phoneNumberId}</div>
                        </div>
                        <div>
                          WABA ID
                          <div className="tabular-nums text-zinc-600 dark:text-zinc-300">{c.wabaId}</div>
                        </div>
                      </div>

                      <div className="mt-1 flex items-center justify-between border-t border-zinc-100 pt-3 dark:border-zinc-800">
                        <span className="text-[11px] text-zinc-400">
                          {c.createdAt ? `Conectado em ${new Date(c.createdAt).toLocaleDateString("pt-BR")}` : ""}
                        </span>
                        <button
                          onClick={() => onDesconectar(c.id)}
                          disabled={c.status === "disabled" || desconectar.pending}
                          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-red-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline dark:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Desconectar
                        </button>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )
          )}

          {modalManualAberto && (
            <ConectarManualModal
              onClose={() => setModalManualAberto(false)}
              onConnected={canaisRes.reload}
            />
          )}
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

      {tab === "billing" && <AbaBilling />}
    </div>
  );
}

import React, { useState, useEffect } from "react";
import {
  Plus, MoreVertical, Trash2,
  Phone, CreditCard, UserCog,
  Info, AlertTriangle, Wallet, Receipt,
} from "lucide-react";
import { Card, PrimaryBtn, ROLE_LABEL, ROLE_DESC, ROLE_CLS, iniciaisDe } from "../components/ui.jsx";
import { useResource, useMutation } from "../hooks/useResource.js";
import {
  listChannels, disconnectChannel, getBillingSummary, buyCredits, listMembers,
  activateSubscription,
} from "../api/endpoints.js";
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
  const assinar = useMutation(activateSubscription);
  const [seletorAberto, setSeletorAberto] = useState(false);
  const [mensagemCompra, setMensagemCompra] = useState(null);
  const [mensagemAssinatura, setMensagemAssinatura] = useState(null);
  const [cpfInput, setCpfInput] = useState("");

  // pré-preenche o CPF/CNPJ já salvo na organização (billing.summary.cpfCnpj)
  useEffect(() => {
    if (billingRes.data?.cpfCnpj) setCpfInput(billingRes.data.cpfCnpj);
  }, [billingRes.data?.cpfCnpj]);

  // Ativa a assinatura de verdade: cria cliente + assinatura no Asaas e devolve
  // o link da 1ª cobrança. A assinatura só fica ativa quando o pagamento
  // confirma (webhook) — por isso o texto fala em "após a confirmação".
  async function onAssinar() {
    setMensagemAssinatura(null);
    try {
      const res = await assinar.run(cpfInput.trim() || undefined);
      if (res?.paymentUrl) window.open(res.paymentUrl, "_blank", "noopener,noreferrer");
      setMensagemAssinatura({
        tipo: "sucesso",
        texto: res?.paymentUrl
          ? "Cobrança gerada. Pague pelo link (Pix, boleto ou cartão) — a assinatura é ativada automaticamente após a confirmação."
          : "Assinatura registrada. Acompanhe a cobrança no extrato abaixo.",
        paymentUrl: res?.paymentUrl ?? null,
      });
      billingRes.reload();
    } catch (e) {
      setMensagemAssinatura({
        tipo: "erro",
        texto: e.body?.message || e.message || "Não foi possível gerar a cobrança da assinatura.",
      });
    }
  }

  async function onComprar(valorCents) {
    setMensagemCompra(null);
    try {
      const res = await comprar.run(valorCents, cpfInput.trim() || undefined);
      // buyCredits só CRIA a cobrança (Pix/boleto/cartão) no Asaas; a carteira
      // só é creditada quando o pagamento é confirmado (webhook). Antes o painel
      // dizia "Créditos adicionados com sucesso" na hora — o que era falso (o
      // saldo não mudava e não havia link para pagar). Agora abrimos o link de
      // pagamento e deixamos claro que o crédito entra após a confirmação.
      if (res?.paymentUrl) window.open(res.paymentUrl, "_blank", "noopener,noreferrer");
      setMensagemCompra({
        tipo: "sucesso",
        texto: res?.paymentUrl
          ? "Cobrança gerada. Abra o link para pagar — o crédito entra na carteira após a confirmação do pagamento."
          : "Cobrança criada. Acompanhe o pagamento no extrato abaixo.",
        paymentUrl: res?.paymentUrl ?? null,
      });
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
          className="rounded-xl border border-zinc-200 px-3.5 py-2.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800 sm:py-2"
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
  const precoCents = sub?.priceCents ?? 14900;
  // cobrança de assinatura já emitida e ainda não paga — evita gerar outra
  const cobrancaAssinaturaPendente = (billingRes.data?.pendingPayments ?? [])
    .find((p) => p.kind === "subscription" && p.paymentUrl) ?? null;

  // Derivações compartilhadas pelas duas visões do extrato (cards no mobile / tabela no desktop)
  const linhasPagamento = pagamentos.map((p) => ({
    p,
    pst: PAGAMENTO_STATUS[p.status] ?? PAGAMENTO_STATUS.pending,
    quando: p.paidAt ?? p.dueAt ?? p.createdAt,
    extraCredito:
      p.kind === "credit_topup" && p.creditedCents != null ? formatBRL(p.creditedCents) : null,
  }));

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* Assinatura */}
      <Card className="p-4 sm:p-6 lg:col-span-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wide text-zinc-400">Assinatura Zaplane</div>
            <div className="mt-1 break-words text-xl font-semibold tabular-nums text-zinc-900 dark:text-white">{formatBRL(precoCents)}/mês</div>
            <div className="text-[13px] text-zinc-500 dark:text-zinc-400">
              Libera criação de campanhas e envio de mensagens (template/avulso).
            </div>
          </div>
          <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${st.cls}`}>
            {st.label}
          </span>
        </div>

        {status === "active" && sub?.currentPeriodEnd && (
          <div className="mt-5 block rounded-xl bg-zinc-50 p-4 dark:bg-zinc-800/40 sm:inline-block">
            <div className="text-[11px] text-zinc-400">Próximo vencimento</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums text-zinc-900 dark:text-white">
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
          <div className="mt-5 flex flex-col gap-3">
            {/* CPF/CNPJ é exigido pelo Asaas para emitir a cobrança */}
            <div>
              <label className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                CPF/CNPJ do responsável pela cobrança
              </label>
              <input
                value={cpfInput}
                onChange={(e) => setCpfInput(e.target.value)}
                inputMode="numeric"
                placeholder="Somente números"
                className="mt-1 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-base outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 sm:max-w-xs sm:py-2 sm:text-sm"
              />
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <PrimaryBtn className="w-full sm:w-auto" onClick={onAssinar} disabled={assinar.pending}>
                <CreditCard className="h-4 w-4" />
                {assinar.pending ? "Gerando cobrança…" : `Assinar por ${formatBRL(precoCents)}/mês`}
              </PrimaryBtn>

              {/* se já existe cobrança em aberto, o caminho é pagar essa */}
              {cobrancaAssinaturaPendente?.paymentUrl && (
                <a
                  href={cobrancaAssinaturaPendente.paymentUrl}
                  target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-zinc-200 px-3.5 py-2.5 text-[13px] font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800 sm:py-2"
                >
                  Abrir cobrança em aberto
                </a>
              )}
            </div>

            <p className="inline-flex items-start gap-1.5 text-[12px] text-zinc-500 dark:text-zinc-400">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Pague por Pix, boleto ou cartão. A assinatura é ativada sozinha assim que o pagamento
              é confirmado — o Pix costuma cair em minutos.
            </p>

            {mensagemAssinatura && (
              <div className={`text-[12px] ${mensagemAssinatura.tipo === "erro" ? "text-red-700 dark:text-red-300" : "text-emerald-700 dark:text-emerald-300"}`}>
                <p className="inline-flex items-start gap-1.5">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {mensagemAssinatura.texto}
                </p>
                {mensagemAssinatura.paymentUrl && (
                  <a
                    href={mensagemAssinatura.paymentUrl}
                    target="_blank" rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-semibold text-white hover:opacity-90"
                    style={{ backgroundColor: "#0F8C5A" }}
                  >
                    <CreditCard className="h-3.5 w-3.5" /> Abrir cobrança para pagar
                  </a>
                )}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Créditos (carteira) */}
      <Card className="p-4 sm:p-6">
        <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-white">
          <Wallet className="h-4 w-4 shrink-0" /> Créditos (carteira)
        </h2>
        <div className="mt-3 rounded-xl bg-zinc-50 p-4 dark:bg-zinc-800/40">
          <div className="text-[11px] text-zinc-400">Saldo disponível</div>
          <div className="mt-0.5 break-words text-2xl font-semibold tabular-nums text-zinc-900 dark:text-white">
            {formatBRL(wallet.balanceCents)}
          </div>
        </div>

        <div className="mt-3">
          <label className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
            CPF/CNPJ do responsável pela cobrança
          </label>
          <input
            value={cpfInput}
            onChange={(e) => setCpfInput(e.target.value)}
            inputMode="numeric"
            placeholder="Somente números"
            className="mt-1 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-base outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 sm:py-2 sm:text-sm"
          />
          <p className="mt-1 text-[11px] leading-snug text-zinc-400">
            Obrigatório para emitir a cobrança (Asaas). Usado só na emissão.
          </p>
        </div>

        <button
          onClick={() => { setSeletorAberto((v) => !v); setMensagemCompra(null); }}
          className="mt-3 w-full rounded-xl border border-zinc-200 py-2.5 text-[13px] font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800 sm:py-2"
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
                className="rounded-lg border border-zinc-200 px-1 py-2.5 text-[12px] font-medium tabular-nums text-zinc-700 transition-colors hover:border-[#0F8C5A] hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-emerald-500/10 sm:py-2 sm:text-[13px]"
              >
                {formatBRL(v)}
              </button>
            ))}
          </div>
        )}

        {mensagemCompra && (
          <div className={`mt-3 text-[12px] ${mensagemCompra.tipo === "sucesso" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}>
            <p className="inline-flex items-start gap-1.5">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {mensagemCompra.texto}
            </p>
            {mensagemCompra.paymentUrl && (
              <a
                href={mensagemCompra.paymentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-semibold text-white hover:opacity-90"
                style={{ backgroundColor: "#0F8C5A" }}
              >
                <CreditCard className="h-3.5 w-3.5" /> Abrir cobrança para pagar
              </a>
            )}
          </div>
        )}

        <p className="mt-3 inline-flex items-start gap-1.5 text-[11px] text-zinc-400">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Cada mensagem de template entregue pela Meta debita R$ 0,43 da carteira.
        </p>
      </Card>

      {/* Extrato/pagamentos */}
      <Card className="overflow-hidden lg:col-span-3">
        <div className="flex items-center gap-1.5 px-4 py-4 sm:px-5">
          <Receipt className="h-4 w-4 shrink-0 text-zinc-400" />
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Extrato de pagamentos</h2>
        </div>
        {linhasPagamento.length === 0 ? (
          <div className="px-4 pb-9 pt-1 text-center text-[13px] text-zinc-400 sm:px-5">
            Nenhuma movimentação ainda.
          </div>
        ) : (
          <>
            {/* Mobile: lista de cards */}
            <ul className="border-t border-zinc-100 lg:hidden dark:border-zinc-800">
              {linhasPagamento.map(({ p, pst, quando, extraCredito }) => (
                <li key={p.id} className="border-b border-zinc-100 px-4 py-3 last:border-0 dark:border-zinc-800/60">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
                        {PAGAMENTO_KIND[p.kind] ?? p.kind}
                      </div>
                      <div className="mt-0.5 break-words text-[13px] tabular-nums text-zinc-600 dark:text-zinc-300">
                        {formatBRL(p.amountCents)}
                        {extraCredito && (
                          <span className="ml-1 text-[11px] text-zinc-400">(creditou {extraCredito})</span>
                        )}
                      </div>
                    </div>
                    <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${pst.cls}`}>
                      {pst.label}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-zinc-400">
                    <span className="truncate">{p.method ?? "—"}</span>
                    <span className="tabular-nums">
                      {quando ? new Date(quando).toLocaleDateString("pt-BR") : "—"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>

            {/* Desktop: tabela */}
            <div className="hidden overflow-x-auto lg:block">
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
                  {linhasPagamento.map(({ p, pst, quando, extraCredito }) => (
                    <tr key={p.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                      <td className="px-5 py-3 font-medium text-zinc-800 dark:text-zinc-100">
                        {PAGAMENTO_KIND[p.kind] ?? p.kind}
                      </td>
                      <td className="px-3 py-3 tabular-nums text-zinc-600 dark:text-zinc-300">
                        {formatBRL(p.amountCents)}
                        {extraCredito && (
                          <span className="ml-1 text-[11px] text-zinc-400">
                            (creditou {extraCredito})
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
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

/* ----------------------------- Equipe (dados reais) ----------------------------- */
/* Pedaços reusados pela lista de equipe (cards no mobile + tabela no desktop) */
function AvatarMembro({ nome, email }) {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
      {iniciaisDe(nome, email)}
    </div>
  );
}

function PapelBadge({ papel }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${ROLE_CLS[papel] ?? ROLE_CLS.viewer}`}>
      {ROLE_LABEL[papel] ?? papel}
    </span>
  );
}

// "há 3 dias" / "hoje" — para a coluna de último acesso
function quandoRelativo(iso) {
  if (!iso) return "nunca";
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (dias <= 0) return "hoje";
  if (dias === 1) return "ontem";
  if (dias < 30) return `há ${dias} dias`;
  return new Date(iso).toLocaleDateString("pt-BR");
}

function AbaEquipe() {
  const membrosRes = useResource(listMembers, []);
  const membros = membrosRes.data?.items ?? [];

  if (membrosRes.loading) {
    return (
      <div className="flex items-center justify-center py-16 text-[13px] text-zinc-400">
        Carregando equipe…
      </div>
    );
  }
  if (membrosRes.error) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <div className="rounded-lg bg-red-50 px-4 py-3 text-[13px] text-red-700 dark:bg-red-500/10 dark:text-red-300">
          Falha ao carregar a equipe: {membrosRes.error.message || String(membrosRes.error)}
        </div>
        <button
          onClick={membrosRes.reload}
          className="rounded-xl border border-zinc-200 px-3.5 py-2.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800 sm:py-2"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-1 px-4 py-4 sm:px-5">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">
          Membros da equipe <span className="font-normal text-zinc-400">({membros.length})</span>
        </h2>
        <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
          Convite por e-mail ainda não está disponível. Para adicionar alguém à sua organização,
          fale com o suporte do Zaplane.
        </p>
      </div>

      {/* Mobile: lista de cards */}
      <ul className="border-t border-zinc-100 lg:hidden dark:border-zinc-800">
        {membros.map((m) => (
          <li key={m.id} className="flex items-start gap-3 border-b border-zinc-100 px-4 py-3.5 last:border-0 dark:border-zinc-800/60">
            <AvatarMembro nome={m.name} email={m.email} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">{m.name || m.email}</span>
                <PapelBadge papel={m.role} />
              </div>
              <div className="truncate text-[12px] text-zinc-400">{m.email}</div>
              <div className="mt-1 text-[12px] leading-snug text-zinc-500 dark:text-zinc-400">{ROLE_DESC[m.role] ?? ""}</div>
              <div className="mt-1 text-[11px] text-zinc-400">Último acesso: {quandoRelativo(m.lastLoginAt)}</div>
            </div>
          </li>
        ))}
      </ul>

      {/* Desktop: tabela */}
      <table className="hidden w-full text-sm lg:table">
        <thead>
          <tr className="border-y border-zinc-100 bg-zinc-50/60 text-left text-[11px] uppercase tracking-wide text-zinc-400 dark:border-zinc-800 dark:bg-zinc-800/40">
            <th className="px-5 py-2.5 font-medium">Membro</th>
            <th className="px-3 py-2.5 font-medium">Papel</th>
            <th className="px-3 py-2.5 font-medium">Permissões</th>
            <th className="px-5 py-2.5 font-medium">Último acesso</th>
          </tr>
        </thead>
        <tbody>
          {membros.map((m) => (
            <tr key={m.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
              <td className="px-5 py-3">
                <div className="flex items-center gap-3">
                  <AvatarMembro nome={m.name} email={m.email} />
                  <div className="min-w-0">
                    <div className="truncate font-medium text-zinc-800 dark:text-zinc-100">{m.name || m.email}</div>
                    <div className="truncate text-[12px] text-zinc-400">{m.email}</div>
                  </div>
                </div>
              </td>
              <td className="px-3 py-3"><PapelBadge papel={m.role} /></td>
              <td className="px-3 py-3 text-[12px] text-zinc-500 dark:text-zinc-400">{ROLE_DESC[m.role] ?? ""}</td>
              <td className="px-5 py-3 text-[12px] text-zinc-400">{quandoRelativo(m.lastLoginAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

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
        className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 px-3.5 py-2.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800 sm:py-2"
      >
        <Plus className="h-4 w-4" /> Conectar manualmente
      </button>
    </div>
  );

  return (
    <div className="space-y-4 p-4 sm:space-y-5 sm:p-6 lg:p-7">
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex w-max min-w-full items-center gap-1 rounded-xl border border-zinc-200 bg-white p-1 dark:border-zinc-800 dark:bg-zinc-900 sm:w-fit sm:min-w-0">
        {tabs.map((t) => {
          const I = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2.5 text-[13px] font-medium transition-colors sm:px-3.5 sm:py-1.5 ${
                tab === t.id
                  ? "bg-emerald-50 text-[#0F8C5A] dark:bg-emerald-500/10 dark:text-emerald-300"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
              }`}
            >
              <I className="h-4 w-4 shrink-0" /> {t.label}
            </button>
          );
        })}
        </div>
      </div>

      {tab === "meta" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
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
                className="rounded-xl border border-zinc-200 px-3.5 py-2.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800 sm:py-2"
              >
                Tentar novamente
              </button>
            </div>
          )}

          {!canaisRes.loading && !canaisRes.error && (
            canais.length === 0 ? (
              <Card className="flex flex-col items-center gap-4 p-6 text-center sm:p-10">
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
                    <Card key={c.id} className="flex flex-col gap-3 p-4 sm:p-5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="break-all text-[13px] font-semibold tabular-nums text-zinc-900 dark:text-white">
                            {c.displayNumber || c.phoneNumberId}
                          </div>
                          <div className="truncate text-[12px] text-zinc-400">{c.label}</div>
                        </div>
                        <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${st.cls}`}>
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
                        <div className="min-w-0">
                          Phone Number ID
                          <div className="break-all tabular-nums text-zinc-600 dark:text-zinc-300">{c.phoneNumberId}</div>
                        </div>
                        <div className="min-w-0">
                          WABA ID
                          <div className="break-all tabular-nums text-zinc-600 dark:text-zinc-300">{c.wabaId}</div>
                        </div>
                      </div>

                      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                        <span className="text-[11px] text-zinc-400">
                          {c.createdAt ? `Conectado em ${new Date(c.createdAt).toLocaleDateString("pt-BR")}` : ""}
                        </span>
                        <button
                          onClick={() => onDesconectar(c.id)}
                          disabled={c.status === "disabled" || desconectar.pending}
                          className="-my-1.5 inline-flex shrink-0 items-center gap-1.5 py-1.5 text-[12px] font-medium text-red-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline dark:text-red-400 sm:my-0 sm:py-0"
                        >
                          <Trash2 className="h-3.5 w-3.5 shrink-0" /> Desconectar
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

      {tab === "equipe" && <AbaEquipe />}

      {tab === "billing" && <AbaBilling />}
    </div>
  );
}

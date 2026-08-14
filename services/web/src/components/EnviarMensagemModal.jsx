import React, { useEffect, useMemo, useRef, useState } from "react";
import { X, LayoutTemplate, MessageSquare, Info, CheckCircle2 } from "lucide-react";
import { WhatsAppBubble } from "./ui.jsx";
import { useResource, useMutation } from "../hooks/useResource.js";
import { toUiTemplate } from "../api/adapters.js";
import { getWindows, listTemplates, sendSingle, sendText } from "../api/endpoints.js";
import { extrairVariaveis, preencherCorpo } from "../utils/template.js";
import { mensagemErro } from "../utils/erros.js";

const soDigitos = (v) => String(v ?? "").replace(/\D/g, "");

// countdown "expira em Xh Ym" a partir de windowExpiresAt
function expiraEm(iso) {
  if (!iso) return "";
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "expirada";
  const totalMin = Math.floor(diffMs / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `expira em ${h}h ${m}m`;
}

/**
 * Mensagem avulsa para 1 contato (fora de campanha).
 * Modo "Template" (padrão): funciona a qualquer hora — a Meta só permite
 * iniciar conversa com template aprovado. Modo "Texto livre": entregue apenas
 * dentro da janela de 24h (depois que o contato escreveu para o número).
 */
export default function EnviarMensagemModal({ contato, onClose }) {
  const [modo, setModo] = useState("template"); // "template" | "texto"
  const [templateId, setTemplateId] = useState("");
  const [valores, setValores] = useState({});
  const [texto, setTexto] = useState("");
  const [feito, setFeito] = useState(null);
  const [erro, setErro] = useState(null);

  const tplRes = useResource(() => listTemplates(), []);
  const aprovados = useMemo(
    () => (tplRes.data ?? []).map(toUiTemplate).filter((t) => t.status === "aprovado"),
    [tplRes.data],
  );

  // janela de 24h do contato — pré-seleciona "texto livre" quando ela está aberta
  const winRes = useResource(() => getWindows(), []);
  const janela = useMemo(() => {
    if (!winRes.data) return null; // ainda carregando
    const alvo = soDigitos(contato.tel);
    const item = (winRes.data.items ?? []).find((w) => soDigitos(w.phone) === alvo);
    const aberta = !!item?.windowExpiresAt && new Date(item.windowExpiresAt) > new Date();
    return { aberta, expiresAt: item?.windowExpiresAt ?? null };
  }, [winRes.data, contato.tel]);

  // aplica o modo padrão UMA vez, quando a janela chega — e NUNCA depois de um
  // clique explícito do usuário nas abas (mesmo que o fetch resolva depois)
  const modoInicialAplicado = useRef(false);
  const usuarioEscolheu = useRef(false);
  useEffect(() => {
    if (modoInicialAplicado.current || usuarioEscolheu.current || !janela) return;
    modoInicialAplicado.current = true;
    if (janela.aberta) setModo("texto");
  }, [janela]);

  const tpl = aprovados.find((t) => t.id === templateId) ?? aprovados[0] ?? null;
  const variaveis = useMemo(() => (tpl ? extrairVariaveis(tpl.corpo) : []), [tpl]);
  const todasPreenchidas = variaveis.every((n) => (valores[n] ?? "").trim() !== "");
  const corpoPrevia = tpl ? preencherCorpo(tpl.corpo, variaveis, valores) : "";

  const envio = useMutation(async () => {
    if (modo === "template") {
      const params = {};
      for (const n of variaveis) params[String(n)] = (valores[n] ?? "").trim();
      return sendSingle({ templateId: tpl.id, phone: contato.tel, params });
    }
    return sendText({ phone: contato.tel, text: texto.trim() });
  });

  async function enviar() {
    setErro(null);
    setFeito(null);
    try {
      await envio.run();
      setFeito(
        modo === "template"
          ? "Mensagem enfileirada — o envio acontece em segundos."
          : "Mensagem enfileirada. Ela só será entregue se o contato falou com você nas últimas 24h.",
      );
    } catch (e) {
      // Saldo (402), cota diária de destinatários (403), rate limit (429) e
      // afins — traduzidos num lugar só, em utils/erros.js.
      setErro(mensagemErro(e, "Falha ao enviar."));
    }
  }

  const podeEnviar =
    !envio.pending &&
    (modo === "template" ? !!tpl && todasPreenchidas : texto.trim().length > 0);

  const abas = [
    { id: "template", label: "Template", icon: LayoutTemplate, hint: "funciona sempre" },
    { id: "texto", label: "Texto livre", icon: MessageSquare, hint: "janela 24h" },
  ];

  // mesmo chip renderizado em dois pontos do header (abaixo do título no mobile,
  // ao lado do "X" no desktop) — sem duplicar a marcação
  const chipJanela = janela ? (
    <span
      title={janela.aberta ? expiraEm(janela.expiresAt) : "Janela de 24h fechada"}
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${
        janela.aberta
          ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300"
          : "bg-zinc-100 text-zinc-500 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-400"
      }`}
    >
      {janela.aberta ? `🟢 janela aberta — ${expiraEm(janela.expiresAt)}` : "⚪ janela fechada — use template"}
    </span>
  ) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-zinc-900/40 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div className="flex max-h-[92vh] w-full flex-col rounded-t-2xl border border-zinc-200 bg-white shadow-2xl sm:max-w-2xl sm:rounded-2xl dark:border-zinc-800 dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-100 px-4 py-4 sm:items-center sm:px-6 dark:border-zinc-800">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-white">Enviar mensagem</h3>
            <p className="text-[13px] text-zinc-500 break-words dark:text-zinc-400">
              Para <span className="font-medium text-zinc-700 dark:text-zinc-200">{contato.nome}</span>
              {" "}<span className="tabular-nums">{contato.tel}</span>
            </p>
            {chipJanela && <div className="mt-2 sm:hidden">{chipJanela}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <div className="hidden sm:block">{chipJanela}</div>
            <button onClick={onClose} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 sm:h-8 sm:w-8 dark:hover:bg-zinc-800">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
          {/* abas de modo */}
          <div className="flex w-full items-center gap-1 rounded-xl border border-zinc-200 bg-zinc-50 p-1 sm:w-fit dark:border-zinc-800 dark:bg-zinc-800/40">
            {abas.map((a) => {
              const I = a.icon;
              const ativa = modo === a.id;
              return (
                <button key={a.id} onClick={() => { usuarioEscolheu.current = true; setModo(a.id); setErro(null); setFeito(null); }}
                  className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-colors sm:flex-none sm:justify-start sm:py-1.5 ${
                    ativa ? "bg-white text-[#0F8C5A] shadow-sm dark:bg-zinc-900 dark:text-emerald-300" : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"}`}>
                  <I className="h-4 w-4 shrink-0" /> {a.label}
                  <span className="hidden text-[10px] font-normal text-zinc-400 sm:inline">({a.hint})</span>
                </button>
              );
            })}
          </div>

          {modo === "template" && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="min-w-0 space-y-3">
                {tplRes.loading && <div className="text-[13px] text-zinc-400">Carregando templates…</div>}
                {!tplRes.loading && aprovados.length === 0 && (
                  <div className="rounded-xl bg-amber-50 p-3 text-[12px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                    Nenhum template aprovado. Crie um na tela Templates e aguarde a aprovação da Meta.
                  </div>
                )}
                {aprovados.length > 0 && (
                  <div>
                    <label className="mb-1 block text-[12px] font-medium text-zinc-600 dark:text-zinc-300">Template aprovado</label>
                    <select
                      value={tpl?.id ?? ""}
                      onChange={(e) => { setTemplateId(e.target.value); setValores({}); }}
                      className="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-base sm:h-auto sm:text-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                    >
                      {aprovados.map((t) => <option key={t.id} value={t.id}>{t.nome} · {t.categoria}</option>)}
                    </select>
                  </div>
                )}
                {variaveis.map((n) => (
                  <div key={n}>
                    <label className="mb-1 block text-[11px] text-zinc-400">Variável <span className="font-mono">{`{{${n}}}`}</span></label>
                    <input
                      value={valores[n] ?? ""}
                      onChange={(e) => setValores((v) => ({ ...v, [n]: e.target.value }))}
                      placeholder="Digite o valor…"
                      className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-base outline-none focus:border-[#0F8C5A] sm:px-2.5 sm:py-1.5 sm:text-[13px] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    />
                  </div>
                ))}
              </div>
              {tpl && (
                <div className="min-w-0">
                  <div className="mb-2 text-[12px] font-medium text-zinc-500 dark:text-zinc-400">Prévia</div>
                  <WhatsAppBubble corpo={corpoPrevia} botoes={tpl.botoes} />
                </div>
              )}
            </div>
          )}

          {modo === "texto" && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-[12px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                Texto livre só é entregue dentro da <strong>janela de 24h</strong> — ou seja, se{" "}
                {contato.nome} mandou mensagem para o seu número nas últimas 24 horas. Fora disso,
                use o modo Template.
              </div>
              <textarea
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                rows={4}
                placeholder="Escreva sua mensagem…"
                className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-base outline-none focus:border-[#0F8C5A] sm:py-2 sm:text-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </div>
          )}

          {erro && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:bg-red-500/10 dark:text-red-300">{erro}</div>
          )}
          {feito && (
            <div className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {feito}
            </div>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-zinc-100 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4 dark:border-zinc-800">
          <button onClick={onClose} className="flex-1 rounded-xl border border-zinc-200 px-3.5 py-2.5 text-sm font-medium text-zinc-600 sm:flex-none sm:py-2 dark:border-zinc-800 dark:text-zinc-300">
            Fechar
          </button>
          <button
            onClick={enviar}
            disabled={!podeEnviar}
            className="flex-1 rounded-xl px-3.5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60 sm:flex-none sm:py-2"
            style={{ backgroundColor: "#0F8C5A" }}
          >
            {envio.pending ? "Enviando…" : "Enviar"}
          </button>
        </div>
      </div>
    </div>
  );
}

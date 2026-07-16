import React, { useState } from "react";
import { X, ChevronDown, Info, CheckCircle2, XCircle } from "lucide-react";
import { connectChannelManual } from "../api/endpoints.js";

// Rótulo pt-BR de cada etapa do pipeline (services/api-gateway/src/channels/channels.service.ts)
const PASSO_LABEL = {
  validar_token: "Validar token de acesso",
  conferir_waba: "Conferir acesso à WABA",
  conferir_numero: "Conferir número de telefone",
  configurar_webhook: "Configurar webhook do app",
  inscrever_app: "Inscrever app na WABA",
  salvar_canal: "Salvar canal",
  sincronizar_templates: "Sincronizar templates",
};

const CAMPOS = [
  { key: "label", label: "Nome do canal", placeholder: "Ex.: WhatsApp Comercial", type: "text", full: true },
  { key: "phoneNumberId", label: "Phone Number ID", placeholder: "Ex.: 109523847710042", type: "text" },
  { key: "wabaId", label: "WABA ID (WhatsApp Business Account)", placeholder: "Ex.: 204417752298813", type: "text" },
  { key: "accessToken", label: "Token de acesso (System User)", placeholder: "EAAG...", type: "password", full: true },
  { key: "appId", label: "App ID", placeholder: "Ex.: 1014019114699465", type: "text" },
  { key: "appSecret", label: "App Secret", placeholder: "Cole o segredo do app", type: "password" },
];

const CAMPOS_VAZIOS = { label: "", phoneNumberId: "", wabaId: "", accessToken: "", appId: "", appSecret: "" };

/**
 * Modal "Conectar manualmente" — cola credenciais da Meta (concierge). Ao enviar, o
 * backend roda um pipeline de validação passo a passo (token → WABA → número →
 * webhook → inscrição → grava canal → sincroniza templates) e devolve `etapas[]`
 * mesmo em caso de erro, para mostrarmos exatamente onde falhou.
 */
export default function ConectarManualModal({ onClose, onConnected }) {
  const [form, setForm] = useState(CAMPOS_VAZIOS);
  const [guiaAberta, setGuiaAberta] = useState(false);
  const [etapas, setEtapas] = useState([]);
  const [erro, setErro] = useState(null);
  const [pending, setPending] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const preenchido = Object.values(form).every((v) => v.trim() !== "");

  async function submit() {
    setErro(null);
    setEtapas([]);
    setPending(true);
    try {
      const dto = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim()]));
      const r = await connectChannelManual(dto);
      setEtapas(r?.etapas ?? []);
      onConnected();
      onClose();
    } catch (e) {
      setEtapas(e.body?.etapas ?? []);
      setErro(e.body?.message || e.message || "Falha ao conectar o canal.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-6 py-4 dark:border-zinc-800">
          <div>
            <h3 className="text-base font-semibold text-zinc-900 dark:text-white">Conectar manualmente</h3>
            <p className="text-[13px] text-zinc-500 dark:text-zinc-400">Cole as credenciais geradas no Meta Business Suite / for Developers.</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          {/* Guia colapsável */}
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800">
            <button
              onClick={() => setGuiaAberta((v) => !v)}
              className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[13px] font-medium text-zinc-600 dark:text-zinc-300"
            >
              <Info className="h-4 w-4 shrink-0 text-sky-500" />
              Onde encontro esses valores?
              <ChevronDown className={`ml-auto h-4 w-4 shrink-0 transition-transform ${guiaAberta ? "rotate-180" : ""}`} />
            </button>
            {guiaAberta && (
              <div className="space-y-2 border-t border-zinc-100 px-3.5 py-3 text-[12px] leading-relaxed text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <p><strong className="text-zinc-700 dark:text-zinc-200">Phone Number ID e WABA ID:</strong> no Meta for Developers, dentro do seu app → WhatsApp → Configuração da API (API Setup). Os dois números aparecem no topo da página.</p>
                <p><strong className="text-zinc-700 dark:text-zinc-200">Token de acesso:</strong> gere um token de <em>System User</em> permanente em Meta Business Suite → Configurações do negócio → Usuários do sistema, com os escopos <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">whatsapp_business_messaging</code> e <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">whatsapp_business_management</code>.</p>
                <p><strong className="text-zinc-700 dark:text-zinc-200">App ID e App Secret:</strong> Meta for Developers → seu app → Configurações → Básico.</p>
              </div>
            )}
          </div>

          {/* Campos */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {CAMPOS.map((c) => (
              <div key={c.key} className={c.full ? "sm:col-span-2" : ""}>
                <label className="mb-1 block text-[12px] font-medium text-zinc-600 dark:text-zinc-300">{c.label}</label>
                <input
                  type={c.type}
                  autoComplete="off"
                  value={form[c.key]}
                  onChange={set(c.key)}
                  placeholder={c.placeholder}
                  className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </div>
            ))}
          </div>

          {/* Progresso por etapa (sucesso parcial ou onde falhou) */}
          {etapas.length > 0 && (
            <div className="space-y-1.5 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              {etapas.map((et, i) => (
                <div key={i} className="flex items-start gap-2 text-[12px]">
                  {et.ok ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                  )}
                  <div>
                    <span className={et.ok ? "text-zinc-700 dark:text-zinc-200" : "font-medium text-red-700 dark:text-red-300"}>
                      {PASSO_LABEL[et.passo] ?? et.passo}
                    </span>
                    {et.detalhe && <span className="ml-1 text-zinc-400">— {et.detalhe}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {erro && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:bg-red-500/10 dark:text-red-300">{erro}</div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-100 px-6 py-4 dark:border-zinc-800">
          <button onClick={onClose} className="rounded-xl border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={!preenchido || pending}
            className="rounded-xl px-3.5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            style={{ backgroundColor: "#0F8C5A" }}
          >
            {pending ? "Conectando…" : "Conectar"}
          </button>
        </div>
      </div>
    </div>
  );
}

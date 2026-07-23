import React, { useMemo, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Card, TplStatusBadge, CategoryTag, WhatsAppBubble, PrimaryBtn } from "../components/ui.jsx";
import { useResource, useMutation } from "../hooks/useResource.js";
import { toUiTemplate } from "../api/adapters.js";
import { listTemplates, createTemplate, syncTemplates } from "../api/endpoints.js";

/* ----------------------------- Modal: Novo template ----------------------------- */
function NovoTemplateModal({ open, onClose, onCreated }) {
  const [form, setForm] = useState({ name: "", category: "MARKETING", body: "" });
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  if (!open) return null;

  async function submit() {
    setError(null);
    if (!/^[a-z0-9_]+$/.test(form.name)) {
      setError("Nome: use apenas minúsculas, dígitos e underscore (ex.: promo_banho).");
      return;
    }
    setPending(true);
    try {
      const r = await createTemplate({ name: form.name, category: form.category, body: form.body });
      if (r?.metaWarning) console.info("[templates]", r.metaWarning);
      onCreated();
      onClose();
    } catch (e) {
      setError(e.message || "Falha ao criar template.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-zinc-900/40 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900 sm:max-w-lg sm:rounded-2xl sm:p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-zinc-900 dark:text-white">Novo template</h3>
        <p className="mb-4 text-[13px] text-zinc-500 dark:text-zinc-400">Será enviado à Meta para aprovação quando o canal estiver configurado.</p>
        <div className="space-y-3">
          <input value={form.name} onChange={set("name")} placeholder="nome_do_template (minúsculas, _ )"
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 sm:py-2" />
          <select value={form.category} onChange={set("category")}
            className="h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 sm:h-auto sm:py-2">
            <option value="MARKETING">Marketing</option>
            <option value="UTILITY">Utility</option>
            <option value="AUTHENTICATION">Authentication</option>
          </select>
          <textarea value={form.body} onChange={set("body")} rows={4} placeholder="Corpo. Use {{1}}, {{2}} para variáveis."
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 sm:py-2" />
          {/* break-words é herdado pela bolha: impede que uma palavra/URL longa estoure no celular */}
          {form.body && <div className="min-w-0 break-words"><WhatsAppBubble corpo={form.body} botoes={[]} /></div>}
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="flex-1 rounded-xl border border-zinc-200 px-3.5 py-2.5 text-sm font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-300 sm:flex-none sm:py-2">Cancelar</button>
          <button onClick={submit} disabled={pending} className="flex-1 rounded-xl px-3.5 py-2.5 text-sm font-semibold text-white disabled:opacity-60 sm:flex-none sm:py-2" style={{ backgroundColor: "#0F8C5A" }}>
            {pending ? "Criando…" : "Criar template"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Templates (tela principal) ----------------------------- */
export default function Templates() {
  const [cat, setCat] = useState("Todas");
  const [modalOpen, setModalOpen] = useState(false);
  const [syncNote, setSyncNote] = useState(null);
  const { data, loading, error, reload } = useResource(() => listTemplates(), []);
  const templates = useMemo(() => (data ?? []).map(toUiTemplate), [data]);
  const filtrados = cat === "Todas" ? templates : templates.filter((t) => t.categoria === cat);

  const cats = ["Todas", "Marketing", "Utility", "Authentication"];

  // Sincroniza status/categoria com a Meta e recarrega a galeria
  const sync = useMutation(syncTemplates);
  async function onSync() {
    setSyncNote(null);
    try {
      const r = await sync.run();
      if (r?.synced) {
        setSyncNote(`Sincronizado com a Meta: ${r.total} template(s) — ${r.atualizados} atualizado(s), ${r.criados} novo(s).`);
        reload();
      } else {
        setSyncNote(r?.note || "Não foi possível sincronizar.");
      }
    } catch (e) {
      setSyncNote(e.message || "Falha ao sincronizar.");
    }
  }

  return (
    <div className="space-y-4 p-4 sm:space-y-5 sm:p-6 lg:p-7">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* No celular os filtros viram uma faixa rolável horizontal */}
        <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:overflow-visible sm:px-0 sm:pb-0">
          {cats.map((c) => (
            <button key={c} onClick={() => setCat(c)}
              className={`inline-flex h-10 shrink-0 items-center whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium transition-colors sm:h-auto sm:py-1.5 ${cat === c ? "text-white" : "border border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
              style={cat === c ? { backgroundColor: "#0F8C5A" } : undefined}>{c}</button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onSync}
            disabled={sync.pending}
            title="Puxar status e categoria dos templates direto da Meta"
            className="inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-zinc-200 px-3.5 py-2.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800 sm:flex-none sm:py-2"
          >
            <RefreshCw className={`h-4 w-4 shrink-0 ${sync.pending ? "animate-spin" : ""}`} />
            {sync.pending ? "Sincronizando…" : "Sincronizar"}
          </button>
          <PrimaryBtn onClick={() => setModalOpen(true)} className="flex-1 whitespace-nowrap sm:flex-none"><Plus className="h-4 w-4 shrink-0" /> Novo template</PrimaryBtn>
        </div>
      </div>

      {syncNote && (
        <div className="break-words rounded-xl bg-zinc-100 px-4 py-2.5 text-[13px] text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300 sm:py-2">
          {syncNote}
        </div>
      )}

      {/* Estado de carregamento */}
      {loading && (
        <div className="flex items-center justify-center py-16 text-[13px] text-zinc-400">
          Carregando templates…
        </div>
      )}

      {/* Estado de erro */}
      {error && !loading && (
        <div className="flex flex-col items-center gap-3 py-16">
          <div className="max-w-full break-words rounded-lg bg-red-50 px-4 py-3 text-center text-[13px] text-red-700 dark:bg-red-500/10 dark:text-red-300 sm:text-left">
            Falha ao carregar templates: {error.message || String(error)}
          </div>
          <button onClick={reload} className="rounded-xl border border-zinc-200 px-3.5 py-2.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800 sm:py-2">
            Tentar novamente
          </button>
        </div>
      )}

      {/* Grid de templates */}
      {!loading && !error && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtrados.length === 0 ? (
            <div className="col-span-full py-16 text-center text-[13px] text-zinc-400">
              Nenhum template encontrado{cat !== "Todas" ? ` na categoria "${cat}"` : ""}.
            </div>
          ) : (
            filtrados.map((t) => (
              <Card key={t.id} className="flex min-w-0 flex-col overflow-hidden">
                <div className="flex items-start justify-between gap-2 p-4 pb-3">
                  <div className="min-w-0">
                    <div className="break-words text-[13px] font-semibold text-zinc-900 dark:text-white">{t.nome}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5"><CategoryTag cat={t.categoria} /><span className="text-[11px] text-zinc-400">{t.idioma}</span></div>
                  </div>
                  <div className="shrink-0"><TplStatusBadge status={t.status} /></div>
                </div>
                {/* break-words é herdado pela bolha: nomes/URLs longos não estouram a largura */}
                <div className="min-w-0 break-words px-4 pb-4"><WhatsAppBubble corpo={t.corpo} botoes={t.botoes} /></div>
              </Card>
            ))
          )}
        </div>
      )}

      <NovoTemplateModal open={modalOpen} onClose={() => setModalOpen(false)} onCreated={reload} />
    </div>
  );
}

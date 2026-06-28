import React, { useMemo, useRef, useState } from "react";
import {
  Search, Filter, Upload, MessageSquare, Edit2, Trash2,
  ChevronDown, X, ShieldCheck, Check, FileSpreadsheet, FileJson, Info,
} from "lucide-react";
import { Card, ConsentChip, PrimaryBtn } from "../components/ui.jsx";
import { useResource, useMutation } from "../hooks/useResource.js";
import { toUiContact } from "../api/adapters.js";
import {
  listContacts, updateContact, removeContact, optOutContact, importContacts,
} from "../api/endpoints.js";

/* ----------------------------- EditContactModal ----------------------------- */
function EditContactModal({ contato, onClose, onSaved }) {
  const [name, setName] = useState(contato?.nome ?? "");
  const [tags, setTags] = useState((contato?.tags ?? []).join(", "));
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  if (!contato) return null;

  async function save() {
    setError(null);
    setPending(true);
    try {
      await updateContact(contato.id, {
        name,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e.message || "Falha ao salvar.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-base font-semibold text-zinc-900 dark:text-white">Editar contato</h3>
        <div className="space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nome"
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
          />
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="Tags (separadas por vírgula)"
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
          />
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:bg-red-500/10 dark:text-red-300">
              {error}
            </div>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-xl border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-300"
          >
            Cancelar
          </button>
          <button
            onClick={save}
            disabled={pending}
            className="rounded-xl px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60"
            style={{ backgroundColor: "#0F8C5A" }}
          >
            {pending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- ImportModal ----------------------------- */
export function ImportModal({ onClose, onImported }) {
  const [base, setBase] = useState("granted");          // consentStatus
  const [source, setSource] = useState("cadastro_loja"); // consentSource
  const fileRef = useRef(null);
  const imp = useMutation((file) => importContacts(file, base, source, "BR"));
  const [result, setResult] = useState(null);

  async function onSubmit() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    try {
      const r = await imp.run(file);
      setResult(r); // { imported, duplicates, invalid, total }
      if (onImported) onImported();
    } catch {
      /* erro já exibido via imp.error */
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        {/* cabeçalho */}
        <div className="flex items-center justify-between border-b border-zinc-100 px-6 py-4 dark:border-zinc-800">
          <div>
            <h3 className="text-base font-semibold text-zinc-900 dark:text-white">Importar contatos</h3>
            <p className="text-[13px] text-zinc-500 dark:text-zinc-400">Arquivos CSV, JSON ou XLSX até 20 MB</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 p-6">
          {/* área de upload */}
          <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-zinc-200 bg-zinc-50/60 px-6 py-9 text-center dark:border-zinc-700 dark:bg-zinc-800/30">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 text-[#0F8C5A] dark:bg-emerald-500/10 dark:text-emerald-300">
              <Upload className="h-6 w-6" />
            </div>
            <p className="mt-3 text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Arraste o arquivo aqui ou{" "}
              <label className="cursor-pointer text-[#0F8C5A] dark:text-emerald-300">
                selecione
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.json,.xlsx"
                  className="sr-only"
                />
              </label>
            </p>
            <div className="mt-3 flex items-center gap-2 text-[11px] text-zinc-400">
              <span className="inline-flex items-center gap-1"><FileSpreadsheet className="h-3.5 w-3.5" /> CSV</span>
              <span className="inline-flex items-center gap-1"><FileJson className="h-3.5 w-3.5" /> JSON</span>
              <span className="inline-flex items-center gap-1"><FileSpreadsheet className="h-3.5 w-3.5" /> XLSX</span>
            </div>
          </div>

          {/* resultado da importação */}
          {result && (
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl border border-emerald-200/60 bg-emerald-50/60 p-3 dark:border-emerald-500/20 dark:bg-emerald-500/5">
                <div className="text-lg font-semibold text-emerald-700 dark:text-emerald-300">{result.imported}</div>
                <div className="text-[11px] text-emerald-700/70 dark:text-emerald-300/70">importados</div>
              </div>
              <div className="rounded-xl border border-amber-200/60 bg-amber-50/60 p-3 dark:border-amber-500/20 dark:bg-amber-500/5">
                <div className="text-lg font-semibold text-amber-700 dark:text-amber-300">{result.duplicates}</div>
                <div className="text-[11px] text-amber-700/70 dark:text-amber-300/70">duplicados</div>
              </div>
              <div className="rounded-xl border border-red-200/60 bg-red-50/60 p-3 dark:border-red-500/20 dark:bg-red-500/5">
                <div className="text-lg font-semibold text-red-700 dark:text-red-300">{result.invalid}</div>
                <div className="text-[11px] text-red-700/70 dark:text-red-300/70">inválidos</div>
              </div>
            </div>
          )}

          {/* erro de importação */}
          {imp.error && (
            <div className="rounded-lg bg-red-50 px-4 py-3 text-[13px] text-red-700 dark:bg-red-500/10 dark:text-red-300">
              {imp.error.message || "Erro ao importar o arquivo."}
            </div>
          )}

          {/* base legal (consentStatus) */}
          <div>
            <label className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-zinc-700 dark:text-zinc-200">
              <ShieldCheck className="h-4 w-4 text-[#0F8C5A]" /> Base legal / consentimento (LGPD)
            </label>
            <div className="grid grid-cols-1 gap-2">
              {[
                { v: "granted",  t: "Consentimento explícito", d: "O titular autorizou o recebimento (opt-in)." },
                { v: "pending",  t: "Legítimo interesse",       d: "Relação comercial existente, com opt-out disponível." },
                { v: "unknown",  t: "Execução de contrato",     d: "Mensagens transacionais de um serviço contratado." },
              ].map((o) => (
                <label
                  key={o.v}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${base === o.v ? "border-[#0F8C5A] bg-emerald-50/50 dark:bg-emerald-500/5" : "border-zinc-200 dark:border-zinc-800"}`}
                >
                  <input
                    type="radio"
                    name="base"
                    checked={base === o.v}
                    onChange={() => setBase(o.v)}
                    className="mt-0.5 accent-[#0F8C5A]"
                  />
                  <div>
                    <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{o.t}</div>
                    <div className="text-[12px] text-zinc-500 dark:text-zinc-400">{o.d}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* fonte do consentimento */}
          <div>
            <label className="mb-2 block text-[13px] font-medium text-zinc-700 dark:text-zinc-200">
              Fonte do consentimento
            </label>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
            >
              <option value="cadastro_loja">Cadastro na loja</option>
              <option value="formulario_web">Formulário web</option>
              <option value="contrato">Contrato assinado</option>
              <option value="indicacao">Indicação</option>
              <option value="outro">Outro</option>
            </select>
          </div>
        </div>

        {/* rodapé */}
        <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-6 py-4 dark:border-zinc-800">
          <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400">
            <Info className="h-3.5 w-3.5" /> Inválidos e duplicados são ignorados na importação.
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-xl border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Cancelar
            </button>
            <PrimaryBtn onClick={onSubmit} disabled={imp.pending}>
              {imp.pending ? (
                "Importando…"
              ) : result ? (
                <><Check className="h-4 w-4" /> Concluído</>
              ) : (
                <><Upload className="h-4 w-4" /> Importar</>
              )}
            </PrimaryBtn>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Contatos ----------------------------- */
export default function Contatos({ openImport, reloadKey }) {
  const [q, setQ] = useState("");
  const [regiao, setRegiao] = useState("");
  const [tag, setTag] = useState("");
  const [consent, setConsent] = useState("");
  const [editing, setEditing] = useState(null);

  // busca e consent vão server-side; região/tag filtram client-side
  const query = {};
  if (q) query.search = q;
  if (consent) query.consent = { consentido: "granted", pendente: "pending", optout: "opted_out" }[consent];

  const { data, loading, error, reload } = useResource(
    () => listContacts({ ...query, pageSize: 200 }),
    [q, consent, reloadKey],
  );

  const contatos = useMemo(() => (data?.items ?? []).map(toUiContact), [data]);
  const regioes = [...new Set(contatos.map((c) => c.regiao).filter(Boolean))];
  const tags = [...new Set(contatos.map((c) => c.tag).filter(Boolean))];
  const filtrados = contatos.filter(
    (c) => (!regiao || c.regiao === regiao) && (!tag || c.tag === tag),
  );

  const del = useMutation(removeContact);
  const opt = useMutation(optOutContact);
  async function onRemove(id) { await del.run(id); reload(); }
  async function onOptOut(id) { await opt.run(id); reload(); }

  const sel = (v, set, opts, ph) => (
    <div className="relative">
      <select
        value={v}
        onChange={(e) => set(e.target.value)}
        className="appearance-none rounded-xl border border-zinc-200 bg-white py-2 pl-3 pr-8 text-sm text-zinc-600 outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
      >
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
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nome, telefone ou DDD…"
            className="w-full rounded-xl border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm outline-none placeholder:text-zinc-400 focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
          />
        </div>
        <div className="flex items-center gap-1.5 text-zinc-400"><Filter className="h-4 w-4" /></div>
        {sel(regiao, setRegiao, regioes, "Região / DDD")}
        {sel(tag, setTag, tags, "Tag")}
        {sel(consent, setConsent, ["consentido", "pendente", "optout"], "Consentimento")}
        <div className="ml-auto" />
        <PrimaryBtn onClick={openImport}><Upload className="h-4 w-4" /> Importar contatos</PrimaryBtn>
      </div>

      {/* estados de carregamento e erro */}
      {loading && (
        <div className="py-8 text-center text-sm text-zinc-400">Carregando contatos…</div>
      )}
      {error && !loading && (
        <div className="flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
          <span>{error.message || "Erro ao carregar contatos."}</span>
          <button onClick={reload} className="ml-4 rounded-lg border border-red-300 px-3 py-1 text-xs font-medium hover:bg-red-100 dark:border-red-500/30 dark:hover:bg-red-500/20">
            Tentar novamente
          </button>
        </div>
      )}

      {!loading && (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3 text-[13px] dark:border-zinc-800">
            <span className="text-zinc-500 dark:text-zinc-400">
              <span className="font-semibold text-zinc-700 dark:text-zinc-200">{filtrados.length}</span> contatos
            </span>
            <span className="inline-flex items-center gap-1.5 text-zinc-400">
              <ShieldCheck className="h-3.5 w-3.5 text-[#0F8C5A]" />
              Suprimidos por opt-out são ocultados de disparos automaticamente
            </span>
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
                  <tr
                    key={c.id}
                    className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/80 dark:border-zinc-800/60 dark:hover:bg-zinc-800/30"
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
                          {c.nome.split(" ").map((n) => n[0]).slice(0, 2).join("")}
                        </div>
                        <div>
                          <div className="font-medium text-zinc-800 dark:text-zinc-100">{c.nome}</div>
                          <div className="text-[12px] tabular-nums text-zinc-400">{c.tel}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-zinc-600 dark:text-zinc-300">
                      DDD {c.ddd} · <span className="text-zinc-400">{c.regiao}</span>
                    </td>
                    <td className="px-3 py-3">
                      <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        {c.tag}
                      </span>
                    </td>
                    <td className="px-3 py-3"><ConsentChip consent={c.consent} /></td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          title="Opt-out"
                          disabled={c.consent === "optout"}
                          onClick={() => onOptOut(c.id)}
                          className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-[#0F8C5A] disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-zinc-800"
                        >
                          <MessageSquare className="h-4 w-4" />
                        </button>
                        <button
                          title="Editar"
                          onClick={() => setEditing(c)}
                          className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                        <button
                          title="Remover"
                          onClick={() => onRemove(c.id)}
                          className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filtrados.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-5 py-12 text-center text-sm text-zinc-400">
                      Nenhum contato encontrado com esses filtros.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {editing && (
        <EditContactModal
          contato={editing}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}

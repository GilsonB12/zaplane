import React, { useMemo, useRef, useState } from "react";
import {
  Search, Filter, Upload, BellOff, Edit2, Trash2, MessageSquare,
  ChevronDown, X, ShieldCheck, Check, FileSpreadsheet, FileJson, Info,
} from "lucide-react";
import EnviarMensagemModal from "../components/EnviarMensagemModal.jsx";
import { Card, ConsentChip, PrimaryBtn } from "../components/ui.jsx";
import { useResource, useMutation } from "../hooks/useResource.js";
import { toUiContact } from "../api/adapters.js";
import {
  listContacts, updateContact, removeContact, optOutContact, importContacts, getWindows,
} from "../api/endpoints.js";

const soDigitos = (v) => String(v ?? "").replace(/\D/g, "");

// iniciais do avatar — reusado na lista de cards (mobile) e na tabela (desktop)
const iniciais = (nome) =>
  String(nome ?? "").split(" ").map((n) => n[0]).slice(0, 2).join("");

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
      className="fixed inset-0 z-50 flex items-end justify-center bg-zinc-900/40 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900 sm:max-w-sm sm:rounded-2xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-base font-semibold text-zinc-900 dark:text-white">Editar contato</h3>
        <div className="space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nome"
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-base outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 sm:py-2 sm:text-sm"
          />
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="Tags (separadas por vírgula)"
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-base outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 sm:py-2 sm:text-sm"
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
            className="flex-1 rounded-xl border border-zinc-200 px-3.5 py-2.5 text-sm font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-300 sm:flex-none sm:py-2"
          >
            Cancelar
          </button>
          <button
            onClick={save}
            disabled={pending}
            className="flex-1 rounded-xl px-3.5 py-2.5 text-sm font-semibold text-white disabled:opacity-60 sm:flex-none sm:py-2"
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
      className="fixed inset-0 z-50 flex items-end justify-center bg-zinc-900/40 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full flex-col rounded-t-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900 sm:max-w-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* cabeçalho */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-100 px-4 py-4 dark:border-zinc-800 sm:px-6">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-white">Importar contatos</h3>
            <p className="text-[13px] text-zinc-500 dark:text-zinc-400">Arquivos CSV, JSON ou XLSX até 20 MB</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Fechar"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 sm:h-8 sm:w-8"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-4 sm:p-6">
          {/* área de upload */}
          {/* no mobile a área inteira é o alvo de toque que abre o seletor de arquivo */}
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-zinc-200 bg-zinc-50/60 px-4 py-8 text-center dark:border-zinc-700 dark:bg-zinc-800/30 sm:px-6 sm:py-9">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 text-[#0F8C5A] dark:bg-emerald-500/10 dark:text-emerald-300">
              <Upload className="h-6 w-6" />
            </div>
            <p className="mt-3 text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Arraste o arquivo aqui ou{" "}
              <span className="text-[#0F8C5A] dark:text-emerald-300">selecione</span>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.json,.xlsx"
                className="sr-only"
              />
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-[11px] text-zinc-400">
              <span className="inline-flex items-center gap-1"><FileSpreadsheet className="h-3.5 w-3.5" /> CSV</span>
              <span className="inline-flex items-center gap-1"><FileJson className="h-3.5 w-3.5" /> JSON</span>
              <span className="inline-flex items-center gap-1"><FileSpreadsheet className="h-3.5 w-3.5" /> XLSX</span>
            </div>
          </label>

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
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[#0F8C5A]"
                  />
                  <div className="min-w-0">
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
              className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-base text-zinc-700 outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 sm:py-2 sm:text-sm"
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
        <div className="flex shrink-0 flex-col-reverse gap-3 border-t border-zinc-100 px-4 py-4 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span className="inline-flex items-start gap-1.5 text-[11px] text-zinc-400">
            <Info className="h-3.5 w-3.5 shrink-0" /> Inválidos e duplicados são ignorados na importação.
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 rounded-xl border border-zinc-200 px-3.5 py-2.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800 sm:flex-none sm:py-2"
            >
              Cancelar
            </button>
            <PrimaryBtn className="flex-1 sm:flex-none" onClick={onSubmit} disabled={imp.pending}>
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
  const [mensagemPara, setMensagemPara] = useState(null); // contato do modal de mensagem avulsa

  // busca e consent vão server-side; região/tag filtram client-side
  const query = {};
  if (q) query.search = q;
  if (consent) query.consent = { consentido: "granted", pendente: "pending", optout: "opted_out" }[consent];

  const { data, loading, error, reload } = useResource(
    () => listContacts({ ...query, pageSize: 200 }),
    [q, consent, reloadKey],
  );

  // janela de 24h por contato — badge 🟢 ao lado do telefone quando aberta
  const winRes = useResource(() => getWindows(), [reloadKey]);
  const janelaPorTelefone = useMemo(() => {
    const map = new Map();
    for (const w of winRes.data?.items ?? []) {
      if (w.windowExpiresAt && new Date(w.windowExpiresAt) > new Date()) {
        map.set(soDigitos(w.phone), w.windowExpiresAt);
      }
    }
    return map;
  }, [winRes.data]);

  const contatos = useMemo(() => (data?.items ?? []).map(toUiContact), [data]);
  const regioes = [...new Set(contatos.map((c) => c.regiao).filter(Boolean))];
  const tags = [...new Set(contatos.map((c) => c.tag).filter(Boolean))];
  const filtrados = contatos.filter(
    (c) => (!regiao || c.regiao === regiao) && (!tag || c.tag === tag),
  );

  const del = useMutation(removeContact);
  const opt = useMutation(optOutContact);
  async function onRemove(c) {
    const ok = window.confirm(`Remover ${c.nome} (${c.tel}) da base de contatos?`);
    if (!ok) return;
    await del.run(c.id);
    reload();
  }
  // opt-out é praticamente irreversível na prática (suprime o contato de
  // todos os disparos) — confirmar antes evita cliques acidentais
  async function onOptOut(c) {
    const ok = window.confirm(
      `Marcar ${c.nome} (${c.tel}) como OPT-OUT?\n\n` +
      "O contato será suprimido de todas as campanhas e disparos. " +
      "Use apenas quando a pessoa pediu para não receber mensagens.",
    );
    if (!ok) return;
    await opt.run(c.id);
    reload();
  }

  const sel = (v, set, opts, ph, cls = "") => (
    <div className={`relative w-full sm:w-auto ${cls}`}>
      <select
        value={v}
        onChange={(e) => set(e.target.value)}
        className="w-full appearance-none rounded-xl border border-zinc-200 bg-white py-2.5 pl-3 pr-8 text-base text-zinc-600 outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 sm:w-auto sm:py-2 sm:text-sm"
      >
        <option value="">{ph}</option>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
    </div>
  );

  // 🟢 janela de 24h aberta — reusado nos cards (mobile) e na tabela (desktop)
  const janelaBadge = (c) =>
    janelaPorTelefone.has(soDigitos(c.tel)) ? (
      <span
        className="text-[11px] leading-none"
        title={`Janela aberta — ${expiraEm(janelaPorTelefone.get(soDigitos(c.tel)))}`}
      >
        🟢
      </span>
    ) : null;

  // Ações por contato — `grande` usa alvos de 40px para o dedo (mobile);
  // no desktop mantém os botões compactos alinhados à direita da linha.
  const acoes = (c, grande = false) => {
    const box = grande
      ? "flex h-10 w-10 items-center justify-center rounded-lg"
      : "rounded-lg p-1.5";
    return (
      <div className={`flex items-center gap-1 ${grande ? "" : "justify-end"}`}>
        <button
          title="Enviar mensagem"
          aria-label="Enviar mensagem"
          disabled={c.consent === "optout"}
          onClick={() => setMensagemPara(c)}
          className={`${box} text-zinc-400 transition-colors hover:bg-emerald-50 hover:text-[#0F8C5A] disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-emerald-500/10`}
        >
          <MessageSquare className="h-4 w-4" />
        </button>
        <button
          title="Marcar opt-out (descadastrar dos disparos)"
          aria-label="Marcar opt-out"
          disabled={c.consent === "optout"}
          onClick={() => onOptOut(c)}
          className={`${box} text-zinc-400 transition-colors hover:bg-amber-50 hover:text-amber-600 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-amber-500/10`}
        >
          <BellOff className="h-4 w-4" />
        </button>
        <button
          title="Editar"
          aria-label="Editar"
          onClick={() => setEditing(c)}
          className={`${box} text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800`}
        >
          <Edit2 className="h-4 w-4" />
        </button>
        <button
          title="Remover"
          aria-label="Remover"
          onClick={() => onRemove(c)}
          className={`${box} text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10`}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    );
  };

  return (
    <div className="space-y-4 p-4 sm:p-6 lg:p-7">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative w-full sm:min-w-[240px] sm:flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nome, telefone ou DDD…"
            className="w-full rounded-xl border border-zinc-200 bg-white py-2.5 pl-9 pr-3 text-base outline-none placeholder:text-zinc-400 focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 sm:py-2 sm:text-sm"
          />
        </div>
        <div className="hidden items-center gap-1.5 text-zinc-400 sm:flex"><Filter className="h-4 w-4" /></div>
        {/* no mobile os filtros viram uma grade de 2 colunas; do sm pra cima `contents`
            devolve os selects ao flex do pai, preservando o layout do desktop */}
        <div className="grid grid-cols-2 gap-2 sm:contents">
          {sel(regiao, setRegiao, regioes, "Região / DDD")}
          {sel(tag, setTag, tags, "Tag")}
          {sel(consent, setConsent, ["consentido", "pendente", "optout"], "Consentimento", "col-span-2 sm:col-span-1")}
        </div>
        <div className="hidden sm:block sm:ml-auto" />
        <PrimaryBtn className="w-full sm:w-auto" onClick={openImport}><Upload className="h-4 w-4" /> Importar contatos</PrimaryBtn>
      </div>

      {/* estados de carregamento e erro */}
      {loading && (
        <div className="py-8 text-center text-sm text-zinc-400">Carregando contatos…</div>
      )}
      {error && !loading && (
        <div className="flex flex-col gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300 sm:flex-row sm:items-center sm:justify-between sm:gap-0">
          <span className="break-words">{error.message || "Erro ao carregar contatos."}</span>
          <button onClick={reload} className="shrink-0 self-start rounded-lg border border-red-300 px-3 py-2 text-xs font-medium hover:bg-red-100 dark:border-red-500/30 dark:hover:bg-red-500/20 sm:ml-4 sm:self-auto sm:py-1">
            Tentar novamente
          </button>
        </div>
      )}

      {!loading && (
        <Card className="overflow-hidden">
          <div className="flex flex-col gap-1.5 border-b border-zinc-100 px-4 py-3 text-[13px] dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <span className="text-zinc-500 dark:text-zinc-400">
              <span className="font-semibold text-zinc-700 dark:text-zinc-200">{filtrados.length}</span> contatos
            </span>
            <span className="inline-flex items-start gap-1.5 text-[12px] text-zinc-400 sm:items-center sm:text-[13px]">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#0F8C5A] sm:mt-0" />
              Suprimidos por opt-out são ocultados de disparos automaticamente
            </span>
          </div>

          {/* Mobile: lista de cards — muito melhor no dedo que rolagem lateral */}
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/60 lg:hidden">
            {filtrados.map((c) => (
              <li key={c.id} className="p-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
                    {iniciais(c.nome)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">{c.nome}</div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px] tabular-nums text-zinc-400">{c.tel}</span>
                      {janelaBadge(c)}
                    </div>
                  </div>
                  <div className="shrink-0"><ConsentChip consent={c.consent} /></div>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px] text-zinc-600 dark:text-zinc-300">
                  <span>DDD {c.ddd} · <span className="text-zinc-400">{c.regiao}</span></span>
                  <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    {c.tag}
                  </span>
                </div>

                <div className="mt-2 border-t border-zinc-100 pt-2 dark:border-zinc-800/60">
                  {acoes(c, true)}
                </div>
              </li>
            ))}
            {filtrados.length === 0 && (
              <li className="px-4 py-12 text-center text-sm text-zinc-400">
                Nenhum contato encontrado com esses filtros.
              </li>
            )}
          </ul>

          {/* Desktop: tabela completa */}
          <div className="hidden overflow-x-auto lg:block">
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
                          {iniciais(c.nome)}
                        </div>
                        <div>
                          <div className="font-medium text-zinc-800 dark:text-zinc-100">{c.nome}</div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[12px] tabular-nums text-zinc-400">{c.tel}</span>
                            {janelaBadge(c)}
                          </div>
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
                    <td className="px-5 py-3">{acoes(c)}</td>
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

      {mensagemPara && (
        <EnviarMensagemModal contato={mensagemPara} onClose={() => setMensagemPara(null)} />
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

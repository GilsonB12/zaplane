import React, { useEffect, useState } from "react";
import { Send, Clock, Check, CheckCheck, XCircle, ChevronLeft } from "lucide-react";
import { BRAND } from "../components/ui.jsx";
import { useResource, useMutation } from "../hooks/useResource.js";
import { listConversations, getConversation, sendText } from "../api/endpoints.js";
import EnviarMensagemModal from "../components/EnviarMensagemModal.jsx";

/* ----------------------------- Helpers ----------------------------- */
function iniciais(nome) {
  return (nome || "")
    .trim()
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function horaRelativa(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const dias = Math.floor(h / 24);
  if (dias < 7) return `${dias}d`;
  return new Date(iso).toLocaleDateString("pt-BR");
}

function horaCurta(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

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

// countdown curto "Xh Ym" pro selo inline da lista (ex.: "3h12m")
function expiraEmCurto(iso) {
  if (!iso) return "";
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "expirada";
  const totalMin = Math.floor(diffMs / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h${m}m`;
}

// avatar: iniciais do nome; sem nome, usa os 2 últimos dígitos do telefone
function avatarLabel(nome, phone) {
  if (nome && nome.trim()) return iniciais(nome);
  return (phone || "").replace(/\D/g, "").slice(-2);
}

const STATUS_OUT = {
  queued: { label: "na fila", icon: Clock, cls: "text-zinc-400" },
  sent: { label: "enviado", icon: Check, cls: "text-zinc-400" },
  delivered: { label: "entregue", icon: CheckCheck, cls: "text-zinc-400" },
  read: { label: "lida", icon: CheckCheck, cls: "text-sky-500" },
  failed: { label: "falhou", icon: XCircle, cls: "text-red-500" },
};

/* ----------------------------- Conversas ----------------------------- */
export default function Conversas() {
  const [tick, setTick] = useState(0);
  const [sel, setSel] = useState(null); // telefone (E.164) selecionado
  const [texto, setTexto] = useState("");
  const [erroEnvio, setErroEnvio] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);

  // polling 5s — atualiza lista + thread aberta; para ao desmontar
  useEffect(() => {
    const id = setInterval(() => setTick((k) => k + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const listRes = useResource(() => listConversations(), [tick]);
  const conversas = listRes.data?.items ?? [];

  const threadRes = useResource(
    () => (sel ? getConversation(sel) : Promise.resolve(null)),
    [sel, tick],
  );

  const [thread, setThread] = useState(null);
  useEffect(() => { setThread(null); }, [sel]); // troca → limpa (mostra "Carregando…")
  useEffect(() => { if (threadRes.data) setThread(threadRes.data); }, [threadRes.data]); // chegada → atualiza sem piscar

  // Troca de conversa: limpa rascunho e erro (evita enviar texto de A para B)
  useEffect(() => { setTexto(""); setErroEnvio(null); }, [sel]);

  const convSel = conversas.find((c) => c.phone === sel) ?? null;
  const nomeSel = convSel?.name ?? thread?.contact?.name ?? sel;

  const envio = useMutation(sendText);

  async function enviar() {
    const t = texto.trim();
    if (!t || !sel || envio.pending) return;
    setErroEnvio(null);
    try {
      await envio.run({ phone: sel, text: t });
      setTexto("");
      setTick((k) => k + 1);
    } catch (e) {
      setErroEnvio(e.message || "Falha ao enviar mensagem.");
    }
  }

  function onComposerKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      enviar();
    }
  }

  return (
    <div className="flex h-full min-h-0">
      {/* ---- Coluna: lista de conversas ---- */}
      {/* mobile: ocupa a tela toda e some quando há conversa aberta; lg: coluna fixa de 320px */}
      <div
        className={`w-full shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800 lg:flex lg:w-80 ${
          sel ? "hidden" : "flex"
        }`}
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!listRes.data && listRes.loading && (
            <div className="p-6 text-center text-sm text-zinc-400">Carregando conversas…</div>
          )}
          {listRes.error && !listRes.data && (
            <div className="p-6 text-center text-[13px] text-red-600 dark:text-red-300">
              Erro ao carregar conversas.
            </div>
          )}
          {listRes.data && conversas.length === 0 && (
            <div className="p-6 text-center text-sm text-zinc-400">
              Nenhuma conversa ainda — dispare um template para começar.
            </div>
          )}
          {conversas.map((c) => {
            const ativa = c.phone === sel;
            const titulo = c.name || c.phone;
            const deVoce = c.lastMessage?.direction === "out";
            return (
              <button
                key={c.phone}
                onClick={() => setSel(c.phone)}
                className={`flex w-full items-start gap-3 border-b border-zinc-100 px-4 py-3.5 text-left transition-colors dark:border-zinc-800/60 sm:py-3 ${
                  ativa ? "bg-emerald-50 dark:bg-emerald-500/10" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                }`}
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300 sm:h-9 sm:w-9">
                  {avatarLabel(c.name, c.phone)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{titulo}</span>
                    <span className="shrink-0 text-[11px] text-zinc-400">{horaRelativa(c.lastMessage?.at)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span
                      className="shrink-0 text-[11px] leading-none"
                      title={c.windowOpen ? expiraEm(c.windowExpiresAt) : "janela fechada"}
                    >
                      {c.windowOpen ? "🟢" : "⚪"}
                    </span>
                    {c.windowOpen && (
                      <span className="shrink-0 text-[10px] text-zinc-400" title={expiraEm(c.windowExpiresAt)}>
                        {expiraEmCurto(c.windowExpiresAt)}
                      </span>
                    )}
                    <span className="truncate text-[12px] text-zinc-400">
                      {deVoce ? "Você: " : ""}
                      {c.lastMessage?.preview || ""}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ---- Coluna: thread ---- */}
      {/* mobile: só aparece com conversa selecionada (a lista dá lugar a ela); lg: sempre visível */}
      <div className={`min-w-0 flex-1 flex-col lg:flex ${sel ? "flex" : "hidden"}`}>
        {!sel && (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-zinc-400">
            Selecione uma conversa para ver as mensagens.
          </div>
        )}

        {sel && (
          <>
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800 sm:px-5 sm:py-3">
              <div className="flex min-w-0 items-center gap-1.5">
                <button
                  onClick={() => setSel(null)}
                  aria-label="Voltar para a lista de conversas"
                  className="-ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800 lg:hidden"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-semibold text-zinc-900 dark:text-white">{nomeSel}</div>
                  <div className="truncate text-[12px] tabular-nums text-zinc-400">{sel}</div>
                </div>
              </div>
              <span
                className={`ml-0 shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset sm:ml-3 ${
                  thread?.windowOpen
                    ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300"
                    : "bg-zinc-100 text-zinc-500 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-400"
                }`}
              >
                {thread?.windowOpen ? `🟢 ${expiraEm(thread.windowExpiresAt)}` : "⚪ janela fechada"}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto bg-[#E5DDD5]/40 px-3 py-3 dark:bg-zinc-900/40 sm:px-5 sm:py-4">
              {!thread && (
                <div className="text-center text-sm text-zinc-400">Carregando conversa…</div>
              )}
              {thread && thread.items.length === 0 && (
                <div className="text-center text-sm text-zinc-400">Nenhuma mensagem nesta conversa ainda.</div>
              )}
              <div className="space-y-2">
                {(thread?.items ?? []).map((m) => {
                  const out = m.direction === "out";
                  const meta = out ? STATUS_OUT[m.status] : null;
                  const StatusIcon = meta?.icon;
                  return (
                    <div key={m.id} className={`flex ${out ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[85%] rounded-xl px-3 py-2 text-[13px] leading-snug shadow-sm sm:max-w-[70%] ${
                          out
                            ? "rounded-tr-sm bg-[#DCF8C6] text-zinc-800 dark:bg-[#075E54]/90 dark:text-zinc-50"
                            : "rounded-tl-sm bg-white text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
                        }`}
                      >
                        <p className="whitespace-pre-wrap break-words">
                          {/* prefixo [tipo] só p/ mídia recebida — outbound já traz "[template] nome" do backend */}
                          {m.direction === "in" && m.type && m.type !== "text" ? `[${m.type}] ` : ""}
                          {m.body}
                        </p>
                        <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-zinc-500 dark:text-zinc-300">
                          {horaCurta(m.at)}
                          {out && StatusIcon && <StatusIcon className={`h-3 w-3 ${meta.cls}`} title={meta.label} />}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="shrink-0 border-t border-zinc-200 p-3 dark:border-zinc-800">
              {thread?.windowOpen ? (
                <div className="flex items-end gap-2">
                  <textarea
                    value={texto}
                    onChange={(e) => setTexto(e.target.value)}
                    onKeyDown={onComposerKeyDown}
                    rows={1}
                    placeholder="Escreva uma mensagem… (Enter envia, Shift+Enter quebra linha)"
                    className="min-w-0 flex-1 resize-none rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 sm:py-2"
                  />
                  <button
                    onClick={enviar}
                    disabled={envio.pending || !texto.trim()}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white disabled:cursor-not-allowed disabled:opacity-60"
                    style={{ backgroundColor: BRAND }}
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-stretch justify-between gap-2 rounded-xl bg-amber-50 px-4 py-3 text-[12px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-300 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
                  <span>Janela fechada — inicie a conversa com um template para poder responder.</span>
                  <button
                    onClick={() => setModalOpen(true)}
                    className="w-full shrink-0 rounded-lg bg-white px-3 py-2.5 text-[12px] font-semibold text-amber-800 shadow-sm dark:bg-zinc-900 dark:text-amber-300 sm:w-auto sm:py-1.5"
                  >
                    Enviar template
                  </button>
                </div>
              )}
              {erroEnvio && (
                <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:bg-red-500/10 dark:text-red-300">
                  {erroEnvio}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {modalOpen && sel && (
        <EnviarMensagemModal
          contato={{ nome: convSel?.name ?? sel, tel: sel }}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

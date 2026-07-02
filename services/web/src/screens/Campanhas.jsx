import React, { useMemo, useState } from "react";
import {
  MoreVertical, ChevronLeft, ChevronRight, Send, Zap, CheckCheck, FileText,
  AlertTriangle, BadgeCheck, ShieldCheck, Check, UserRound, X,
} from "lucide-react";
import {
  Card, StatusBadge, CategoryTag, ProgressBar, PrimaryBtn, BRAND, TEAL,
  WhatsAppBubble,
} from "../components/ui.jsx";
import { useResource, useMutation } from "../hooks/useResource.js";
import { toUiCampaign, toUiTemplate } from "../api/adapters.js";
import {
  listCampaigns, getCampaign, createCampaign, cancelCampaign,
  listLists, listTemplates,
} from "../api/endpoints.js";
import { extrairVariaveis, contextoDaVariavel, preencherCorpo } from "../utils/template.js";

/* ----------------------------- Grid de campanhas ----------------------------- */
export default function Campanhas({ openCampaign }) {
  const { data, loading, error, reload } = useResource(
    () => listCampaigns({ pageSize: 60 }),
    [],
  );
  const campanhas = useMemo(() => (data?.items ?? []).map(toUiCampaign), [data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-20 text-zinc-400">
        Carregando campanhas…
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-7">
        <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-[13px] text-red-700 dark:border-red-500/20 dark:bg-red-500/5 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Erro ao carregar campanhas: {error.message || "falha na requisição."}</span>
          <button
            onClick={reload}
            className="ml-auto rounded-lg border border-red-200 px-3 py-1 text-xs font-medium hover:bg-red-100 dark:border-red-500/30 dark:hover:bg-red-500/10"
          >
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }

  if (campanhas.length === 0) {
    return (
      <div className="flex items-center justify-center p-20 text-zinc-400">
        Nenhuma campanha ainda.
      </div>
    );
  }

  return (
    <div className="space-y-4 p-7">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {campanhas.map((c) => {
          const pct = c.total ? Math.round((c.enviadas / c.total) * 100) : 0;
          return (
            <Card key={c.id} className="cursor-pointer p-5 transition-shadow hover:shadow-md">
              <div onClick={() => openCampaign(c.id)}>
                <div className="flex items-start justify-between">
                  <StatusBadge status={c.status} />
                  <button className="rounded-lg p-1 text-zinc-300 hover:bg-zinc-100 hover:text-zinc-500 dark:hover:bg-zinc-800">
                    <MoreVertical className="h-4 w-4" />
                  </button>
                </div>
                <h3 className="mt-3 text-[15px] font-semibold text-zinc-900 dark:text-white">{c.nome}</h3>
                <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-zinc-400">
                  {c.template} <CategoryTag cat={c.categoria} />
                </div>
                <div className="mt-4">
                  <div className="mb-1.5 flex items-center justify-between text-[12px]">
                    <span className="text-zinc-500 dark:text-zinc-400">
                      {c.enviadas.toLocaleString("pt-BR")} / {c.total.toLocaleString("pt-BR")}
                    </span>
                    <span className="font-medium tabular-nums text-zinc-600 dark:text-zinc-300">{pct}%</span>
                  </div>
                  <ProgressBar value={c.enviadas} total={c.total} color={c.status === "falha" ? "#ef4444" : BRAND} />
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{c.entregues.toLocaleString("pt-BR")}</div>
                    <div className="text-[10px] text-zinc-400">entregues</div>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{c.lidas.toLocaleString("pt-BR")}</div>
                    <div className="text-[10px] text-zinc-400">lidas</div>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-red-500">{c.falhas}</div>
                    <div className="text-[10px] text-zinc-400">falhas</div>
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------- Nova campanha (wizard) ----------------------------- */
export function NovaCampanha({ setScreen, openCampaign }) {
  const [step, setStep] = useState(1);
  const [listId, setListId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [nome, setNome] = useState("");
  const [valores, setValores] = useState({}); // {1: "texto fixo", 2: "{{name}}", ...}
  const [erroCriacao, setErroCriacao] = useState(null);

  const listsRes = useResource(() => listLists(), []);
  const tplRes = useResource(() => listTemplates(), []);

  const listas = listsRes.data ?? [];
  const templatesAprovados = useMemo(
    () => (tplRes.data ?? []).map(toUiTemplate).filter((t) => t.status === "aprovado"),
    [tplRes.data],
  );

  const create = useMutation(createCampaign);

  // Template selecionado (ou o primeiro aprovado como padrão)
  const tpl = templatesAprovados.find((t) => t.id === templateId) ?? templatesAprovados[0] ?? null;
  // Garante que templateId é sincronizado quando o primeiro template carrega
  const tplIdEfetivo = tpl ? (templateId || tpl.id) : templateId;

  // Variáveis do template selecionado + estado de preenchimento
  const variaveis = useMemo(() => (tpl ? extrairVariaveis(tpl.corpo) : []), [tpl]);
  const todasPreenchidas = variaveis.every((n) => (valores[n] ?? "").trim() !== "");
  const corpoPrevia = tpl ? preencherCorpo(tpl.corpo, variaveis, valores) : "";

  // Lista selecionada (vazia = todos os contatos do org)
  const listaAtual = listas.find((l) => l.id === listId) ?? null;

  // Estimativa: sem contagem real da API aqui, exibimos nome da lista ou "Todos os contatos"
  const nomePublico = listaAtual
    ? `Lista · ${listaAtual.name}`
    : "Todos os contatos da organização";

  const steps = ["Público", "Template", "Revisão"];

  async function confirmar() {
    setErroCriacao(null);
    try {
      // Monta {"1": valor, "2": "{{name}}"} — o gateway resolve {{name}} por contato
      const templateParams = {};
      for (const n of variaveis) templateParams[String(n)] = (valores[n] ?? "").trim();

      // channelId omitido de propósito → o gateway usa o canal ativo do org (Task A5)
      const r = await create.run({
        name: nome || "Campanha sem nome",
        templateId: tplIdEfetivo,
        listId: listId || undefined,
        templateParams,
      });
      openCampaign(r.campaignId);
    } catch (e) {
      setErroCriacao(e.message || "Falha ao criar campanha.");
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-7">
      {/* stepper */}
      <div className="flex items-center gap-2">
        {steps.map((s, i) => {
          const n = i + 1;
          const done = step > n;
          const active = step === n;
          return (
            <React.Fragment key={s}>
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                    active
                      ? "text-white"
                      : done
                      ? "bg-emerald-100 text-[#0F8C5A] dark:bg-emerald-500/15 dark:text-emerald-300"
                      : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800"
                  }`}
                  style={active ? { backgroundColor: BRAND } : undefined}
                >
                  {done ? <Check className="h-4 w-4" /> : n}
                </div>
                <span className={`text-[13px] font-medium ${active ? "text-zinc-900 dark:text-white" : "text-zinc-400"}`}>
                  {s}
                </span>
              </div>
              {i < steps.length - 1 && <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />}
            </React.Fragment>
          );
        })}
      </div>

      {/* STEP 1 — Público */}
      {step === 1 && (
        <Card className="p-6">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-white">Quem vai receber?</h2>
          <p className="text-[13px] text-zinc-500 dark:text-zinc-400">
            Escolha uma lista ou deixe em branco para enviar a todos os contatos da organização.
          </p>

          {/* Campo de nome da campanha */}
          <div className="mt-5">
            <label className="mb-1 block text-[12px] font-medium text-zinc-600 dark:text-zinc-300">
              Nome da campanha
            </label>
            <input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Ex: Promoção de Julho"
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-[#0F8C5A] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>

          <div className="mt-5 space-y-2.5">
            {/* Opção "Todos os contatos" */}
            <label
              className={`flex cursor-pointer items-center gap-3 rounded-xl border p-4 transition-colors ${
                listId === "" ? "border-[#0F8C5A] bg-emerald-50/40 dark:bg-emerald-500/5" : "border-zinc-200 dark:border-zinc-800"
              }`}
            >
              <input
                type="radio"
                checked={listId === ""}
                onChange={() => setListId("")}
                className="accent-[#0F8C5A]"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">Todos os contatos</div>
                <div className="text-[12px] text-zinc-400">Envia para todos os contatos da organização com consentimento</div>
              </div>
            </label>

            {/* Listas carregadas da API */}
            {listsRes.loading && (
              <div className="text-[12px] text-zinc-400 px-1">Carregando listas…</div>
            )}
            {!listsRes.loading && listas.map((l) => (
              <label
                key={l.id}
                className={`flex cursor-pointer items-center gap-3 rounded-xl border p-4 transition-colors ${
                  listId === l.id ? "border-[#0F8C5A] bg-emerald-50/40 dark:bg-emerald-500/5" : "border-zinc-200 dark:border-zinc-800"
                }`}
              >
                <input
                  type="radio"
                  checked={listId === l.id}
                  onChange={() => setListId(l.id)}
                  className="accent-[#0F8C5A]"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">Lista · {l.name}</div>
                  <div className="text-[12px] text-zinc-400">{l.type ?? "lista"}</div>
                </div>
              </label>
            ))}
          </div>

          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-200/70 bg-amber-50/70 p-3.5 dark:border-amber-500/20 dark:bg-amber-500/5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-[12px] leading-snug text-amber-800 dark:text-amber-300">
              Contatos sem base legal (opt-out / sem consentimento) serão automaticamente suprimidos para manter a conformidade com a LGPD.
            </p>
          </div>
        </Card>
      )}

      {/* STEP 2 — Template */}
      {step === 2 && (
        <Card className="p-6">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-white">Escolha um template aprovado</h2>
          <p className="text-[13px] text-zinc-500 dark:text-zinc-400">
            Apenas templates com aprovação da Meta podem ser disparados.
          </p>

          {tplRes.loading && (
            <div className="mt-5 text-[13px] text-zinc-400">Carregando templates…</div>
          )}

          {!tplRes.loading && templatesAprovados.length === 0 && (
            <div className="mt-5 rounded-xl border border-amber-200/70 bg-amber-50/70 p-4 text-[13px] text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-300">
              Nenhum template aprovado disponível. Aguarde a aprovação da Meta ou aprove um manualmente no banco para testes.
            </div>
          )}

          {!tplRes.loading && templatesAprovados.length > 0 && (
            <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
              <div className="space-y-2">
                {templatesAprovados.map((t) => (
                  <label
                    key={t.id}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors ${
                      tplIdEfetivo === t.id ? "border-[#0F8C5A] bg-emerald-50/40 dark:bg-emerald-500/5" : "border-zinc-200 dark:border-zinc-800"
                    }`}
                  >
                    <input
                      type="radio"
                      checked={tplIdEfetivo === t.id}
                      onChange={() => { setTemplateId(t.id); setValores({}); }}
                      className="accent-[#0F8C5A]"
                    />
                    <div className="flex-1">
                      <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{t.nome}</div>
                      <div className="mt-0.5">
                        <CategoryTag cat={t.categoria} />
                      </div>
                    </div>
                    <BadgeCheck className="h-4 w-4 text-emerald-500" />
                  </label>
                ))}

                {tpl && variaveis.length > 0 && (
                  <div className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/40">
                    <div className="mb-1 text-[12px] font-medium text-zinc-600 dark:text-zinc-300">
                      Variáveis do template
                    </div>
                    <p className="mb-2.5 text-[11px] leading-snug text-zinc-400">
                      O texto tem espaços a preencher. Digite um valor (igual para todos)
                      ou use o <span className="font-medium">nome do contato</span> para
                      personalizar por destinatário. Acompanhe na prévia ao lado.
                    </p>
                    <div className="space-y-2.5">
                      {variaveis.map((n) => {
                        const usaNome = (valores[n] ?? "") === "{{name}}";
                        return (
                          <div key={n}>
                            <div className="mb-1 text-[11px] text-zinc-400">
                              Variável <span className="font-mono font-medium text-zinc-500 dark:text-zinc-300">{`{{${n}}}`}</span>
                              {" · "}
                              <span className="italic">“{contextoDaVariavel(tpl.corpo, n)}”</span>
                            </div>
                            {usaNome ? (
                              <div className="flex items-center justify-between rounded-lg border border-emerald-300/70 bg-emerald-50 px-2.5 py-1.5 text-[13px] font-medium text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                                <span className="inline-flex items-center gap-1.5">
                                  <UserRound className="h-3.5 w-3.5" /> Nome do contato
                                </span>
                                <button
                                  title="Voltar a digitar um valor fixo"
                                  onClick={() => setValores((v) => ({ ...v, [n]: "" }))}
                                  className="rounded p-0.5 text-emerald-600 hover:bg-emerald-100 dark:text-emerald-300 dark:hover:bg-emerald-500/20"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ) : (
                              <div className="flex gap-1.5">
                                <input
                                  value={valores[n] ?? ""}
                                  onChange={(e) => setValores((v) => ({ ...v, [n]: e.target.value }))}
                                  placeholder="Digite o valor…"
                                  className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-[#0F8C5A] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                                />
                                <button
                                  title="Usar o nome de cada contato (personalizado)"
                                  onClick={() => setValores((v) => ({ ...v, [n]: "{{name}}" }))}
                                  className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-zinc-200 px-2 text-[11px] font-medium text-zinc-500 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-300"
                                >
                                  <UserRound className="h-3.5 w-3.5" /> Nome
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {!todasPreenchidas && (
                      <p className="mt-2.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                        Preencha {variaveis.length === 1 ? "a variável" : `as ${variaveis.length} variáveis`} para continuar.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {tpl && (
                <div>
                  <div className="mb-2 text-[12px] font-medium text-zinc-500 dark:text-zinc-400">
                    Prévia {variaveis.length > 0 && <span className="text-zinc-400">— atualiza enquanto você digita</span>}
                  </div>
                  <WhatsAppBubble corpo={corpoPrevia} botoes={tpl.botoes} />
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* STEP 3 — Revisão */}
      {step === 3 && (
        <Card className="p-6">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-white">Revisão e disparo</h2>
          <p className="text-[13px] text-zinc-500 dark:text-zinc-400">Confira os detalhes antes de confirmar.</p>
          <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
            <div className="space-y-3">
              {[
                ["Nome da campanha", nome || "Campanha sem nome"],
                ["Público", nomePublico],
                ["Template", tpl?.nome ?? "—"],
                ["Categoria", tpl?.categoria ?? "—"],
                ...variaveis.map((n) => [
                  `Variável {{${n}}}`,
                  (valores[n] ?? "") === "{{name}}" ? "Nome do contato" : (valores[n] ?? "").trim() || "—",
                ]),
                ["País", "Brasil (+55)"],
              ].map(([k, v]) => (
                <div
                  key={k}
                  className="flex items-center justify-between border-b border-zinc-100 pb-2.5 text-[13px] last:border-0 dark:border-zinc-800"
                >
                  <span className="text-zinc-500 dark:text-zinc-400">{k}</span>
                  <span className="font-medium text-zinc-800 dark:text-zinc-100">{v}</span>
                </div>
              ))}

              <div className="mt-3 flex items-start gap-2 rounded-xl bg-emerald-50/70 p-3 text-[12px] text-emerald-800 dark:bg-emerald-500/5 dark:text-emerald-300">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                Todas as mensagens incluem opção de opt-out. Contatos sem base legal serão suprimidos automaticamente.
              </div>

              {erroCriacao && (
                <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[12px] text-red-700 dark:border-red-500/20 dark:bg-red-500/5 dark:text-red-300">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {erroCriacao}
                </div>
              )}
            </div>

            {tpl && (
              <div>
                <div className="mb-2 text-[12px] font-medium text-zinc-500 dark:text-zinc-400">Mensagem final</div>
                <WhatsAppBubble corpo={corpoPrevia} botoes={tpl.botoes} />
              </div>
            )}
          </div>
        </Card>
      )}

      {/* footer nav */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => (step === 1 ? setScreen("campanhas") : setStep(step - 1))}
          className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <ChevronLeft className="h-4 w-4" /> {step === 1 ? "Cancelar" : "Voltar"}
        </button>

        {step < 3 ? (
          <PrimaryBtn
            onClick={() => setStep(step + 1)}
            disabled={step === 2 && (templatesAprovados.length === 0 || !todasPreenchidas)}
          >
            Continuar <ChevronRight className="h-4 w-4" />
          </PrimaryBtn>
        ) : (
          <PrimaryBtn
            onClick={confirmar}
            disabled={create.pending || !tplIdEfetivo}
          >
            <Send className="h-4 w-4" />
            {create.pending ? "Criando…" : "Confirmar disparo"}
          </PrimaryBtn>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- Campanha — detalhe ----------------------------- */
export function CampanhaDetalhe({ campaignId, setScreen }) {
  const { data, loading, error, reload } = useResource(
    () => getCampaign(campaignId),
    [campaignId],
  );
  const live = data ? toUiCampaign(data) : null;
  const cancel = useMutation(cancelCampaign);

  async function onCancel() {
    await cancel.run(campaignId);
    reload();
  }

  if (loading && !live) {
    return (
      <div className="flex items-center justify-center p-20 text-zinc-400">
        Carregando campanha…
      </div>
    );
  }

  if (error && !live) {
    return (
      <div className="p-7">
        <button
          onClick={() => setScreen("campanhas")}
          className="mb-4 inline-flex items-center gap-1 text-[13px] font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          <ChevronLeft className="h-4 w-4" /> Campanhas
        </button>
        <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-[13px] text-red-700 dark:border-red-500/20 dark:bg-red-500/5 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Erro ao carregar campanha: {error.message || "falha na requisição."}</span>
          <button
            onClick={reload}
            className="ml-auto rounded-lg border border-red-200 px-3 py-1 text-xs font-medium hover:bg-red-100 dark:border-red-500/30 dark:hover:bg-red-500/10"
          >
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }

  const metrics = [
    { k: "Enviadas", v: live?.enviadas ?? 0, total: live?.total ?? 0, color: BRAND },
    { k: "Entregues", v: live?.entregues ?? 0, total: live?.total ?? 0, color: TEAL },
    { k: "Lidas", v: live?.lidas ?? 0, total: live?.total ?? 0, color: "#3b82f6" },
    { k: "Falhas", v: live?.falhas ?? 0, total: live?.total ?? 0, color: "#ef4444" },
  ];

  const timeline = [
    {
      t: live?.quando ?? "—",
      label: "Campanha iniciada",
      desc: `${(live?.total ?? 0).toLocaleString("pt-BR")} destinatários na fila`,
      icon: Send,
      done: true,
    },
    {
      t: "+0m12s",
      label: "Aquecimento do número",
      desc: "Envio escalonado para preservar a qualidade",
      icon: Zap,
      done: true,
    },
    {
      t: "agora",
      label: live?.status === "enviando" ? "Enviando em tempo real" : "Envio concluído",
      desc: `${(live?.entregues ?? 0).toLocaleString("pt-BR")} entregues · ${(live?.lidas ?? 0).toLocaleString("pt-BR")} lidas`,
      icon: CheckCheck,
      done: live?.status !== "enviando",
    },
    {
      t: "—",
      label: "Relatório final",
      desc: "Disponível ao término do disparo",
      icon: FileText,
      done: false,
    },
  ];

  return (
    <div className="space-y-6 p-7">
      <button
        onClick={() => setScreen("campanhas")}
        className="inline-flex items-center gap-1 text-[13px] font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        <ChevronLeft className="h-4 w-4" /> Campanhas
      </button>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-white">
              {live?.nome ?? "—"}
            </h1>
            {live && <StatusBadge status={live.status} />}
          </div>
          <p className="mt-0.5 text-[13px] text-zinc-500 dark:text-zinc-400">
            {live?.template ?? "—"} · <CategoryTag cat={live?.categoria ?? "Marketing"} /> · iniciada {live?.quando ?? "—"}
          </p>
        </div>

        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <button
              onClick={reload}
              disabled={loading}
              className="rounded-xl border border-zinc-200 px-3.5 py-2 text-[13px] font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800 disabled:opacity-50"
            >
              {loading ? "Atualizando…" : "Atualizar"}
            </button>

            {live?.status === "enviando" && (
              <button
                onClick={onCancel}
                disabled={cancel.pending}
                className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2 text-[13px] font-medium text-red-700 hover:bg-red-100 dark:border-red-500/20 dark:bg-red-500/5 dark:text-red-300 dark:hover:bg-red-500/10 disabled:opacity-50"
              >
                {cancel.pending ? "Cancelando…" : "Cancelar"}
              </button>
            )}
          </div>
          {cancel.error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:bg-red-500/10 dark:text-red-300">
              {cancel.error.message}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {metrics.map((m) => (
          <Card key={m.k} className="p-5">
            <div className="text-[13px] text-zinc-500 dark:text-zinc-400">{m.k}</div>
            <div
              className="mt-1 text-2xl font-semibold tabular-nums tracking-tight"
              style={{ color: m.color }}
            >
              {m.v.toLocaleString("pt-BR")}
            </div>
            <div className="mt-3">
              <ProgressBar value={m.v} total={m.total} color={m.color} />
            </div>
            <div className="mt-1.5 text-[11px] text-zinc-400">
              {m.total > 0 ? Math.round((m.v / m.total) * 100) : 0}% do total
            </div>
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
                    <div
                      className={`flex h-8 w-8 items-center justify-center rounded-full ${
                        item.done ? "text-white" : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800"
                      }`}
                      style={item.done ? { backgroundColor: BRAND } : undefined}
                    >
                      <I className="h-4 w-4" />
                    </div>
                    {i < timeline.length - 1 && (
                      <div className="my-1 w-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                    )}
                  </div>
                  <div className="pb-5">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{item.label}</span>
                      <span className="text-[11px] text-zinc-400">{item.t}</span>
                    </div>
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
            <div className="flex items-center justify-between">
              <span className="text-zinc-500 dark:text-zinc-400">Base legal</span>
              <span className="font-medium text-zinc-800 dark:text-zinc-100">Consentimento</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500 dark:text-zinc-400">Opt-out na mensagem</span>
              <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" /> Incluído
              </span>
            </div>
            <div className="mt-2 flex items-start gap-2 rounded-xl bg-emerald-50/70 p-3 text-[12px] text-emerald-800 dark:bg-emerald-500/5 dark:text-emerald-300">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
              Disparo em conformidade com a LGPD. <a href="#" className="underline">Ver política</a>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

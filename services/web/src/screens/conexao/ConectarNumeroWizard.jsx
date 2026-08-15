import React, { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, MessageCircle, RefreshCw } from "lucide-react";
import {
  conexaoAtual, iniciarConexao, reenviarCodigo, verificarCodigo, cancelarConexao,
} from "../../api/endpoints.js";
import { mensagemErro } from "../../utils/erros.js";

const BRAND = "#0F8C5A";
const INPUT =
  "w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-base outline-none focus:border-[#0F8C5A] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 sm:py-2 sm:text-sm";

// Retomada: para cada status VIVO que GET /channels/assisted/current pode
// devolver, o passo que faz sentido abrir. Os outros status do banco
// (`concluida`, `falhou`, `cancelada`) nunca chegam aqui — o servidor filtra
// por VIVOS e responde `solicitacao: null`. Status desconhecido cai fora do
// mapa e o wizard começa do zero, que é o único desfecho honesto.
const PASSO_POR_STATUS = {
  criando: "preparando",           // número ainda sendo criado: NÃO existe SMS
  aguardando_codigo: "codigo",     // SMS enviado: o código já pode ser digitado
};

// A solicitação some do lado do servidor em dois casos: expirou/foi cancelada
// (o buscarViva() do backend responde 404 "Conexão não encontrada") ou
// esgotou as 5 tentativas de código (a própria 5ª resposta já vem com essa
// mensagem, e a solicitação vira 'falhou' — sai da lista de estados vivos).
// Em ambos, insistir nela é beco sem saída: o jeito certo é o wizard voltar
// sozinho para o início.
function conexaoSumiu(e) {
  if (e?.status === 404) return true;
  const msg = e?.body?.message;
  return typeof msg === "string" && /tentativas esgotadas/i.test(msg);
}

// A vaga na Meta é consumida no instante em que o número é aceito, e NÃO volta
// por API. O sinal disso na resposta do servidor é o status: `aguardando_codigo`
// só é gravado junto com o phone_number_id que a Meta devolveu (ver iniciar()
// no assisted.service). Em `criando` o número ainda não foi aceito — cancelar
// ali não custa nada e não deve assustar ninguém.
function numeroJaReservado(r) {
  return !!r && (r.status === "aguardando_codigo" || r.codigoJaVerificado === true);
}

// Mesmas faixas do IniciarConexaoDto do gateway (telefone: 10–20, nome: 2–60).
// Validar aqui evita a viagem ao servidor só para voltar com um erro, e evita
// que uma violação de tamanho apareça na tela como array em inglês.
function validarTelefone(v) {
  const t = (v || "").trim();
  if (!t) return null; // campo vazio: o botão já fica desabilitado, sem precisar de aviso
  if (t.length < 10) return "Informe o número com DDD.";
  if (t.length > 20) return "Número muito longo — confira os dígitos.";
  return null;
}
function validarNome(v) {
  const t = (v || "").trim();
  if (!t) return null;
  if (t.length < 2) return "Informe o nome do negócio.";
  if (t.length > 60) return "O nome do negócio deve ter no máximo 60 caracteres.";
  return null;
}

export default function ConectarNumeroWizard({ nomeOrganizacao, onConectado }) {
  const [passo, setPasso] = useState("inicio");
  const [aceite, setAceite] = useState(false);
  const [telefone, setTelefone] = useState("");
  const [nome, setNome] = useState(nomeOrganizacao || "");
  const [codigo, setCodigo] = useState("");
  const [req, setReq] = useState(null);
  const [erro, setErro] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [espera, setEspera] = useState(0);
  const [confirmandoCancelamento, setConfirmandoCancelamento] = useState(false);

  // Abre o passo correspondente ao estado real da solicitação. Devolve false
  // quando não há nada retomável — quem chamou decide o que dizer.
  function abrirSolicitacao(s) {
    const destino = s && PASSO_POR_STATUS[s.status];
    if (!destino) return false;
    setReq(s);
    setEspera(s.podeReenviarEm || 0);
    setConfirmandoCancelamento(false);
    setPasso(destino);
    return true;
  }

  function voltarAoInicio(mensagem) {
    setReq(null);
    setCodigo("");
    setConfirmandoCancelamento(false);
    setPasso("inicio");
    setErro(mensagem ?? null);
  }

  // Retomada: abre no passo que corresponde ao estado do servidor. Ir sempre
  // para o passo do código deixava quem estava em `criando` olhando para um
  // campo pedindo um SMS que nunca foi enviado — verificar falhava, reenviar
  // falhava, e não havia saída na tela.
  useEffect(() => {
    conexaoAtual()
      .then((r) => abrirSolicitacao(r?.solicitacao))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (espera <= 0) return;
    const t = setTimeout(() => setEspera((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [espera]);

  async function executar(fn) {
    setErro(null);
    setConfirmandoCancelamento(false);
    setOcupado(true);
    try {
      return await fn();
    } catch (e) {
      if (conexaoSumiu(e)) {
        // A solicitação não existe mais no servidor — não há nada aqui para
        // reenviar, verificar ou cancelar. Volta para o início já explicando
        // o motivo, em vez de deixar o usuário preso num passo sem saída.
        voltarAoInicio("Esta conexão expirou. Comece novamente.");
        return null;
      }
      // Um lugar só traduz 402/403/429/503 e companhia (utils/erros.js) — sem
      // isso, o rate limit das rotas de conexão chegava na tela como
      // "ThrottlerException: Too many requests".
      setErro(mensagemErro(e, "Não foi possível concluir."));
      return null;
    } finally {
      setOcupado(false);
    }
  }

  const enviar = () => {
    const msg = validarTelefone(telefone) || validarNome(nome);
    if (msg) {
      setErro(msg);
      return;
    }
    return executar(async () => {
      const r = await iniciarConexao({
        telefone, nomeExibicao: nome, aceitouPreRequisito: aceite,
      });
      // O servidor só responde 200 aqui depois de a Meta aceitar o número e o
      // SMS sair — o mesmo estado que ele grava como `aguardando_codigo`.
      // Guardar o status deixa a tela raciocinar igual na ida e na retomada.
      setReq({ ...r, status: "aguardando_codigo", tentativasRestantes: 5 });
      setEspera(60);
      setPasso("codigo");
    });
  };

  // Consulta de novo o estado no servidor: é a ação que resolve o passo
  // "preparando", onde só o servidor sabe se o número já ficou pronto.
  const atualizarSituacao = () =>
    executar(async () => {
      const r = await conexaoAtual();
      if (!abrirSolicitacao(r?.solicitacao)) {
        voltarAoInicio("Não foi possível preparar este número. Você pode tentar de novo.");
      }
    });

  const confirmar = (valorDoCodigo) =>
    executar(async () => {
      await verificarCodigo(req.id, valorDoCodigo);
      setPasso("pronto");
      onConectado?.();
    });

  // Cancelar é a saída de emergência — precisa funcionar mesmo que o servidor
  // já não tenha mais a solicitação (ex.: expirou depois da 5ª tentativa
  // errada). Por isso NÃO usa executar(): o estado local é resetado sempre,
  // dentro do finally, mesmo se a chamada à API falhar.
  const cancelar = async () => {
    setErro(null);
    setOcupado(true);
    try {
      if (req?.id) await cancelarConexao(req.id);
    } catch {
      // Se a solicitação já não existe no servidor, o objetivo do usuário —
      // recomeçar — já está satisfeito. Insistir em mostrar erro é hostil.
    } finally {
      setOcupado(false);
      voltarAoInicio(null);
    }
  };

  // Cancelar com o número já reservado é irreversível: pede confirmação. Sem
  // reserva ainda (passo "preparando"), cancelar não custa nada — nesse caso
  // um aviso dramático só assustaria à toa.
  const pedirCancelamento = () => {
    if (!numeroJaReservado(req)) return cancelar();
    setErro(null);
    setConfirmandoCancelamento(true);
  };

  const caixa = "rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900";
  const linkSecundario =
    "text-[13px] font-medium text-zinc-500 disabled:opacity-40 hover:underline dark:text-zinc-400";
  const caixaErro =
    "rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:bg-red-500/10 dark:text-red-300";

  // Confirmação do cancelamento: o preço só aparece quando ele é real.
  const blocoCancelamento = confirmandoCancelamento ? (
    <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3.5 dark:border-amber-500/30 dark:bg-amber-500/10">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-amber-900 dark:text-amber-200">
            Cancelar agora trava este número
          </p>
          <p className="mt-1 text-[12px] leading-snug text-amber-800 dark:text-amber-200/90">
            O número <strong>{req?.numeroMascarado}</strong> já foi reservado para a sua conta.
            Se você cancelar, <strong>não vai dar para conectar esse mesmo número de novo por
            aqui</strong> — só falando com o suporte. Para usar <em>outro</em> número, cancelar
            é o caminho certo.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              onClick={() => setConfirmandoCancelamento(false)}
              className="rounded-xl px-3.5 py-2.5 text-sm font-semibold text-white sm:py-2"
              style={{ backgroundColor: BRAND }}
            >
              Continuar a conexão
            </button>
            <button disabled={ocupado} onClick={cancelar}
              className="text-[13px] font-medium text-amber-800 underline disabled:opacity-40 dark:text-amber-200">
              {ocupado ? "Cancelando…" : "Cancelar mesmo assim"}
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  if (passo === "inicio") {
    return (
      <div className={caixa}>
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">
          Conecte seu número do WhatsApp
        </h3>
        <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">
          Para disparar campanhas, conecte um número. Leva cerca de 3 minutos.
        </p>
        {erro && <div className={`mt-3 ${caixaErro}`}>{erro}</div>}
        <button
          onClick={() => { setErro(null); setPasso("prerequisito"); }}
          className="mt-4 inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-semibold text-white sm:py-2"
          style={{ backgroundColor: BRAND }}
        >
          <MessageCircle className="h-4 w-4" /> Conectar meu número
        </button>
      </div>
    );
  }

  if (passo === "prerequisito") {
    return (
      <div className={caixa}>
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">
              Antes de começar, confira duas coisas
            </h3>
            <ul className="mt-2 space-y-1.5 text-[13px] leading-snug text-zinc-600 dark:text-zinc-300">
              <li>
                • O número <strong>não pode ter WhatsApp ativo</strong> — nem o comum, nem o
                Business. Se tiver, é preciso apagar a conta antes, e o histórico de conversas
                se perde.
              </li>
              <li>• O número vai <strong>receber um SMS</strong> com um código. Tenha o aparelho em mãos.</li>
            </ul>
            <p className="mt-2 text-[12px] text-zinc-400">
              Dica: use um chip novo, dedicado ao disparo. Evita perder seu histórico.
            </p>
            <label className="mt-3 flex items-start gap-2 text-[13px] text-zinc-700 dark:text-zinc-200">
              <input type="checkbox" className="mt-0.5" checked={aceite}
                onChange={(e) => setAceite(e.target.checked)} />
              Confirmo que este número não tem WhatsApp ativo, ou que posso apagá-lo.
            </label>
            <button
              disabled={!aceite}
              onClick={() => setPasso("dados")}
              className="mt-4 rounded-xl px-3.5 py-2.5 text-sm font-semibold text-white disabled:opacity-40 sm:py-2"
              style={{ backgroundColor: BRAND }}
            >
              Continuar
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (passo === "dados") {
    const msgTelefone = validarTelefone(telefone);
    const msgNome = validarNome(nome);
    const dadosValidos = !msgTelefone && !msgNome && telefone.trim() && nome.trim();
    return (
      <div className={caixa}>
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">Dados do número</h3>
        <div className="mt-3 space-y-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded-xl border border-zinc-200 px-3 py-2.5 text-sm text-zinc-500 dark:border-zinc-800 sm:py-2">
                +55
              </span>
              <input className={INPUT} inputMode="tel" placeholder="(85) 99999-9999" value={telefone}
                onChange={(e) => setTelefone(e.target.value)} />
            </div>
            {msgTelefone && (
              <p className="mt-1.5 text-[12px] text-red-600 dark:text-red-400">{msgTelefone}</p>
            )}
          </div>
          <div>
            <input className={INPUT} placeholder="Nome do negócio" value={nome}
              onChange={(e) => setNome(e.target.value)} />
            {msgNome && (
              <p className="mt-1.5 text-[12px] text-red-600 dark:text-red-400">{msgNome}</p>
            )}
            <p className="mt-1.5 text-[12px] leading-snug text-zinc-500 dark:text-zinc-400">
              É este nome que aparece para quem recebe. A Meta analisa em algumas horas —
              <strong> até lá, o destinatário vê o número</strong>.
            </p>
          </div>
          {erro && <div className={caixaErro}>{erro}</div>}
          <button disabled={ocupado || !dadosValidos} onClick={enviar}
            className="rounded-xl px-3.5 py-2.5 text-sm font-semibold text-white disabled:opacity-40 sm:py-2"
            style={{ backgroundColor: BRAND }}>
            {ocupado ? "Enviando…" : "Enviar código por SMS"}
          </button>
        </div>
      </div>
    );
  }

  // Status `criando`: o cadastro do número ainda não foi confirmado, então
  // NENHUM SMS saiu. Pedir o código aqui era prometer algo que não existe.
  if (passo === "preparando") {
    return (
      <div className={caixa}>
        <div className="flex items-start gap-3">
          <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-zinc-400" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">
              Estamos preparando seu número
            </h3>
            <p className="mt-1 text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">
              O cadastro de <strong>{req?.numeroMascarado}</strong> ainda está sendo criado.
              O SMS com o código só é enviado depois que ele fica pronto — costuma levar menos
              de um minuto. <strong>Ainda não há código para digitar.</strong>
            </p>
            {erro && <div className={`mt-3 ${caixaErro}`}>{erro}</div>}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button disabled={ocupado} onClick={atualizarSituacao}
                className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-semibold text-white disabled:opacity-40 sm:py-2"
                style={{ backgroundColor: BRAND }}>
                <RefreshCw className={`h-4 w-4 ${ocupado ? "animate-spin" : ""}`} />
                {ocupado ? "Verificando…" : "Verificar de novo"}
              </button>
              <button disabled={ocupado} onClick={pedirCancelamento}
                className="text-[13px] text-zinc-400 disabled:opacity-40 hover:underline">
                Cancelar e recomeçar
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Verificação já aceita pela Meta numa tentativa anterior — só o registro
  // ficou faltando. Aqui a requisição vai SEM código: o campo é opcional na
  // rota justamente para isto. Antes era preciso mandar um "000000" de fachada
  // só para passar na validação — e se o estado "já verificado" estivesse
  // errado, aquele valor virava uma tentativa real na Meta e queimava uma das
  // 5 chances do cliente. Sem código, o pior caso agora é um 400 honesto.
  if (passo === "codigo" && req?.codigoJaVerificado) {
    return (
      <div className={caixa}>
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">Falta só concluir</h3>
        <p className="mt-1 text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">
          O código de <strong>{req?.numeroMascarado}</strong> já foi confirmado — não precisa
          digitar de novo. A conexão parou no último passo e é só retomar.
        </p>
        {erro && <div className={`mt-3 ${caixaErro}`}>{erro}</div>}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button disabled={ocupado} onClick={() => confirmar()}
            className="rounded-xl px-3.5 py-2.5 text-sm font-semibold text-white disabled:opacity-40 sm:py-2"
            style={{ backgroundColor: BRAND }}>
            {ocupado ? "Concluindo…" : "Concluir conexão"}
          </button>
          <button disabled={ocupado} onClick={pedirCancelamento}
            className="text-[13px] text-zinc-400 disabled:opacity-40 hover:underline">
            Cancelar e recomeçar
          </button>
        </div>
        {blocoCancelamento}
      </div>
    );
  }

  if (passo === "codigo") {
    return (
      <div className={caixa}>
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">Digite o código</h3>
        <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">
          Enviamos um SMS para <strong>{req?.numeroMascarado}</strong>
        </p>
        <input className={`${INPUT} mt-3 tracking-[0.4em]`} inputMode="numeric" maxLength={6}
          placeholder="______" value={codigo}
          onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ""))} />
        {erro && <div className={`mt-2 ${caixaErro}`}>{erro}</div>}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button disabled={ocupado || codigo.length !== 6} onClick={() => confirmar(codigo)}
            className="rounded-xl px-3.5 py-2.5 text-sm font-semibold text-white disabled:opacity-40 sm:py-2"
            style={{ backgroundColor: BRAND }}>
            {ocupado ? "Verificando…" : "Verificar e conectar"}
          </button>
          <button disabled={espera > 0 || ocupado}
            onClick={() => executar(async () => { await reenviarCodigo(req.id, "SMS"); setEspera(60); })}
            className={linkSecundario}>
            {espera > 0 ? `Reenviar em ${espera}s` : "Reenviar código"}
          </button>
          <button disabled={espera > 0 || ocupado}
            onClick={() => executar(async () => { await reenviarCodigo(req.id, "VOICE"); setEspera(60); })}
            className={linkSecundario}>
            Receber por ligação
          </button>
          <button disabled={ocupado} onClick={pedirCancelamento}
            className="text-[13px] text-zinc-400 disabled:opacity-40 hover:underline">
            Cancelar e recomeçar
          </button>
        </div>
        {blocoCancelamento}
      </div>
    );
  }

  return (
    <div className={caixa}>
      <div className="flex items-start gap-3">
        <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">Número conectado</h3>
          <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">
            Você já pode criar campanhas.
          </p>
        </div>
      </div>
    </div>
  );
}

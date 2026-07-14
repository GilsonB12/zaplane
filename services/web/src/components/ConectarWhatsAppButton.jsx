import React, { useEffect, useRef, useState } from "react";
import { MessageCircle, Loader2 } from "lucide-react";
import { BRAND, BRAND_DARK } from "./ui.jsx";
import { esExchange } from "../api/endpoints.js";

const FB_SDK_SRC = "https://connect.facebook.net/pt_BR/sdk.js";
const FB_APP_ID = import.meta.env.VITE_FB_APP_ID;
const ES_CONFIG_ID = import.meta.env.VITE_ES_CONFIG_ID;

// Injeta o SDK do Facebook uma única vez (guard global — evita duas tags/dois FB.init
// se o botão for montado mais de uma vez, ex.: card vazio + topo da tela).
function loadFbSdk() {
  return new Promise((resolve, reject) => {
    if (window.FB) { resolve(window.FB); return; }

    if (window.__fbSdkLoading) {
      const anterior = window.fbAsyncInit;
      window.fbAsyncInit = () => { anterior?.(); resolve(window.FB); };
      return;
    }
    window.__fbSdkLoading = true;

    window.fbAsyncInit = () => {
      window.FB.init({
        appId: FB_APP_ID,
        autoLogAppEvents: true,
        xfbml: false,
        version: "v25.0",
      });
      resolve(window.FB);
    };

    const script = document.createElement("script");
    script.src = FB_SDK_SRC;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => reject(new Error("Falha ao carregar o SDK do Facebook."));
    document.body.appendChild(script);
  });
}

const LABEL = {
  idle: "Conectar WhatsApp",
  "carregando-sdk": "Carregando…",
  "aguardando-popup": "Aguardando confirmação…",
  "trocando-codigo": "Conectando…",
  erro: "Conectar WhatsApp",
};
const EM_ANDAMENTO = ["carregando-sdk", "aguardando-popup", "trocando-codigo"];

/**
 * Botão "Conectar WhatsApp" — Embedded Signup (popup oficial da Meta). Carrega o SDK
 * JS sob demanda, abre o FB.login com o config_id do Zaplane e, ao voltar com `code` +
 * a sessão capturada via postMessage (waba_id/phone_number_id), troca tudo por um
 * canal ativo em POST /channels/es/exchange.
 */
export default function ConectarWhatsAppButton({ onConnected, primary = true }) {
  const [status, setStatus] = useState("idle");
  const [erro, setErro] = useState(null);
  const [sucesso, setSucesso] = useState(null);
  const sessao = useRef({ wabaId: null, phoneNumberId: null });

  useEffect(() => {
    function onMessage(event) {
      if (!String(event.origin || "").includes("facebook.com")) return;
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
      const info = data.data || {};
      if (info.waba_id) sessao.current.wabaId = info.waba_id;
      if (info.phone_number_id) sessao.current.phoneNumberId = info.phone_number_id;
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function conectar() {
    if (!ES_CONFIG_ID) return;
    setErro(null);
    setSucesso(null);
    sessao.current = { wabaId: null, phoneNumberId: null };
    setStatus("carregando-sdk");
    try {
      const FB = await loadFbSdk();
      setStatus("aguardando-popup");
      FB.login(
        (response) => {
          const code = response?.authResponse?.code;
          const { wabaId, phoneNumberId } = sessao.current;
          if (!code || !wabaId || !phoneNumberId) {
            setStatus("erro");
            setErro("Conexão não concluída — o popup foi fechado antes do fim ou a sessão expirou. Tente novamente.");
            return;
          }
          trocarCodigo(code, wabaId, phoneNumberId);
        },
        {
          config_id: ES_CONFIG_ID,
          response_type: "code",
          override_default_response_type: true,
          extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
        },
      );
    } catch (e) {
      setStatus("erro");
      setErro(e.message || "Falha ao carregar o SDK do Facebook.");
    }
  }

  async function trocarCodigo(code, wabaId, phoneNumberId) {
    setStatus("trocando-codigo");
    try {
      await esExchange({ code, wabaId, phoneNumberId });
      setStatus("idle");
      setSucesso("Número conectado com sucesso.");
      onConnected?.();
    } catch (e) {
      setStatus("erro");
      if (e.status === 503) {
        setErro("Conexão automática ainda em configuração — use Conectar manualmente.");
      } else {
        setErro(e.body?.message || e.message || "Falha ao concluir a conexão.");
      }
    }
  }

  const semConfig = !ES_CONFIG_ID;
  const desabilitado = semConfig || EM_ANDAMENTO.includes(status);

  return (
    <div>
      <button
        onClick={conectar}
        disabled={desabilitado}
        title={semConfig ? "aguardando configuração" : undefined}
        className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          primary ? "text-white" : "border border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
        }`}
        style={primary ? { backgroundColor: BRAND } : undefined}
        onMouseEnter={(e) => { if (primary && !desabilitado) e.currentTarget.style.backgroundColor = BRAND_DARK; }}
        onMouseLeave={(e) => { if (primary) e.currentTarget.style.backgroundColor = BRAND; }}
      >
        {EM_ANDAMENTO.includes(status) ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
        {LABEL[status] ?? "Conectar WhatsApp"}
      </button>

      <p className="mt-1.5 max-w-xs text-[11px] leading-snug text-zinc-400">
        Conclua sem fechar o popup (a sessão expira em 1h) · esteja logado no Business Manager
        correto · o número recebe um SMS ou ligação de verificação.
      </p>

      {erro && (
        <div className="mt-1.5 max-w-xs rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700 dark:bg-red-500/10 dark:text-red-300">{erro}</div>
      )}
      {sucesso && (
        <div className="mt-1.5 max-w-xs rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">{sucesso}</div>
      )}
    </div>
  );
}

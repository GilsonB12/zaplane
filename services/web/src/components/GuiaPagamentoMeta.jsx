import React, { useEffect, useState } from "react";
import { X, CreditCard, AlertTriangle, ExternalLink } from "lucide-react";

/**
 * Passo a passo para o cliente cadastrar a forma de pagamento na Meta.
 *
 * Por que este guia existe: a cobrança da Meta é direta com o cliente (o
 * Zaplane nunca vê esse dinheiro) e o Embedded Signup oferece esse passo de
 * um jeito fácil de pular — o botão "Concluir" fica ao lado de "Adicionar
 * forma de pagamento". Quem pula descobre semanas depois, quando os envios
 * param, e costuma culpar a plataforma.
 *
 * Os passos abaixo foram levantados percorrendo o fluxo real; cada armadilha
 * documentada aqui foi encontrada na prática, não deduzida da documentação.
 *
 * As imagens são opcionais: se o arquivo não existir em /guias, o passo
 * continua legível só com o texto (onError esconde a figura).
 */
const PASSOS = [
  {
    titulo: "Abra o Gerenciador de Negócios na conta certa",
    texto:
      "Use a MESMA conta do Facebook que você usou para conectar o número. Em outra conta, sua conta do WhatsApp Business simplesmente não aparece na lista — e parece que o cadastro sumiu.",
    img: "/guias/pagamento-1.png",
    alt: "Menu Cobrança e pagamentos com Formas de pagamento selecionado",
    dica: "No menu lateral: Cobrança e pagamentos → Formas de pagamento",
  },
  {
    titulo: "Adicione a forma de pagamento da empresa",
    texto:
      "Clique em Adicionar no bloco “Adicionar forma de pagamento da empresa”. Se pedir para atribuir um editor financeiro, escolha “Atribuir a mim” e avance.",
    img: "/guias/pagamento-2.png",
    alt: "Bloco Adicionar forma de pagamento da empresa com o botão Adicionar",
  },
  {
    titulo: "Escolha Brasil e Real brasileiro",
    texto:
      "Selecione o país Brasil e a moeda Real brasileiro. Se você chegar por outro caminho (o atalho que aparece logo depois de conectar o número), o Real não aparece na lista de moedas — só por aqui.",
    img: "/guias/pagamento-3.png",
    alt: "Lista de moedas com Real brasileiro selecionado",
    alerta:
      "A moeda não pode ser alterada depois. Em dólar, seu custo por mensagem varia com o câmbio.",
  },
  {
    titulo: "Cadastre o cartão",
    texto:
      "Informe um cartão de crédito ou débito. A Meta vai cobrar por mensagem entregue — é a cobrança dela, separada da sua assinatura do Zaplane.",
    img: "/guias/pagamento-4.png",
    alt: "Tela final com Brasil, Real brasileiro e cartão de crédito ou débito",
  },
];

function Figura({ src, alt }) {
  const [falhou, setFalhou] = useState(false);
  if (falhou) return null;
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFalhou(true)}
      className="mt-3 w-full rounded-lg border border-zinc-200 bg-white dark:border-zinc-700"
    />
  );
}

export default function GuiaPagamentoMeta({ canal, onClose }) {
  // Esc fecha (mesmo comportamento dos outros modais do painel)
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-zinc-900/60 p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white dark:bg-zinc-900 sm:max-w-lg sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">
              Cadastrar a forma de pagamento na Meta
            </h2>
            <p className="mt-0.5 text-[12px] text-zinc-500 dark:text-zinc-400">
              {canal?.displayNumber || canal?.label
                ? `Para o número ${canal.displayNumber || canal.label}`
                : "Leva cerca de 2 minutos"}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Fechar"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 sm:h-8 sm:w-8"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <p className="text-[13px] leading-snug text-zinc-600 dark:text-zinc-300">
            A Meta cobra você diretamente por mensagem entregue. Sem um cartão cadastrado, os envios
            funcionam por um período inicial e depois são bloqueados por ela — não pelo Zaplane.
          </p>

          {PASSOS.map((p, i) => (
            <div key={i} className="border-t border-zinc-100 pt-4 first:border-0 first:pt-0 dark:border-zinc-800">
              <div className="flex items-baseline gap-2">
                <span className="shrink-0 text-[11px] font-bold tabular-nums text-[#0F8C5A] dark:text-emerald-400">
                  {i + 1}
                </span>
                <h3 className="text-[13px] font-semibold text-zinc-900 dark:text-white">{p.titulo}</h3>
              </div>
              <p className="mt-1 pl-5 text-[13px] leading-snug text-zinc-600 dark:text-zinc-300">{p.texto}</p>

              {p.dica && (
                <p className="mt-1.5 pl-5 text-[12px] text-zinc-400">{p.dica}</p>
              )}

              {p.alerta && (
                <p className="mt-2 ml-5 inline-flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[12px] leading-snug text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {p.alerta}
                </p>
              )}

              <div className="pl-5">
                <Figura src={p.img} alt={p.alt} />
              </div>
            </div>
          ))}
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t border-zinc-100 px-5 py-4 dark:border-zinc-800 sm:flex-row sm:items-center">
          <a
            href="https://business.facebook.com/billing_hub/payment_methods"
            target="_blank" rel="noopener noreferrer"
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3.5 py-2.5 text-[13px] font-semibold text-white hover:opacity-90 sm:flex-none sm:py-2"
            style={{ backgroundColor: "#0F8C5A" }}
          >
            <CreditCard className="h-3.5 w-3.5" /> Abrir na Meta
            <ExternalLink className="h-3 w-3" />
          </a>
          <button
            onClick={onClose}
            className="inline-flex flex-1 items-center justify-center rounded-xl border border-zinc-200 px-3.5 py-2.5 text-[13px] font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800 sm:flex-none sm:py-2"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}

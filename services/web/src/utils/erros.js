// Tradução de erro HTTP do gateway → mensagem pt-BR que o cliente entende.
//
// Um lugar só, de propósito: antes, cada tela tinha o próprio
// `mensagem402(e) || e.message`, e todo status novo do backend (403 da cota
// diária, 429 do rate limit, 503 da conexão assistida) escapava pelo
// `e.message` — que é literalmente `HTTP 403 — {"message":...}`, o corpo cru
// na cara de quem só queria mandar uma campanha. Status novo agora se resolve
// aqui, e todas as telas ganham junto.
import { mensagem402 } from "./billing.js";

const GENERICA = "Não foi possível concluir. Tente de novo em instantes.";

// Status em que o texto do servidor NUNCA serve ao cliente: o próprio NestJS
// responde em inglês e com jargão ("Internal server error", e o throttler manda
// "ThrottlerException: Too many requests"). Aqui o texto do painel substitui o
// do servidor — não é o caso do 403/409/400, onde a mensagem já vem escrita
// para o cliente e é melhor que qualquer coisa que a tela invente.
const TEXTO_DO_PAINEL = {
  429: "Você tentou várias vezes seguidas. Aguarde cerca de um minuto e tente de novo.",
  500: "Tivemos um problema do nosso lado. Tente de novo em instantes — se continuar, fale com o suporte.",
  502: "O servidor não respondeu. Tente de novo em instantes.",
  504: "O servidor demorou demais para responder. Tente de novo em instantes.",
};

// Reserva para quando o status costuma trazer mensagem própria, mas neste caso
// não veio nenhuma (proxy respondendo HTML, servidor fora do ar).
const RESERVA = {
  403: "Você não tem permissão para esta ação.",
  503: "O serviço está temporariamente indisponível. Tente de novo em alguns minutos.",
};

// Mensagem escrita pelo servidor. `message` do NestJS é string na maioria das
// exceções (BadRequest/Forbidden/Conflict/ServiceUnavailable com texto nosso) e
// ARRAY quando quem falhou foi a validação do class-validator — nesse caso são
// mensagens técnicas em inglês, que não vão para a tela de jeito nenhum.
function textoDoServidor(err) {
  const msg = err?.body?.message;
  if (Array.isArray(msg)) return "Confira os dados informados e tente de novo.";
  if (typeof msg === "string" && msg.trim()) return msg.trim();
  return null;
}

/**
 * @param {any} err erro lançado pelo client.js (tem .status e .body)
 * @param {string} [alternativa] texto da própria tela quando não há nada melhor
 * @returns {string} sempre uma frase em português — nunca JSON, nunca inglês
 */
export function mensagemErro(err, alternativa) {
  if (!err) return alternativa || GENERICA;

  // 402 primeiro: é o único que enriquece a resposta com saldo/valor devido.
  const billing = mensagem402(err);
  if (billing) return billing;

  const doPainel = TEXTO_DO_PAINEL[err.status];
  if (doPainel) return doPainel;

  const doServidor = textoDoServidor(err);
  if (doServidor) return doServidor;

  return RESERVA[err.status] || alternativa || GENERICA;
}

// Tradução de erros HTTP 402 (bloqueio de billing) do gateway em mensagens
// pt-BR acionáveis. Usado em qualquer fluxo pago: criação de campanha e
// envio avulso (ver spec §5/§7 — SubscriptionGuard + checagem de saldo).
import { formatBRL } from "./money.js";

// Retorna a mensagem pt-BR para o erro, ou null se `err` não for um 402
// reconhecido (o chamador cai de volta em err.message nesse caso).
export function mensagem402(err) {
  if (!err || err.status !== 402) return null;
  const body = err.body || {};
  if (body.code === "SUBSCRIPTION_INACTIVE") {
    return "Assinatura inativa — ative em Configurações → Plano & billing para poder enviar.";
  }
  if (body.code === "INSUFFICIENT_CREDITS") {
    const precisa = formatBRL(body.needed ?? 0);
    const saldo = formatBRL(body.balance ?? 0);
    return `Créditos insuficientes (precisa ${precisa}, saldo ${saldo}) — compre créditos em Configurações → Plano & billing.`;
  }
  return body.message || "Ação bloqueada por billing — verifique Configurações → Plano & billing.";
}

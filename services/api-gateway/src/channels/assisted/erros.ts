/** Catálogo de mensagens do fluxo de conexão assistida.
 *
 *  O erro cru da Meta NUNCA chega ao cliente: ele transformaria a rota num
 *  oráculo de enumeração — daria para descobrir quais números já são clientes.
 *  "Número em uso" e "número inválido" respondem a MESMA coisa, de propósito.
 *  O código real vai só para o log do servidor e para audit_logs (spec §8). */
export const ERROS_CONEXAO = {
  numero_indisponivel:
    'Não foi possível usar este número. Verifique se ele não tem WhatsApp ativo.',
  sms_limite: 'Aguarde alguns minutos para pedir um novo código.',
  capacidade: 'Estamos com a capacidade cheia. Nossa equipe entra em contato.',
  generico: 'Não foi possível concluir agora. Tente novamente em alguns minutos.',
  // Requisição de verificação sem código, com a verificação ainda PENDENTE.
  // Não é erro da Meta (nem chegamos a falar com ela): é a tela pedindo o
  // registro cedo demais. Por isso o texto pode ser direto — ele não conta
  // nada sobre o número, então não abre o oráculo que o resto do catálogo fecha.
  codigo_obrigatorio: 'Digite o código de 6 dígitos que enviamos por SMS.',
} as const;

/** Limite de vazão / cota — vale a pena tentar de novo mais tarde. */
const LIMITE = new Set([4, 80007, 130429, 131048]);

/** Número indisponível: já em uso, inválido, ou com WhatsApp ativo. */
const INDISPONIVEL = new Set([100, 133005, 133006, 133008, 133009, 136024]);

export function mensagemParaCliente(codigoMeta: number | null | undefined): string {
  if (typeof codigoMeta !== 'number') return ERROS_CONEXAO.generico;
  if (LIMITE.has(codigoMeta)) return ERROS_CONEXAO.sms_limite;
  if (INDISPONIVEL.has(codigoMeta)) return ERROS_CONEXAO.numero_indisponivel;
  return ERROS_CONEXAO.generico;
}

export function codigoIncorreto(restantes: number): string {
  return `Código incorreto. ${restantes} tentativa(s) restante(s).`;
}

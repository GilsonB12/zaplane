/**
 * Classificação dos códigos de erro da Meta — espelho de
 * services/dispatcher/internal/whatsapp/client.go.
 *
 * Existe porque a Meta reprova um envio por DOIS caminhos diferentes:
 *
 *  1. SÍNCRONO — a chamada `POST /{pnid}/messages` já volta com erro. Quem
 *     trata é o dispatcher (Go), que classifica e pausa o canal.
 *
 *  2. ASSÍNCRONO — a chamada devolve 200 com o `wamid`, e o erro chega depois
 *     num webhook de status `failed`. Foi assim que o 131042 (WABA sem moeda
 *     configurada) apareceu em produção: a mensagem virou `sent` e, cinco
 *     segundos depois, `failed`.
 *
 * O caminho 2 não passava por classificação nenhuma — o webhook só gravava o
 * erro e contava a falha. Numa fila de 5.000 mensagens com a conta mal
 * configurada, as 5.000 seriam marcadas como falha definitiva, uma a uma, sem
 * pausar o canal: exatamente o bug que a classificação do dispatcher existe
 * para impedir, entrando por outra porta.
 *
 * Manter as duas listas em sincronia. Se um código for acrescentado lá, tem
 * que vir para cá também.
 */

/** Limite de vazão/cota do canal — costuma liberar sozinho. */
const LIMITE_DE_VAZAO = new Set([
  4, // Application request limit reached
  80007, // Rate limit issues (nível da WABA)
  130429, // Cloud API message throughput reached
  131048, // Spam rate limit hit
]);

/**
 * Credencial ou estado da CONTA: repetir não resolve, mas a fila não pode ser
 * queimada — o operador corrige (troca o token, vincula o cartão, configura a
 * moeda) e as mensagens seguem.
 */
const CONTA_OU_CREDENCIAL = new Set([
  190, // token expirado ou inválido
  200, // permissão faltando
  10, // permissão negada
  131031, // conta comercial bloqueada/restrita
  368, // bloqueada temporariamente por violação de política
  131042, // problema de elegibilidade/pagamento — bloqueia TODO envio da conta
  130497, // WABA restrita para enviar ao país do destinatário
  131045, // erro de registro do número (certificado/PIN)
  133010, // número não registrado na plataforma
]);

export type ClasseErroMeta = 'ratelimit' | 'conta' | 'mensagem';

/** Classifica o código que veio no webhook de status `failed`. */
export function classificarErroMeta(code: number | null | undefined): ClasseErroMeta {
  if (typeof code !== 'number') return 'mensagem';
  if (LIMITE_DE_VAZAO.has(code)) return 'ratelimit';
  if (CONTA_OU_CREDENCIAL.has(code)) return 'conta';
  // Demais códigos são problema da própria mensagem (template inexistente,
  // número que não recebe, janela de 24h fechada). Repetir só gastaria cota.
  return 'mensagem';
}

/** Erro do CANAL, não da mensagem: exige pausar em vez de falhar a fila. */
export function bloqueiaCanal(classe: ClasseErroMeta): boolean {
  return classe === 'ratelimit' || classe === 'conta';
}

/** Frase que o painel exibe — os campos alert_* já são renderizados lá. */
export function alertaLegivel(code: number, detalhe?: string | null): string {
  switch (code) {
    case 131042:
      return 'Envios pausados: a Meta recusou a cobrança desta conta. Verifique se há forma de pagamento e moeda configuradas no Gerenciador de Negócios.';
    case 190:
    case 200:
    case 10:
      return 'Envios pausados: a credencial deste número expirou ou perdeu permissão. Reconecte o canal.';
    case 131031:
    case 368:
      return 'Envios pausados: a Meta restringiu esta conta. Verifique a qualidade e as políticas no Gerenciador de Negócios.';
    case 130497:
      return 'Envios pausados: esta conta não tem permissão da Meta para enviar ao país do destinatário.';
    case 131045:
    case 133010:
      return 'Envios pausados: o registro deste número na Meta está incompleto. Reconecte o canal.';
    default:
      return `Envios pausados por um problema na conta da Meta${detalhe ? ': ' + detalhe : '.'}`;
  }
}

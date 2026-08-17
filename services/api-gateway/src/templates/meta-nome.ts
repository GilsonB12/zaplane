/** Nome do template na Meta.
 *
 *  O nome é único na WABA, não por organização. Sem prefixo, dois clientes não
 *  podem ter "promoção" — e o erro de nome duplicado da Meta entrega que o
 *  template do outro existe, reabrindo pelo lado dos templates o oráculo de
 *  enumeração que o catálogo `erros.ts` fecha na conexão.
 *
 *  O prefixo sai do ID da organização, não do slug: slug muda quando o cliente
 *  renomeia a empresa, e a Meta não aceita hífen em nome de template. */

/** Prefixo dos templates genéricos da Zaplane. 7 caracteres — o da organização
 *  tem sempre 9, então os dois nunca colidem. */
export const PREFIXO_PLATAFORMA = 'zaplane';

const MAX_SUFIXO = 200;

export class NomeInvalidoError extends Error {
  constructor(nome: string) {
    super(`Nome de template inválido: "${nome}"`);
    this.name = 'NomeInvalidoError';
  }
}

/** `z` + 8 caracteres hexadecimais do UUID. O `z` inicial evita nome começando
 *  por dígito e marca o template como gerado pela Zaplane. Valida a entrada: só
 *  aceita strings com pelo menos 8 caracteres hexadecimais para garantir que o
 *  resultado tem sempre 9 caracteres de [a-z0-9] e nunca colide com
 *  PREFIXO_PLATAFORMA (7 caracteres). */
export function prefixoDaOrg(orgId: string): string {
  // Extrai só caracteres hexadecimais (0-9, a-f) do UUID
  const hex = (orgId ?? '').toLowerCase().match(/[0-9a-f]/g) || [];

  // Exige pelo menos 8 caracteres hexadecimais; falha fechado se não tiver
  if (hex.length < 8) {
    throw new NomeInvalidoError(`ID de organização inválido: "${orgId}"`);
  }

  // Retorna z + 8 primeiros caracteres hexadecimais
  return 'z' + hex.slice(0, 8).join('');
}

/** A Meta só aceita `[a-z0-9_]`. */
export function normalizarNome(nome: string): string {
  const semAcento = (nome ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const limpo = semAcento
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_SUFIXO)
    .replace(/_+$/g, '');
  if (!limpo) throw new NomeInvalidoError(nome);
  return limpo;
}

export function metaNomeDaOrg(orgId: string, nomeExibicao: string): string {
  return `${prefixoDaOrg(orgId)}_${normalizarNome(nomeExibicao)}`;
}

export function metaNomeDaPlataforma(nomeExibicao: string): string {
  return `${PREFIXO_PLATAFORMA}_${normalizarNome(nomeExibicao)}`;
}

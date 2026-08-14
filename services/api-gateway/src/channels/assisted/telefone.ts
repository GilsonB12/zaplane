/** Normalização de telefone brasileiro para o formato que a Meta espera.
 *
 *  A Meta recebe `cc` separado do resto. O formato do assinante é PONTO EM
 *  ABERTO (spec §4): o único número que testamos é antigo e ela o guarda sem o
 *  nono dígito. Por isso devolvemos as duas variantes — quem chama tenta a
 *  primeira e cai na segunda se a Meta recusar por parâmetro. */
export class TelefoneInvalidoError extends Error {
  constructor() {
    super('telefone_invalido');
  }
}

export type TelefoneBR = {
  cc: string;
  /** DDD + 9 dígitos, ex.: 85999999999 */
  nacional: string;
  /** DDD + 8 dígitos (sem o nono), ex.: 8599999999 */
  semNono: string;
  /** +5585999999999 */
  e164: string;
  /** para mascarar na UI */
  ultimos4: string;
};

export function normalizarTelefoneBR(entrada: string): TelefoneBR {
  const digitos = (entrada || '').replace(/\D/g, '');
  // só tira o 55 quando sobra número demais para ser DDD+assinante
  const sem55 = digitos.startsWith('55') && digitos.length > 11 ? digitos.slice(2) : digitos;
  if (sem55.length < 10 || sem55.length > 11) throw new TelefoneInvalidoError();

  const ddd = sem55.slice(0, 2);
  const assinante = sem55.slice(2);
  const comNono = assinante.length === 8 ? '9' + assinante : assinante;
  const semNono =
    assinante.length === 9 && assinante.startsWith('9') ? assinante.slice(1) : assinante;

  return {
    cc: '55',
    nacional: ddd + comNono,
    semNono: ddd + semNono,
    e164: '+55' + ddd + comNono,
    ultimos4: assinante.slice(-4),
  };
}

/** (85) 9••••-••99 — o que a UI mostra na tela do código. */
export function mascarar(ddd: string, ultimos4: string): string {
  return `(${ddd}) 9••••-••${ultimos4.slice(-2)}`;
}

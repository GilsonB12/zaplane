// Validação e normalização de CPF (11 díg.) e CNPJ (14 díg.) brasileiros,
// incluindo os dígitos verificadores. Usado no billing: o Asaas exige um
// CPF/CNPJ VÁLIDO do pagador ao criar o customer em produção — um documento
// mal digitado é rejeitado pelo provedor, então validamos antes de enviar.

/** Remove tudo que não for dígito. Retorna null se sobrar vazio. */
export function normalizeTaxId(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D+/g, '');
  return digits.length > 0 ? digits : null;
}

function allSameDigit(s: string): boolean {
  return /^(\d)\1*$/.test(s);
}

/** CPF: 11 dígitos, com os 2 dígitos verificadores corretos. */
function isValidCpf(cpf: string): boolean {
  if (cpf.length !== 11 || allSameDigit(cpf)) return false;
  // Dígito verificador: soma(díg_i * peso_i) mod 11; resto < 2 => 0, senão 11 - resto.
  const check = (len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return check(9) === Number(cpf[9]) && check(10) === Number(cpf[10]);
}

/** CNPJ: 14 dígitos, com os 2 dígitos verificadores corretos. */
function isValidCnpj(cnpj: string): boolean {
  if (cnpj.length !== 14 || allSameDigit(cnpj)) return false;
  const weights12 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const weights13 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const check = (len: number): number => {
    const weights = len === 12 ? weights12 : weights13;
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cnpj[i]) * weights[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return check(12) === Number(cnpj[12]) && check(13) === Number(cnpj[13]);
}

/** true se `digits` (somente dígitos) for um CPF (11) OU CNPJ (14) válido. */
export function isValidTaxId(digits: string): boolean {
  if (digits.length === 11) return isValidCpf(digits);
  if (digits.length === 14) return isValidCnpj(digits);
  return false;
}

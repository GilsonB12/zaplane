// Helpers de variáveis de template ({{1}}, {{2}}…) — usados pelo wizard de
// campanha e pelo modal de mensagem avulsa.

// Extrai os números das variáveis {{1}}, {{2}}… do corpo (únicos, ordenados).
export function extrairVariaveis(corpo) {
  const nums = new Set();
  for (const m of (corpo ?? "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b);
}

// Trecho do corpo ao redor da variável — mostra ONDE ela cai no texto.
export function contextoDaVariavel(corpo, n) {
  const re = new RegExp(`\\{\\{\\s*${n}\\s*\\}\\}`);
  const m = re.exec(corpo ?? "");
  if (!m) return "";
  const ini = Math.max(0, m.index - 20);
  const fim = Math.min(corpo.length, m.index + m[0].length + 20);
  const antes = (ini > 0 ? "…" : "") + corpo.slice(ini, m.index);
  const depois = corpo.slice(m.index + m[0].length, fim) + (fim < corpo.length ? "…" : "");
  return `${antes}___${depois}`.replace(/\s+/g, " ").trim();
}

// Substitui as variáveis para a prévia: valor digitado; {{name}} → «nome do
// contato» (dinâmico); vazia → ⟦variável N⟧ (pendência, destacada no balão).
export function preencherCorpo(corpo, vars, valores) {
  let out = corpo ?? "";
  for (const n of vars) {
    const v = (valores[n] ?? "").trim();
    const texto = v === "{{name}}" ? "«nome do contato»" : v || `⟦variável ${n}⟧`;
    // função de substituição → trata `texto` como literal (evita $&, $$ etc.)
    out = out.replace(new RegExp(`\\{\\{\\s*${n}\\s*\\}\\}`, "g"), () => texto);
  }
  return out;
}

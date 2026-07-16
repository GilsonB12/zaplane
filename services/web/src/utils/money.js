// Formatação de valores monetários (centavos → BRL) — usado no painel de
// billing e em qualquer tela que exiba custo Meta / taxa Zaplane.

// Centavos → "R$ 135,00". Aceita null/undefined/NaN como 0.
export function formatBRL(cents) {
  const value = (Number(cents) || 0) / 100;
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

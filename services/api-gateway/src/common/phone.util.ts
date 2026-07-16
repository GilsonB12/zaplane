// Normalização do 9º dígito brasileiro.
//
// Celulares BR registrados no WhatsApp antes da migração do nono dígito têm
// wa_id SEM o 9 (+55 DD XXXXXXXX, 8 dígitos de assinante começando em 6-9).
// O número real tem o 9 — então normalizamos ADICIONANDO o 9, garantindo que
// inbound, contatos e envios usem o mesmo formato (+55 DD 9XXXXXXXX).
// Fixos (assinante começando em 2-5) e números já com 9 passam intactos.
export function normalizeBrPhone(e164: string): string {
  const m = /^\+55(\d{2})([6-9]\d{7})$/.exec(e164);
  return m ? `+55${m[1]}9${m[2]}` : e164;
}

// Interface do provedor de pagamento (B3 — Asaas). Mantém o BillingService
// desacoplado do provedor concreto: trocar de Asaas para outro (Mercado Pago,
// Stripe etc.) no futuro = escrever outra classe que implemente esta
// interface e apontar o factory em billing.module.ts para ela — nenhuma
// mudança em billing.service.ts/controller.

/** Token de injeção do adaptador ativo (ver billing.module.ts). */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export interface OrgCustomerInput {
  /** organization_id — usado como externalReference no provedor p/ resolver
   *  a organização a partir de um webhook (payment.externalReference). */
  id: string;
  name: string;
  email?: string | null;
  /** CPF/CNPJ do responsável pela cobrança. Ainda não coletamos isso no
   *  cadastro da organização — o adaptador usa um placeholder válido em
   *  sandbox quando ausente (ver asaas.provider.ts). Coleta real de
   *  CPF/CNPJ é produto futuro. */
  cpfCnpj?: string | null;
}

export interface CreateCustomerResult {
  providerCustomerId: string;
}

export interface CreateSubscriptionInput {
  customerId: string;
  priceCents: number;
  orgId: string;
}

export interface CreateSubscriptionResult {
  providerSubscriptionId: string;
  /** id da 1ª cobrança gerada pela assinatura, se o provedor já a expôs no
   *  momento da criação (Asaas cria a 1ª cobrança de forma síncrona). */
  providerPaymentId: string | null;
  /** link de pagamento (Pix/boleto/cartão) da 1ª cobrança, para o painel
   *  redirecionar o usuário a pagar. */
  paymentUrl: string | null;
  dueDate: string | null;
}

export interface CreateChargeInput {
  customerId: string;
  amountCents: number;
  orgId: string;
  description: string;
}

export interface CreateChargeResult {
  providerPaymentId: string;
  paymentUrl: string | null;
  dueDate: string;
}

export type NormalizedEventType =
  | 'payment_confirmed'
  | 'payment_overdue'
  | 'subscription_canceled'
  | 'other';

export interface NormalizedEvent {
  type: NormalizedEventType;
  /** organization_id, quando o provedor devolve o externalReference no
   *  payload. Pode ser null (ex.: renovação de assinatura cujo payment
   *  individual não carregou o externalReference) — nesse caso quem chama
   *  normalizeEvent precisa resolver por providerSubscriptionId/providerPaymentId. */
  orgId: string | null;
  providerPaymentId: string | null;
  providerSubscriptionId: string | null;
  amountCents: number | null;
  /** chave de idempotência do evento — usada em subscription_events.provider_event_id
   *  (UNIQUE por provider). Preferimos o id do evento quando o provedor manda um;
   *  senão montamos a partir de event+payment.id+status. */
  idempotencyKey: string;
  raw: any;
}

export interface PaymentProviderAdapter {
  createCustomer(org: OrgCustomerInput): Promise<CreateCustomerResult>;
  createSubscription(input: CreateSubscriptionInput): Promise<CreateSubscriptionResult>;
  createCharge(input: CreateChargeInput): Promise<CreateChargeResult>;
  /** Valida a autenticidade do webhook (ex.: header de token do Asaas) —
   *  comparação em tempo constante (timingSafeEqual). */
  verifyWebhook(headers: Record<string, string | string[] | undefined>): boolean;
  normalizeEvent(body: any): NormalizedEvent;
}

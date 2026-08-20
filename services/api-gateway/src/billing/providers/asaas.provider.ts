import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { ASAAS_WEBHOOK_TOKEN_PLACEHOLDER } from '../../config/configuration';
import {
  CreateChargeInput,
  CreateChargeResult,
  CreateCustomerResult,
  CreateSubscriptionInput,
  CreateSubscriptionResult,
  NormalizedEvent,
  NormalizedEventType,
  OrgCustomerInput,
  PaymentProviderAdapter,
  PaymentStatusResult,
} from './payment-provider.interface';

// CPF de teste válido (formato correto p/ passar a validação de dígito
// verificador do sandbox Asaas). Usado só quando a organização ainda não tem
// CPF/CNPJ cadastrado — coleta real de CPF/CNPJ é produto futuro (o painel
// hoje não pede isso no cadastro da org).
const SANDBOX_PLACEHOLDER_CPF = '24971563792';

function centsToReais(cents: number): number {
  // Math.round evita drift de ponto flutuante (ex.: 43 centavos -> 0.43, não
  // 0.42999999999999994) antes de mandar pro Asaas, que espera reais (float).
  return Math.round(cents) / 100;
}

function reaisToCents(reais: number): number {
  return Math.round(reais * 100);
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setDate(copy.getDate() + days);
  return copy;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Implementação do PaymentProviderAdapter via REST do Asaas
 * (https://sandbox.asaas.com/api/v3 em homologação). Autenticação por header
 * `access_token`. Valores no Asaas são em REAIS (float) — todo o cents<->reais
 * acontece só aqui, o resto do billing (banco, service, controller) só
 * conhece centavos (Int).
 *
 * IMPORTANTE: a API key nunca é logada. Erros são resumidos (status HTTP +
 * corpo da resposta do Asaas), nunca o objeto de erro/config completo do
 * axios (que carregaria os headers da requisição, incluindo access_token).
 */
@Injectable()
export class AsaasProvider implements PaymentProviderAdapter {
  private readonly logger = new Logger('AsaasProvider');
  private readonly http: AxiosInstance;
  private readonly webhookToken: string;

  constructor(private readonly config: ConfigService) {
    const baseURL = this.config.get<string>('billing.asaas.baseUrl');
    const apiKey = this.config.get<string>('billing.asaas.apiKey');
    this.webhookToken = this.config.get<string>('billing.asaas.webhookToken') ?? '';

    this.assertWebhookTokenIsSafe();

    this.http = axios.create({
      baseURL,
      timeout: 15_000,
      headers: {
        access_token: apiKey,
        'Content-Type': 'application/json',
      },
    });
  }

  // Fix C1 (review B3, parte 1 — "fail closed on weak token"): um
  // ASAAS_WEBHOOK_TOKEN vazio ou igual ao placeholder documentado no
  // .env.example tornaria a validação do webhook (verifyWebhook) inútil —
  // qualquer request com esse valor conhecido/óbvio passaria. Em produção,
  // recusamos subir a aplicação; em dev, apenas avisamos alto (o re-fetch do
  // Fix C1 parte 2 ainda protege o dinheiro mesmo com token fraco).
  private assertWebhookTokenIsSafe(): void {
    const isEmpty = this.webhookToken.length === 0;
    const isPlaceholder = this.webhookToken === ASAAS_WEBHOOK_TOKEN_PLACEHOLDER;
    if (!isEmpty && !isPlaceholder) return;

    const nodeEnv = this.config.get<string>('env');
    const reason = isEmpty ? 'está vazio' : 'é igual ao placeholder público do .env.example';
    const message =
      `[SEGURANÇA] ASAAS_WEBHOOK_TOKEN ${reason}. Um webhook forjado (token adivinhado/vazado) ` +
      `poderia tentar creditar dinheiro em qualquer organização. Defina um valor forte e único.`;

    if (nodeEnv === 'production') {
      throw new Error(`${message} Recusando iniciar em produção.`);
    }
    this.logger.warn(
      `${message} Permitido em ambiente "${nodeEnv ?? 'development'}" apenas para desenvolvimento — NUNCA suba assim para produção.`,
    );
  }

  async createCustomer(org: OrgCustomerInput): Promise<CreateCustomerResult> {
    // Em produção o Asaas exige CPF/CNPJ válido do pagador; NÃO usamos o
    // placeholder de sandbox aqui (o billing.service já valida/exige antes —
    // esta é a defesa em profundidade). Em dev/homologação, cai no placeholder.
    const isProd = this.config.get<string>('env') === 'production';
    const cpfCnpj = org.cpfCnpj || (isProd ? null : SANDBOX_PLACEHOLDER_CPF);
    if (!cpfCnpj) {
      throw new BadRequestException({
        code: 'TAX_ID_REQUIRED',
        message: 'CPF/CNPJ do responsável é obrigatório em produção para criar o cliente no provedor.',
      });
    }
    const payload = {
      name: org.name,
      cpfCnpj,
      email: org.email || undefined,
      // O painel é quem entrega o link de pagamento (paymentUrl); a notificação
      // do Asaas é redundante e custa R$ 0,99 de "taxa de mensageria" por fatura.
      notificationDisabled: true,
      externalReference: org.id,
    };
    const { data } = await this.call(() => this.http.post('/customers', payload), 'createCustomer');
    return { providerCustomerId: data.id };
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<CreateSubscriptionResult> {
    const nextDueDate = formatDate(addDays(new Date(), 1));
    const payload = {
      customer: input.customerId,
      billingType: 'UNDEFINED', // deixa o pagador escolher Pix/boleto/cartão
      value: centsToReais(input.priceCents),
      nextDueDate,
      cycle: 'MONTHLY',
      description: 'Assinatura mensal Zaplane',
      externalReference: input.orgId,
    };
    const { data } = await this.call(() => this.http.post('/subscriptions', payload), 'createSubscription');

    // O Asaas gera a 1ª cobrança de forma síncrona à criação da assinatura,
    // mas ela não vem no corpo da resposta de /subscriptions — precisa
    // buscar em /payments?subscription=<id>. Pequeno retry por eventual
    // consistência do lado do provedor.
    const firstPayment = await this.fetchFirstPayment(data.id);

    return {
      providerSubscriptionId: data.id,
      providerPaymentId: firstPayment?.id ?? null,
      paymentUrl: firstPayment?.invoiceUrl ?? null,
      dueDate: firstPayment?.dueDate ?? nextDueDate,
    };
  }

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const dueDate = formatDate(addDays(new Date(), 1));
    const payload = {
      customer: input.customerId,
      billingType: 'UNDEFINED',
      value: centsToReais(input.amountCents),
      dueDate,
      description: input.description,
      externalReference: input.orgId,
    };
    const { data } = await this.call(() => this.http.post('/payments', payload), 'createCharge');
    return {
      providerPaymentId: data.id,
      paymentUrl: data.invoiceUrl ?? null,
      dueDate,
    };
  }

  // Fix C1 (review B3, parte 2 — a defesa real): re-consulta o pagamento
  // diretamente na API do Asaas em vez de confiar no corpo do webhook. Um
  // evento PAYMENT_CONFIRMED forjado (mesmo com o token de webhook correto,
  // vazado ou fraco) referenciando uma cobrança que o Asaas ainda reporta
  // como PENDING não passa por aqui como "confirmado". Retorna null em 404
  // (pagamento inexistente) — o chamador trata isso como "não verificado".
  async getPayment(providerPaymentId: string): Promise<PaymentStatusResult | null> {
    try {
      const { data } = await this.http.get(`/payments/${encodeURIComponent(providerPaymentId)}`);
      return {
        id: data.id,
        status: data.status,
        amountCents: typeof data.value === 'number' ? reaisToCents(data.value) : 0,
        providerSubscriptionId: data.subscription ?? null,
        orgId: data.externalReference ?? null,
        customerId: data.customer ?? null,
      };
    } catch (err) {
      const anyErr = err as { response?: { status?: number } };
      if (anyErr?.response?.status === 404) return null;
      this.logSanitizedError('getPayment', err);
      throw new HttpException(
        {
          code: 'PAYMENT_PROVIDER_ERROR',
          message: 'Falha ao comunicar com o provedor de pagamento (getPayment).',
        },
        502,
      );
    }
  }

  verifyWebhook(headers: Record<string, string | string[] | undefined>): boolean {
    if (!this.webhookToken) return false;
    const raw = headers['asaas-access-token'];
    const received = Array.isArray(raw) ? raw[0] : raw;
    if (!received) return false;

    const a = Buffer.from(received);
    const b = Buffer.from(this.webhookToken);
    // timingSafeEqual exige buffers do mesmo tamanho — comparar o tamanho
    // antes evita lançar exceção num header forjado com tamanho diferente
    // (e o retorno continua sendo "não autenticado" nesse caso).
    return a.length === b.length && timingSafeEqual(a, b);
  }

  normalizeEvent(body: any): NormalizedEvent {
    const eventName: string = body?.event ?? '';
    const payment = body?.payment ?? {};
    const providerPaymentId: string | null = payment?.id ?? null;
    const providerSubscriptionId: string | null = payment?.subscription ?? null;
    const orgId: string | null = payment?.externalReference ?? body?.externalReference ?? null;
    const amountCents = typeof payment?.value === 'number' ? reaisToCents(payment.value) : null;

    let type: NormalizedEventType = 'other';
    if (eventName === 'PAYMENT_CONFIRMED' || eventName === 'PAYMENT_RECEIVED') {
      type = 'payment_confirmed';
    } else if (eventName === 'PAYMENT_OVERDUE') {
      type = 'payment_overdue';
    } else if (/^SUBSCRIPTION_/.test(eventName) && /(CANCEL|DELET|INACTIV)/.test(eventName)) {
      type = 'subscription_canceled';
    }

    const idempotencyKey: string =
      body?.id ?? `${eventName}:${providerPaymentId ?? 'none'}:${payment?.status ?? 'none'}`;

    return { type, orgId, providerPaymentId, providerSubscriptionId, amountCents, idempotencyKey, raw: body };
  }

  private async fetchFirstPayment(
    subscriptionId: string,
  ): Promise<{ id: string; invoiceUrl: string | null; dueDate: string | null } | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { data } = await this.http.get('/payments', { params: { subscription: subscriptionId, limit: 1 } });
        const first = data?.data?.[0];
        if (first) return { id: first.id, invoiceUrl: first.invoiceUrl ?? null, dueDate: first.dueDate ?? null };
      } catch (err) {
        this.logSanitizedError('fetchFirstPayment', err);
      }
      if (attempt === 0) await sleep(600);
    }
    this.logger.warn(`Não encontrei a 1ª cobrança da assinatura ${subscriptionId} no Asaas após retry.`);
    return null;
  }

  private async call<T>(fn: () => Promise<T>, context: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.logSanitizedError(context, err);
      throw new HttpException(
        {
          code: 'PAYMENT_PROVIDER_ERROR',
          message: `Falha ao comunicar com o provedor de pagamento (${context}).`,
        },
        502,
      );
    }
  }

  // Loga só status HTTP + corpo da resposta do Asaas — nunca o erro/config
  // completo do axios, que carregaria os headers da requisição (access_token).
  private logSanitizedError(context: string, err: unknown): void {
    const anyErr = err as { response?: { status?: number; data?: unknown }; message?: string };
    const status = anyErr?.response?.status;
    const data = anyErr?.response?.data;
    this.logger.error(
      `Asaas[${context}]${status ? ` HTTP ${status}` : ''}: ${data ? JSON.stringify(data) : anyErr?.message ?? 'erro desconhecido'}`,
    );
  }
}

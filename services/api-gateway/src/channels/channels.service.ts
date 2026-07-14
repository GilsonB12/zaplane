import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { encrypt } from '../common/crypto.util';
import { TemplatesService } from '../templates/templates.service';
import { ConnectManualDto } from './dto/connect-manual.dto';
import { EsExchangeDto } from './dto/es-exchange.dto';

export interface Etapa {
  passo: string;
  ok: boolean;
  detalhe?: string;
}

const ESCOPOS_NECESSARIOS = ['whatsapp_business_messaging', 'whatsapp_business_management'];

@Injectable()
export class ChannelsService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private templates: TemplatesService,
  ) {}

  // GET /channels — campos whitelistados, nunca token/secret (spec §5.1)
  async list(orgId: string) {
    const channels = await this.prisma.whatsappChannel.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
    });
    return { items: channels.map((c) => this.toPublic(c)) };
  }

  // POST /channels/manual — pipeline a-g do spec §5.2
  async connectManual(orgId: string, dto: ConnectManualDto) {
    const version = this.config.get<string>('whatsapp.graphVersion')!;
    const etapas: Etapa[] = [];
    let tokenExpiraEm: string | undefined;

    // a. debug_token: token válido, com os escopos certos
    try {
      const info = await this.debugToken(dto.accessToken, dto.appId, dto.appSecret, version);
      if (!info?.is_valid) throw new Error('Token inválido ou expirado.');
      const escopos = new Set<string>([
        ...(info.scopes ?? []),
        ...((info.granular_scopes ?? []).map((g: any) => g?.scope).filter(Boolean)),
      ]);
      const faltantes = ESCOPOS_NECESSARIOS.filter((s) => !escopos.has(s));
      if (faltantes.length) {
        throw new Error(`Token sem os escopos necessários: ${faltantes.join(', ')}.`);
      }
      if (info.expires_at && info.expires_at > 0) {
        tokenExpiraEm = new Date(info.expires_at * 1000).toISOString();
      }
      etapas.push({
        passo: 'validar_token',
        ok: true,
        ...(tokenExpiraEm ? { detalhe: `Token expira em ${tokenExpiraEm}` } : {}),
      });
    } catch (e) {
      etapas.push({ passo: 'validar_token', ok: false, detalhe: extractErr(e) });
      throw new BadRequestException({
        ok: false,
        etapas,
        message: 'Falha ao validar o token de acesso na Meta.',
      });
    }

    // b. WABA acessível com o token
    let waba: { name?: string };
    try {
      waba = await this.fetchWaba(dto.accessToken, dto.wabaId, version);
      etapas.push({ passo: 'conferir_waba', ok: true, ...(waba.name ? { detalhe: waba.name } : {}) });
    } catch (e) {
      etapas.push({ passo: 'conferir_waba', ok: false, detalhe: extractErr(e) });
      throw new BadRequestException({
        ok: false,
        etapas,
        message: 'Não foi possível acessar a WABA informada com esse token.',
      });
    }

    // c. número acessível com o token — captura display/qualidade
    let phone: { displayNumber?: string; qualityRating?: string };
    try {
      phone = await this.fetchPhoneNumber(dto.accessToken, dto.phoneNumberId, version);
      etapas.push({
        passo: 'conferir_numero',
        ok: true,
        ...(phone.displayNumber ? { detalhe: phone.displayNumber } : {}),
      });
    } catch (e) {
      etapas.push({ passo: 'conferir_numero', ok: false, detalhe: extractErr(e) });
      throw new BadRequestException({
        ok: false,
        etapas,
        message: 'Não foi possível acessar o número informado com esse token.',
      });
    }

    // d. webhook do app do cliente (a Meta faz o handshake GET na hora) — exige
    // WEBHOOK_PUBLIC_URL configurada no gateway, senão a Meta não consegue nos chamar de volta
    const webhookPublicUrl = this.config.get<string>('webhookPublicUrl');
    if (!webhookPublicUrl) {
      etapas.push({
        passo: 'configurar_webhook',
        ok: false,
        detalhe: 'WEBHOOK_PUBLIC_URL não configurada no gateway.',
      });
      throw new BadRequestException({
        ok: false,
        etapas,
        message: 'Falha ao configurar o webhook do app na Meta.',
      });
    }
    try {
      await this.configureAppWebhook(dto.appId, dto.appSecret, version);
      etapas.push({ passo: 'configurar_webhook', ok: true });
    } catch (e) {
      etapas.push({ passo: 'configurar_webhook', ok: false, detalhe: extractErr(e) });
      throw new BadRequestException({
        ok: false,
        etapas,
        message: 'Falha ao configurar o webhook do app na Meta.',
      });
    }

    // e. inscreve o app do cliente na WABA
    try {
      await this.subscribeApp(dto.accessToken, dto.wabaId, version);
      etapas.push({ passo: 'inscrever_app', ok: true });
    } catch (e) {
      etapas.push({ passo: 'inscrever_app', ok: false, detalhe: extractErr(e) });
      throw new BadRequestException({
        ok: false,
        etapas,
        message: 'Falha ao inscrever o app na WABA.',
      });
    }

    // f. grava o canal — token e appSecret cifrados
    let channel;
    try {
      channel = await this.saveChannel(orgId, {
        label: dto.label,
        phoneNumberId: dto.phoneNumberId,
        wabaId: dto.wabaId,
        accessToken: dto.accessToken,
        appId: dto.appId,
        appSecret: dto.appSecret,
        connectedVia: 'manual',
        displayNumber: phone.displayNumber,
        qualityRating: phone.qualityRating,
      });
      etapas.push({ passo: 'salvar_canal', ok: true });
    } catch (e) {
      etapas.push({ passo: 'salvar_canal', ok: false, detalhe: extractErr(e) });
      throw new BadRequestException({ ok: false, etapas, message: 'Falha ao salvar o canal.' });
    }

    // g. templates.sync — best-effort, falha não desfaz o canal
    try {
      const sync = await this.templates.sync(orgId);
      etapas.push({ passo: 'sincronizar_templates', ok: !!sync?.synced, detalhe: sync?.note });
    } catch (e) {
      etapas.push({ passo: 'sincronizar_templates', ok: false, detalhe: extractErr(e) });
    }

    return {
      ok: true,
      etapas,
      ...(tokenExpiraEm ? { tokenExpiraEm } : {}),
      channel: this.toPublic(channel),
    };
  }

  // POST /channels/es/exchange — pipeline a-e do spec §5.3
  async esExchange(orgId: string, dto: EsExchangeDto) {
    const appId = this.config.get<string>('zaplane.appId');
    const appSecret = this.config.get<string>('zaplane.appSecret');
    if (!appSecret || !appId) {
      throw new ServiceUnavailableException(
        'Embedded Signup ainda não configurado: falta o App Secret do app Zaplane ' +
          '(ZAPLANE_FB_APP_SECRET). Use a conexão manual enquanto isso.',
      );
    }

    const version = this.config.get<string>('whatsapp.graphVersion')!;
    const etapas: Etapa[] = [];

    // a. troca o code do popup por um token de negócio do cliente
    let accessToken: string;
    try {
      const { data } = await axios.get(`https://graph.facebook.com/${version}/oauth/access_token`, {
        params: { client_id: appId, client_secret: appSecret, code: dto.code },
      });
      accessToken = data?.access_token;
      if (!accessToken) throw new Error('Resposta da Meta sem access_token.');
      etapas.push({ passo: 'trocar_code', ok: true });
    } catch (e) {
      etapas.push({ passo: 'trocar_code', ok: false, detalhe: extractErr(e) });
      throw new BadRequestException({
        ok: false,
        etapas,
        message: 'Falha ao trocar o código do Embedded Signup por um token.',
      });
    }

    // b. WABA acessível com o token novo
    let waba: { name?: string };
    try {
      waba = await this.fetchWaba(accessToken, dto.wabaId, version);
      etapas.push({ passo: 'conferir_waba', ok: true, ...(waba.name ? { detalhe: waba.name } : {}) });
    } catch (e) {
      etapas.push({ passo: 'conferir_waba', ok: false, detalhe: extractErr(e) });
      throw new BadRequestException({
        ok: false,
        etapas,
        message: 'Não foi possível acessar a WABA retornada pelo Embedded Signup.',
      });
    }

    // c. número acessível com o token novo
    let phone: { displayNumber?: string; qualityRating?: string };
    try {
      phone = await this.fetchPhoneNumber(accessToken, dto.phoneNumberId, version);
      etapas.push({
        passo: 'conferir_numero',
        ok: true,
        ...(phone.displayNumber ? { detalhe: phone.displayNumber } : {}),
      });
    } catch (e) {
      etapas.push({ passo: 'conferir_numero', ok: false, detalhe: extractErr(e) });
      throw new BadRequestException({
        ok: false,
        etapas,
        message: 'Não foi possível acessar o número retornado pelo Embedded Signup.',
      });
    }

    // d. inscreve o app Zaplane (o webhook do app é global, configurado uma vez)
    try {
      await this.subscribeApp(accessToken, dto.wabaId, version);
      etapas.push({ passo: 'inscrever_app', ok: true });
    } catch (e) {
      etapas.push({ passo: 'inscrever_app', ok: false, detalhe: extractErr(e) });
      throw new BadRequestException({
        ok: false,
        etapas,
        message: 'Falha ao inscrever o app Zaplane na WABA.',
      });
    }

    // e-parte1. grava o canal — sem app secret próprio (assinatura usa o secret global)
    let channel;
    try {
      channel = await this.saveChannel(orgId, {
        label: waba.name || 'WhatsApp conectado',
        phoneNumberId: dto.phoneNumberId,
        wabaId: dto.wabaId,
        accessToken,
        appId: appId ?? null,
        appSecret: null,
        connectedVia: 'embedded_signup',
        displayNumber: phone.displayNumber,
        qualityRating: phone.qualityRating,
      });
      etapas.push({ passo: 'salvar_canal', ok: true });
    } catch (e) {
      etapas.push({ passo: 'salvar_canal', ok: false, detalhe: extractErr(e) });
      throw new BadRequestException({ ok: false, etapas, message: 'Falha ao salvar o canal.' });
    }

    // e-parte2. templates.sync — best-effort
    try {
      const sync = await this.templates.sync(orgId);
      etapas.push({ passo: 'sincronizar_templates', ok: !!sync?.synced, detalhe: sync?.note });
    } catch (e) {
      etapas.push({ passo: 'sincronizar_templates', ok: false, detalhe: extractErr(e) });
    }

    return { ok: true, etapas, channel: this.toPublic(channel) };
  }

  // DELETE /channels/:id — desativa, não remove o histórico nem desinscreve na Meta
  async disconnect(orgId: string, id: string) {
    const channel = await this.prisma.whatsappChannel.findFirst({ where: { id, organizationId: orgId } });
    if (!channel) throw new NotFoundException('Canal não encontrado.');
    const updated = await this.prisma.whatsappChannel.update({
      where: { id },
      data: { status: 'disabled' },
    });
    return { ok: true, channel: this.toPublic(updated) };
  }

  // --- chamadas à Graph API (reaproveitadas pelos dois pipelines) ---

  private async debugToken(accessToken: string, appId: string, appSecret: string, version: string) {
    const { data } = await axios.get(`https://graph.facebook.com/${version}/debug_token`, {
      params: { input_token: accessToken, access_token: `${appId}|${appSecret}` },
    });
    return data?.data ?? {};
  }

  private async fetchWaba(token: string, wabaId: string, version: string) {
    const { data } = await axios.get(`https://graph.facebook.com/${version}/${wabaId}`, {
      params: { fields: 'id,name' },
      headers: { Authorization: `Bearer ${token}` },
    });
    return { name: data?.name as string | undefined };
  }

  private async fetchPhoneNumber(token: string, phoneNumberId: string, version: string) {
    const { data } = await axios.get(`https://graph.facebook.com/${version}/${phoneNumberId}`, {
      params: { fields: 'id,display_phone_number,quality_rating' },
      headers: { Authorization: `Bearer ${token}` },
    });
    return {
      displayNumber: data?.display_phone_number as string | undefined,
      qualityRating: data?.quality_rating as string | undefined,
    };
  }

  private async configureAppWebhook(appId: string, appSecret: string, version: string) {
    await axios.post(`https://graph.facebook.com/${version}/${appId}/subscriptions`, null, {
      params: {
        object: 'whatsapp_business_account',
        callback_url: this.config.get<string>('webhookPublicUrl'),
        verify_token: this.config.get<string>('whatsapp.webhookVerifyToken'),
        fields: 'messages',
        access_token: `${appId}|${appSecret}`,
      },
    });
  }

  private async subscribeApp(token: string, wabaId: string, version: string) {
    await axios.post(`https://graph.facebook.com/${version}/${wabaId}/subscribed_apps`, null, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  // grava/atualiza o canal (reconectar o mesmo phoneNumberId reativa em vez de duplicar —
  // a unique(organizationId, phoneNumberId) do schema rejeitaria um create duplicado)
  private async saveChannel(
    orgId: string,
    params: {
      label: string;
      phoneNumberId: string;
      wabaId: string;
      accessToken: string;
      appId: string | null;
      appSecret: string | null;
      connectedVia: string;
      displayNumber?: string;
      qualityRating?: string;
    },
  ) {
    const data = {
      label: params.label,
      phoneNumberId: params.phoneNumberId,
      wabaId: params.wabaId,
      displayNumber: params.displayNumber,
      qualityRating: params.qualityRating,
      accessTokenEnc: encrypt(params.accessToken),
      appId: params.appId,
      appSecretEnc: params.appSecret ? encrypt(params.appSecret) : null,
      connectedVia: params.connectedVia,
      status: 'active',
    };
    // upsert atômico — evita corrida entre a leitura (find) e a escrita (create/update)
    // quando duas requisições reconectam o mesmo phoneNumberId ao mesmo tempo.
    return this.prisma.whatsappChannel.upsert({
      where: { organizationId_phoneNumberId: { organizationId: orgId, phoneNumberId: params.phoneNumberId } },
      create: { organizationId: orgId, ...data },
      update: data,
    });
  }

  // nunca retorna accessTokenEnc/appSecretEnc — nem mascarado, simplesmente omitidos (spec §5.1)
  private toPublic(c: {
    id: string;
    label: string;
    displayNumber: string | null;
    phoneNumberId: string;
    wabaId: string;
    connectedVia: string;
    status: string;
    qualityRating: string | null;
    createdAt: Date;
  }) {
    return {
      id: c.id,
      label: c.label,
      displayNumber: c.displayNumber,
      phoneNumberId: c.phoneNumberId,
      wabaId: c.wabaId,
      connectedVia: c.connectedVia,
      status: c.status,
      qualityRating: c.qualityRating,
      createdAt: c.createdAt,
    };
  }
}

// extrai a mensagem de erro da Graph API sem vazar payloads sensíveis (token/secret nunca
// aparecem na resposta de erro da Meta, só na configuração da requisição)
function extractErr(e: any): string {
  return e?.response?.data?.error?.message ?? e?.message ?? String(e);
}

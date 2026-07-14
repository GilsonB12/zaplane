import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { QueryCampaignsDto } from './dto/query-campaigns.dto';

// Tarifas Meta — Brasil, por mensagem de template ENTREGUE (tabela vigente
// abr/2026, câmbio US$1=R$5). Valores em centavos de real; cobrança real é da
// Meta na entrega — isto é a ESTIMATIVA exibida antes do disparo.
// TODO futuro: tabela por país do destinatário (hoje assume BR).
const RATE_CENTS: Record<string, number> = {
  MARKETING: 31.25,      // R$ 0,3125
  UTILITY: 3.4,          // R$ 0,0340 (grátis dentro da janela de 24h)
  AUTHENTICATION: 3.4,   // R$ 0,0340
};

@Injectable()
export class CampaignsService {
  constructor(private prisma: PrismaService) {}

  async create(orgId: string, userId: string, dto: CreateCampaignDto) {
    // fallback: usa o canal ativo do org quando channelId não é informado
    const channel = await this.prisma.whatsappChannel.findFirst({
      where: dto.channelId
        ? { id: dto.channelId, organizationId: orgId, status: 'active' }
        : { organizationId: orgId, status: 'active' },
      // determinístico (oldest-first) quando houver mais de um canal ativo
      orderBy: { createdAt: 'asc' },
    });
    if (!channel) throw new NotFoundException('Canal WhatsApp não encontrado.');

    const template = await this.prisma.template.findFirst({
      where: { id: dto.templateId, organizationId: orgId },
    });
    if (!template) throw new NotFoundException('Template não encontrado.');
    if (template.status !== 'APPROVED') {
      throw new BadRequestException('Template ainda não aprovado pela Meta.');
    }

    // 1) resolve público bruto
    const audience = await this.resolveAudience(orgId, dto);

    // 2) supressão (LGPD + política): opt-out sempre; marketing exige consentimento
    const isMarketing = template.category === 'MARKETING';
    const eligible = audience.filter((c) => {
      if (c.optedOut) return false;
      if (isMarketing && c.consentStatus !== 'granted') return false;
      return true;
    });
    const suppressed = audience.length - eligible.length;

    // 3) cria a campanha
    // arredonda p/ centavo inteiro (tarifas têm fração de centavo; BigInt exige inteiro)
    const costEstimate = BigInt(Math.round(eligible.length * (RATE_CENTS[template.category] ?? 0)));
    const campaign = await this.prisma.campaign.create({
      data: {
        organizationId: orgId, channelId: channel.id, templateId: dto.templateId,
        name: dto.name, listId: dto.listId ?? null,
        audienceRule: (dto.audienceRule as any) ?? undefined,
        templateParams: (dto.templateParams as any) ?? {},
        status: dto.scheduledAt ? 'scheduled' : 'queuing',
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        totalRecipients: eligible.length, suppressedCount: suppressed,
        costEstimateCents: costEstimate, createdBy: userId,
      },
    });

    // 4) enfileira (uma linha por destinatário em outbound_messages)
    if (eligible.length > 0 && !dto.scheduledAt) {
      const rows = eligible.map((c) => ({
        organizationId: orgId,
        campaignId: campaign.id,
        channelId: channel.id,
        contactId: c.id,
        toPhoneE164: c.phoneE164,
        payload: this.buildTemplatePayload(c, template, dto.templateParams),
      }));
      // createMany em lotes
      const CHUNK = 1000;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await this.prisma.outboundMessage.createMany({ data: rows.slice(i, i + CHUNK) });
      }
      await this.prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'sending' } });
    }

    return {
      campaignId: campaign.id,
      totalRecipients: eligible.length,
      suppressed,
      costEstimateCents: Number(costEstimate),
      status: dto.scheduledAt ? 'scheduled' : 'sending',
    };
  }

  async list(orgId: string, q: QueryCampaignsDto) {
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 20, 100);
    const where: any = { organizationId: orgId };
    if (q.status) where.status = q.status;

    const [rows, total] = await Promise.all([
      this.prisma.campaign.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          template: { select: { name: true, category: true } },
          channel: { select: { label: true } },
        },
      }),
      this.prisma.campaign.count({ where }),
    ]);

    const items = rows.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      template: c.template,
      channel: c.channel,
      totalRecipients: c.totalRecipients,
      suppressedCount: c.suppressedCount,
      sentCount: c.sentCount,
      deliveredCount: c.deliveredCount,
      readCount: c.readCount,
      failedCount: c.failedCount,
      costEstimateCents: c.costEstimateCents != null ? Number(c.costEstimateCents) : null,
      scheduledAt: c.scheduledAt,
      createdAt: c.createdAt,
    }));
    return { items, total, page, pageSize };
  }

  async progress(orgId: string, id: string) {
    const c = await this.prisma.campaign.findFirst({
      where: { id, organizationId: orgId },
      include: {
        template: { select: { name: true, category: true } },
        channel: { select: { label: true } },
      },
    });
    if (!c) throw new NotFoundException('Campanha não encontrada.');
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      template: c.template,
      channel: c.channel,
      total: c.totalRecipients,
      suppressed: c.suppressedCount,
      sent: c.sentCount,
      delivered: c.deliveredCount,
      read: c.readCount,
      failed: c.failedCount,
      costEstimateCents: c.costEstimateCents != null ? Number(c.costEstimateCents) : null,
      createdAt: c.createdAt,
      scheduledAt: c.scheduledAt,
    };
  }

  async cancel(orgId: string, id: string) {
    const c = await this.prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
    if (!c) throw new NotFoundException('Campanha não encontrada.');
    // cancela só o que ainda está na fila
    const res = await this.prisma.outboundMessage.updateMany({
      where: { campaignId: id, status: 'queued' },
      data: { status: 'canceled' },
    });
    await this.prisma.campaign.update({ where: { id }, data: { status: 'canceled' } });
    return { canceled: res.count };
  }

  /** Resolve o público a partir de lista (estática) OU regra de segmento. */
  private async resolveAudience(orgId: string, dto: CreateCampaignDto) {
    if (dto.listId) {
      // join com list_contacts (tabela não mapeada no Prisma → raw)
      return this.prisma.$queryRawUnsafe<any[]>(
        `SELECT c.* FROM contacts c
           JOIN list_contacts lc ON lc.contact_id = c.id
          WHERE lc.list_id = $1::uuid AND c.organization_id = $2::uuid AND c.deleted_at IS NULL`,
        dto.listId, orgId,
      );
    }
    const rule = dto.audienceRule ?? {};
    const where: any = { organizationId: orgId, deletedAt: null };
    if (rule.ddd?.length) where.ddd = { in: rule.ddd };
    if (rule.tags?.length) where.tags = { hasSome: rule.tags };
    if (rule.consent) where.consentStatus = rule.consent;
    return this.prisma.contact.findMany({ where });
  }

  /** Monta o objeto "messages" (template) que o Dispatcher enviará à Meta. */
  private buildTemplatePayload(contact: any, template: any, params?: Record<string, string>) {
    const components: any[] = [];
    if (template.variablesCount > 0) {
      const ordered = Object.keys(params ?? {}).sort((a, b) => Number(a) - Number(b));
      const parameters = ordered.map((k) => ({
        type: 'text',
        text: this.resolveVar(params![k], contact),
      }));
      if (parameters.length) components.push({ type: 'body', parameters });
    }
    return {
      messaging_product: 'whatsapp',
      to: contact.phoneE164.replace('+', ''),
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        ...(components.length ? { components } : {}),
      },
    };
  }

  // suporta placeholders simples: {{name}} → nome de perfil do WhatsApp
  // (pushname, capturado via webhook) quando conhecido; senão o nome salvo.
  private resolveVar(spec: string, contact: any): string {
    if (spec === '{{name}}') {
      return contact.attributes?.whatsapp_name ?? contact.name ?? '';
    }
    return spec;
  }
}

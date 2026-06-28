import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { phoneHash } from '../common/crypto.util';

@Injectable()
export class MessagesService {
  constructor(private prisma: PrismaService) {}

  /** Envio avulso para 1 número: enfileira uma outbound_message (template). */
  async sendSingle(orgId: string, dto: { channelId: string; templateId: string; phone: string; params?: Record<string, string> }) {
    const channel = await this.prisma.whatsappChannel.findFirst({
      where: { id: dto.channelId, organizationId: orgId, status: 'active' },
    });
    if (!channel) throw new NotFoundException('Canal não encontrado.');
    const template = await this.prisma.template.findFirst({
      where: { id: dto.templateId, organizationId: orgId },
    });
    if (!template) throw new NotFoundException('Template não encontrado.');
    if (template.status !== 'APPROVED') throw new BadRequestException('Template não aprovado.');

    const e164 = dto.phone.startsWith('+') ? dto.phone : '+' + dto.phone.replace(/\D/g, '');
    const hash = phoneHash(e164);
    const contact = await this.prisma.contact.findFirst({
      where: { organizationId: orgId, phoneHash: hash, deletedAt: null },
    });
    if (contact?.optedOut) throw new BadRequestException('Contato optou por não receber mensagens.');

    const ordered = Object.keys(dto.params ?? {}).sort((a, b) => Number(a) - Number(b));
    const parameters = ordered.map((k) => ({ type: 'text', text: dto.params![k] }));
    const payload: any = {
      messaging_product: 'whatsapp',
      to: e164.replace('+', ''),
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        ...(parameters.length ? { components: [{ type: 'body', parameters }] } : {}),
      },
    };

    const msg = await this.prisma.outboundMessage.create({
      data: {
        organizationId: orgId, channelId: dto.channelId, contactId: contact?.id ?? null,
        toPhoneE164: e164, payload,
      },
    });
    return { queued: true, messageId: msg.id };
  }
}

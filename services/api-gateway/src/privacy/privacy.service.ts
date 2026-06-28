import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { phoneHash } from '../common/crypto.util';

@Injectable()
export class PrivacyService {
  constructor(private prisma: PrismaService) {}

  /** Cria e processa a solicitação do titular (export ou delete). */
  async createRequest(orgId: string, userId: string, dto: { type: 'export' | 'delete'; subjectPhone: string }) {
    const e164 = dto.subjectPhone.startsWith('+') ? dto.subjectPhone : '+' + dto.subjectPhone.replace(/\D/g, '');

    const req = await this.prisma.dataSubjectRequest.create({
      data: { organizationId: orgId, type: dto.type, subjectPhone: e164, requestedBy: userId, status: 'processing' },
    });

    const result = dto.type === 'export'
      ? await this.exportSubject(orgId, e164)
      : await this.deleteSubject(orgId, e164);

    await this.prisma.dataSubjectRequest.update({
      where: { id: req.id },
      data: { status: 'completed', completedAt: new Date() },
    });

    await this.audit(orgId, userId, `lgpd.${dto.type}`, e164);
    return { requestId: req.id, type: dto.type, ...result };
  }

  async getRequest(orgId: string, id: string) {
    const r = await this.prisma.dataSubjectRequest.findFirst({ where: { id, organizationId: orgId } });
    if (!r) throw new NotFoundException('Solicitação não encontrada.');
    return r;
  }

  // Acesso/portabilidade: devolve todos os dados do titular.
  private async exportSubject(orgId: string, e164: string) {
    const hash = phoneHash(e164);
    const contact = await this.prisma.contact.findFirst({
      where: { organizationId: orgId, phoneHash: hash },
    });
    if (!contact) return { found: false, data: null };

    const [consent, outbound] = await Promise.all([
      this.prisma.$queryRawUnsafe<any[]>(`SELECT event, source, created_at FROM consent_events WHERE contact_id = $1`, contact.id),
      this.prisma.outboundMessage.findMany({ where: { organizationId: orgId, contactId: contact.id } }),
    ]);
    return { found: true, data: { contact, consentEvents: consent, messages: outbound } };
  }

  // Eliminação: anonimiza o titular preservando o mínimo legal (auditoria pseudonimizada).
  private async deleteSubject(orgId: string, e164: string) {
    const hash = phoneHash(e164);
    const contact = await this.prisma.contact.findFirst({
      where: { organizationId: orgId, phoneHash: hash },
    });
    if (!contact) return { found: false, anonymized: 0 };

    await this.prisma.contact.update({
      where: { id: contact.id },
      data: {
        name: null, phoneE164: 'REDACTED', attributes: {},
        optedOut: true, consentStatus: 'opted_out', deletedAt: new Date(),
      },
    });
    return { found: true, anonymized: 1 };
  }

  private async audit(orgId: string, userId: string, action: string, resourceId: string) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO audit_logs (organization_id, actor_user_id, action, resource_type, resource_id)
       VALUES ($1,$2,$3,'data_subject',$4)`,
      orgId, userId, action, resourceId,
    );
  }
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TemplatesService {
  constructor(private prisma: PrismaService, private config: ConfigService) {}

  findAll(orgId: string) {
    return this.prisma.template.findMany({ where: { organizationId: orgId }, orderBy: { name: 'asc' } });
  }

  /**
   * Sincroniza o status de aprovação dos templates a partir da Meta.
   * TODO: GET https://graph.facebook.com/{version}/{waba_id}/message_templates
   * usando o access token do canal, e fazer upsert de name/category/status/body.
   */
  async sync(orgId: string) {
    const version = this.config.get<string>('whatsapp.graphVersion');
    return { synced: false, note: `Stub. Implementar GET ${version}/{waba_id}/message_templates.` };
  }
}

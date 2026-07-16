import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ListsService {
  constructor(private prisma: PrismaService) {}

  findAll(orgId: string) {
    return this.prisma.list.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: 'desc' } });
  }

  create(orgId: string, dto: { name: string; type?: string; rule?: any }) {
    return this.prisma.list.create({
      data: { organizationId: orgId, name: dto.name, type: dto.type ?? 'static', rule: dto.rule ?? undefined },
    });
  }

  // adiciona contatos a uma lista estática (insert em list_contacts)
  async addContacts(orgId: string, listId: string, contactIds: string[]) {
    let added = 0;
    for (const cid of contactIds) {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO list_contacts (list_id, contact_id)
         SELECT $1::uuid, $2::uuid WHERE EXISTS (
           SELECT 1 FROM contacts WHERE id = $2::uuid AND organization_id = $3::uuid
         ) ON CONFLICT DO NOTHING`,
        listId, cid, orgId,
      );
      added++;
    }
    return { added };
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { phoneHash } from '../common/crypto.util';
import { CreateContactDto } from './dto/create-contact.dto';
import { QueryContactsDto } from './dto/query-contacts.dto';
import { ImportContactsDto } from './dto/import-contacts.dto';

// Normalização leve p/ criação avulsa (o bulk usa o Importer, autoritativo).
// TODO: rotear também o avulso pelo Importer p/ consistência total.
function normalizeBR(raw: string): { e164: string; ddd?: string } {
  const digits = raw.replace(/\D/g, '');
  let n = digits;
  if (!n.startsWith('55')) n = '55' + n;
  const e164 = '+' + n;
  const ddd = n.length >= 4 ? n.slice(2, 4) : undefined;
  return { e164, ddd };
}

@Injectable()
export class ContactsService {
  constructor(private prisma: PrismaService, private config: ConfigService) {}

  async list(orgId: string, q: QueryContactsDto) {
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 50, 200);
    const where: any = { organizationId: orgId, deletedAt: null };
    if (q.ddd) where.ddd = q.ddd;
    if (q.consent) where.consentStatus = q.consent;
    if (q.tag) where.tags = { has: q.tag };
    if (q.search) where.OR = [
      { name: { contains: q.search, mode: 'insensitive' } },
      { phoneE164: { contains: q.search } },
    ];

    const [items, total] = await Promise.all([
      this.prisma.contact.findMany({
        where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { createdAt: 'desc' },
      }),
      this.prisma.contact.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async create(orgId: string, dto: CreateContactDto) {
    const { e164, ddd } = normalizeBR(dto.phone);
    const hash = phoneHash(e164);
    return this.prisma.contact.upsert({
      where: { organizationId_phoneHash: { organizationId: orgId, phoneHash: hash } },
      create: {
        organizationId: orgId, phoneE164: e164, phoneHash: hash, name: dto.name, ddd,
        tags: dto.tags ?? [], consentStatus: dto.consentStatus ?? 'unknown',
        consentSource: dto.consentSource, consentAt: dto.consentStatus === 'granted' ? new Date() : null,
      },
      update: { name: dto.name, tags: dto.tags ?? undefined },
    });
  }

  async update(orgId: string, id: string, data: Partial<CreateContactDto>) {
    await this.ensure(orgId, id);
    return this.prisma.contact.update({
      where: { id },
      data: { name: data.name, tags: data.tags },
    });
  }

  async remove(orgId: string, id: string) {
    await this.ensure(orgId, id);
    // soft delete (direito de eliminação tratado pelo módulo Privacy)
    return this.prisma.contact.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async optOut(orgId: string, id: string) {
    await this.ensure(orgId, id);
    return this.prisma.contact.update({
      where: { id },
      data: { optedOut: true, optedOutAt: new Date(), consentStatus: 'opted_out' },
    });
  }

  /**
   * Import: encaminha o arquivo ao serviço Importer (Python), que devolve
   * linhas normalizadas/validadas, e faz upsert dos contatos com a base legal.
   */
  async importFile(orgId: string, file: Express.Multer.File, dto: ImportContactsDto) {
    const form = new FormData();
    form.append('file', new Blob([file.buffer]), file.originalname);
    form.append('default_country', dto.defaultCountry ?? 'BR');

    const importerUrl = this.config.get<string>('importerUrl');
    const { data } = await axios.post(`${importerUrl}/parse`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      maxBodyLength: Infinity,
    });

    const valid: any[] = data.valid ?? [];
    let imported = 0;
    const consentAt = dto.consentStatus === 'granted' ? new Date() : null;

    // upsert em lotes p/ não travar a conexão em arquivos grandes
    for (const row of valid) {
      const hash = phoneHash(row.phone_e164);
      await this.prisma.contact.upsert({
        where: { organizationId_phoneHash: { organizationId: orgId, phoneHash: hash } },
        create: {
          organizationId: orgId, phoneE164: row.phone_e164, phoneHash: hash,
          name: row.name ?? null, ddd: row.ddd ?? null, region: row.region ?? null,
          countryCode: row.country_code ?? 'BR', attributes: row.attributes ?? {},
          consentStatus: dto.consentStatus, consentSource: dto.consentSource, consentAt,
        },
        update: { name: row.name ?? undefined, ddd: row.ddd ?? undefined, region: row.region ?? undefined },
      });
      imported++;
    }

    return {
      imported,
      duplicates: data.stats?.duplicates ?? 0,
      invalid: data.invalid?.length ?? 0,
      total: data.stats?.total ?? valid.length,
      consentSource: dto.consentSource,
    };
  }

  private async ensure(orgId: string, id: string) {
    const c = await this.prisma.contact.findFirst({ where: { id, organizationId: orgId } });
    if (!c) throw new NotFoundException('Contato não encontrado.');
    return c;
  }
}

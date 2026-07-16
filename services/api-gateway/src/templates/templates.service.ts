import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { decrypt } from '../common/crypto.util';
import { CreateTemplateDto } from './dto/create-template.dto';

@Injectable()
export class TemplatesService {
  constructor(private prisma: PrismaService, private config: ConfigService) {}

  findAll(orgId: string) {
    return this.prisma.template.findMany({ where: { organizationId: orgId }, orderBy: { name: 'asc' } });
  }

  /**
   * Sincroniza os templates a partir da Meta (fonte da verdade): status de
   * aprovação, categoria (a Meta pode recategorizar na análise) e corpo.
   * Upsert por (org, name, language); templates criados direto no painel da
   * Meta passam a existir localmente. Env-gated: sem canal real, não faz nada.
   */
  async sync(orgId: string) {
    const channel = await this.prisma.whatsappChannel.findFirst({
      where: { organizationId: orgId, status: 'active' },
      // determinístico (oldest-first) quando houver mais de um canal ativo
      orderBy: { createdAt: 'asc' },
    });
    if (!channel || !looksConfigured(channel.wabaId) || !looksConfigured(channel.accessTokenEnc)) {
      return { synced: false, note: 'Sem canal Meta configurado nesta organização.' };
    }

    const version = this.config.get<string>('whatsapp.graphVersion');
    const token = readToken(channel.accessTokenEnc);

    // GET /message_templates paginado (paging.next já vem como URL completa)
    const remotos: any[] = [];
    try {
      let url: string | undefined =
        `https://graph.facebook.com/${version}/${channel.wabaId}/message_templates?limit=100`;
      let paginas = 0;
      while (url && paginas < 10) {
        const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
        remotos.push(...(data?.data ?? []));
        url = data?.paging?.next;
        paginas++;
      }
    } catch (e: any) {
      const detalhe = e?.response?.data?.error?.message ?? e?.message ?? String(e);
      return { synced: false, note: `Falha ao consultar a Meta: ${detalhe}` };
    }

    let atualizados = 0;
    let criados = 0;
    for (const r of remotos) {
      if (!r?.name || !r?.language) continue;
      const body: string | null =
        (r.components ?? []).find((c: any) => c?.type === 'BODY')?.text ?? null;
      const campos = {
        category: r.category ?? 'MARKETING',
        status: statusLocal(r.status),
        metaTemplateId: r.id ?? null,
        ...(body != null ? { body, variablesCount: countVariables(body) } : {}),
      };
      const existente = await this.prisma.template.findFirst({
        where: { organizationId: orgId, name: r.name, language: r.language },
      });
      if (existente) {
        await this.prisma.template.update({ where: { id: existente.id }, data: campos });
        atualizados++;
      } else {
        await this.prisma.template.create({
          data: {
            organizationId: orgId,
            name: r.name,
            language: r.language,
            body,
            variablesCount: body != null ? countVariables(body) : 0,
            category: campos.category,
            status: campos.status,
            metaTemplateId: campos.metaTemplateId,
          },
        });
        criados++;
      }
    }

    return { synced: true, total: remotos.length, atualizados, criados };
  }

  async create(orgId: string, dto: CreateTemplateDto) {
    const language = dto.language ?? 'pt_BR';
    const variablesCount = countVariables(dto.body);

    const exists = await this.prisma.template.findFirst({
      where: { organizationId: orgId, name: dto.name, language },
    });
    if (exists) throw new ConflictException('Já existe um template com esse nome e idioma.');

    const template = await this.prisma.template.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        language,
        category: dto.category,
        status: 'PENDING',
        body: dto.body,
        variablesCount,
      },
    });

    // Submissão à Meta: best-effort e env-gated. Falha NÃO desfaz o rascunho local.
    let metaWarning: string | undefined;
    try {
      const submission = await this.submitToMeta(orgId, template);
      if (submission.id) {
        await this.prisma.template.update({
          where: { id: template.id },
          data: { metaTemplateId: submission.id },
        });
        (template as any).metaTemplateId = submission.id;
      } else {
        metaWarning = submission.skipped;
      }
    } catch (e: any) {
      metaWarning = `Falha ao submeter à Meta: ${e?.message ?? e}. Rascunho salvo localmente.`;
    }

    return { ...template, metaWarning };
  }

  private async submitToMeta(
    orgId: string,
    template: { name: string; language: string; category: string; body: string | null; variablesCount: number },
  ): Promise<{ id?: string; skipped?: string }> {
    const channel = await this.prisma.whatsappChannel.findFirst({
      where: { organizationId: orgId, status: 'active' },
      // determinístico (oldest-first) quando houver mais de um canal ativo
      orderBy: { createdAt: 'asc' },
    });
    if (!channel || !looksConfigured(channel.wabaId) || !looksConfigured(channel.accessTokenEnc)) {
      return { skipped: 'Sem canal Meta configurado; template salvo apenas localmente.' };
    }
    const version = this.config.get<string>('whatsapp.graphVersion');
    const token = readToken(channel.accessTokenEnc);
    const example =
      template.variablesCount > 0
        ? { body_text: [Array.from({ length: template.variablesCount }, (_, i) => `exemplo${i + 1}`)] }
        : undefined;
    const components: any[] = [{ type: 'BODY', text: template.body ?? '', ...(example ? { example } : {}) }];
    const url = `https://graph.facebook.com/${version}/${channel.wabaId}/message_templates`;
    const { data } = await axios.post(
      url,
      { name: template.name, language: template.language, category: template.category, components },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return { id: data?.id };
  }
}

// A Meta tem mais estados (PAUSED, IN_APPEAL, PENDING_DELETION…) que o nosso
// enum local; mapeia para APPROVED | PENDING | REJECTED | DISABLED (check do schema).
function statusLocal(metaStatus?: string): string {
  switch (metaStatus) {
    case 'APPROVED': return 'APPROVED';
    case 'PENDING':
    case 'IN_APPEAL': return 'PENDING';
    case 'REJECTED': return 'REJECTED';
    default: return 'DISABLED';
  }
}

// conta placeholders {{n}} distintos no corpo
function countVariables(body: string): number {
  const matches = body.match(/\{\{\s*(\d+)\s*\}\}/g) ?? [];
  const nums = new Set(matches.map((m) => m.replace(/\D/g, '')));
  return nums.size;
}

// access_token_enc pode estar cifrado (AES-GCM) ou em texto (cifragem é TODO no projeto)
function readToken(enc: string): string {
  try { return decrypt(enc); } catch { return enc; }
}

// placeholders do seed/dev não são credenciais reais (AQUI = seed; LOCAL_DEV = canal de org recém-registrada)
function looksConfigured(v?: string | null): boolean {
  return !!v && !v.includes('AQUI') && !v.includes('LOCAL_DEV');
}

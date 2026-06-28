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
   * Sincroniza o status de aprovação dos templates a partir da Meta.
   * TODO: GET https://graph.facebook.com/{version}/{waba_id}/message_templates
   * usando o access token do canal, e fazer upsert de name/category/status/body.
   */
  async sync(orgId: string) {
    const version = this.config.get<string>('whatsapp.graphVersion');
    return { synced: false, note: `Stub. Implementar GET ${version}/{waba_id}/message_templates.` };
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

// placeholders do seed/dev não são credenciais reais
function looksConfigured(v?: string | null): boolean {
  return !!v && !v.includes('AQUI');
}

import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { PlataformaService } from '../common/plataforma.service';
import { decrypt } from '../common/crypto.util';
import { CreateTemplateDto } from './dto/create-template.dto';
import { PREFIXO_PLATAFORMA, prefixoDaOrg } from './meta-nome';

@Injectable()
export class TemplatesService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private plataforma: PlataformaService,
  ) {}

  findAll(orgId: string) {
    return this.prisma.template.findMany({ where: { organizationId: orgId }, orderBy: { name: 'asc' } });
  }

  /**
   * Sincroniza os templates a partir da Meta (fonte da verdade): status de
   * aprovação, categoria (a Meta pode recategorizar na análise) e corpo.
   *
   * Duas regras, nesta ordem — é o que fecha o vazamento entre organizações
   * que dividem a mesma WABA (canal assistido ou legado apontando para a
   * mesma conta):
   *   1) template já rastreado por `metaTemplateId`: atualiza. Mantém o
   *      legado funcionando, inclusive templates sem prefixo criados antes
   *      desta mudança.
   *   2) template novo: só vira linha se o nome começar com o prefixo desta
   *      organização ou com o prefixo dos genéricos da plataforma. Qualquer
   *      outro nome é template de outro cliente e é ignorado.
   *
   * Env-gated: sem canal real, não faz nada.
   */
  async sync(orgId: string) {
    const credenciais = await this.resolverCredenciais(orgId);
    if (!credenciais) {
      return { synced: false, note: 'Sem canal Meta configurado nesta organização.' };
    }
    const { wabaId, token } = credenciais;

    // orgId vem sempre do JWT e é um UUID; se prefixoDaOrg lançar aqui é sinal
    // de dado corrompido, não de entrada de usuário. Deixa propagar (vira 500)
    // em vez de engolir em silêncio e fingir que sincronizou.
    const prefixoOrg = prefixoDaOrg(orgId);

    let remotos: any[];
    try {
      remotos = await this.buscarRemotos(wabaId, token);
    } catch (e: any) {
      const detalhe = e?.response?.data?.error?.message ?? e?.message ?? String(e);
      return { synced: false, note: `Falha ao consultar a Meta: ${detalhe}` };
    }

    let atualizados = 0;
    let criados = 0;
    let ignorados = 0;

    for (const r of remotos) {
      if (!r?.name || !r?.language) { ignorados++; continue; }

      const body: string | null =
        (r.components ?? []).find((c: any) => c?.type === 'BODY')?.text ?? null;
      const campos = {
        category: r.category ?? 'MARKETING',
        status: statusLocal(r.status),
        ...(body != null ? { body, variablesCount: countVariables(body) } : {}),
      };

      // 1) já rastreado (por id global da Meta, não por nome dentro da
      //    organização — buscar por nome recriaria o vazamento): atualiza.
      const conhecido = r.id
        ? await this.prisma.template.findFirst({ where: { metaTemplateId: r.id } })
        : null;
      if (conhecido) {
        await this.prisma.template.update({ where: { id: conhecido.id }, data: campos });
        atualizados++;
        continue;
      }

      // 2) carrega o prefixo desta organização, ou o dos genéricos. Qualquer
      //    outra coisa é template de outro cliente: NÃO vira linha de
      //    ninguém — é este `continue` que fecha o vazamento.
      const daOrg = r.name.startsWith(`${prefixoOrg}_`);
      const daPlataforma = r.name.startsWith(`${PREFIXO_PLATAFORMA}_`);
      if (!daOrg && !daPlataforma) { ignorados++; continue; }

      await this.prisma.template.create({
        data: {
          organizationId: daPlataforma ? null : orgId,
          scope: daPlataforma ? 'platform' : 'org',
          name: r.name.slice((daPlataforma ? PREFIXO_PLATAFORMA : prefixoOrg).length + 1),
          metaName: r.name,
          language: r.language,
          body,
          variablesCount: body != null ? countVariables(body) : 0,
          category: campos.category,
          status: campos.status,
          metaTemplateId: r.id ?? null,
        },
      });
      criados++;
    }

    return { synced: true, total: remotos.length, atualizados, criados, ignorados };
  }

  /** GET /{waba}/message_templates, paginado. Separado de `sync` para o teste
   *  poder exercitar a regra de importação sem falar com a rede. */
  private async buscarRemotos(wabaId: string, token: string): Promise<any[]> {
    const version = this.config.get<string>('whatsapp.graphVersion');
    const remotos: any[] = [];
    let url: string | undefined =
      `https://graph.facebook.com/${version}/${wabaId}/message_templates?limit=100`;
    let paginas = 0;
    while (url && paginas < 10) {
      const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
      remotos.push(...(data?.data ?? []));
      url = data?.paging?.next;
      paginas++;
    }
    return remotos;
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
        // TODO(templates-por-dono): idem — sem prefixo por organização ainda.
        metaName: dto.name,
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
    const credenciais = await this.resolverCredenciais(orgId);
    if (!credenciais) {
      return { skipped: 'Sem canal Meta configurado; template salvo apenas localmente.' };
    }
    const { wabaId, token } = credenciais;
    const version = this.config.get<string>('whatsapp.graphVersion');
    const example =
      template.variablesCount > 0
        ? { body_text: [Array.from({ length: template.variablesCount }, (_, i) => `exemplo${i + 1}`)] }
        : undefined;
    const components: any[] = [{ type: 'BODY', text: template.body ?? '', ...(example ? { example } : {}) }];
    const url = `https://graph.facebook.com/${version}/${wabaId}/message_templates`;
    const { data } = await axios.post(
      url,
      { name: template.name, language: template.language, category: template.category, components },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return { id: data?.id };
  }

  /** Qual WABA e qual token esta organização usa para falar com a Meta.
   *
   *  No canal assistido, `access_token_enc` nasce VAZIO de propósito: o token é
   *  da plataforma, não do cliente. Ler a linha do canal aqui é o que faz o
   *  cliente assistido não conseguir usar template nenhum hoje. */
  private async resolverCredenciais(
    orgId: string,
  ): Promise<{ wabaId: string; token: string; plataforma: boolean } | null> {
    const canal = await this.prisma.whatsappChannel.findFirst({
      where: { organizationId: orgId, status: 'active' },
      // determinístico (oldest-first) quando houver mais de um canal ativo
      orderBy: { createdAt: 'asc' },
    });
    if (!canal) return null;

    const wabaPlataforma = this.config.get<string>('assisted.wabaId') || '';
    const daPlataforma =
      canal.connectedVia === 'assisted' || (!!wabaPlataforma && canal.wabaId === wabaPlataforma);

    if (daPlataforma) {
      const token = this.config.get<string>('whatsapp.accessToken') || '';
      // sem credencial da plataforma, falhar fechado: chamar a Meta com token
      // vazio devolveria erro de permissão disfarçado de erro de template
      if (!wabaPlataforma || !token) return null;
      return { wabaId: wabaPlataforma, token, plataforma: true };
    }

    if (!looksConfigured(canal.wabaId) || !looksConfigured(canal.accessTokenEnc)) return null;
    return { wabaId: canal.wabaId, token: readToken(canal.accessTokenEnc), plataforma: false };
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

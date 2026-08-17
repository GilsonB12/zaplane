import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { PlataformaService } from '../common/plataforma.service';
import { decrypt } from '../common/crypto.util';
import { CreateTemplateDto } from './dto/create-template.dto';
import {
  PREFIXO_PLATAFORMA, prefixoDaOrg, metaNomeDaOrg, metaNomeDaPlataforma, NomeInvalidoError,
} from './meta-nome';

@Injectable()
export class TemplatesService {
  private readonly logger = new Logger('TemplatesSync');

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private plataforma: PlataformaService,
  ) {}

  /** Os templates da organização, mais os genéricos — estes só quando ela envia
   *  pela WABA da Zaplane, que é onde os genéricos vivem. */
  async findAll(orgId: string) {
    const veGenericos = await this.plataforma.orgNaWabaDaPlataforma(orgId);
    return this.prisma.template.findMany({
      where: veGenericos
        ? { OR: [{ organizationId: orgId }, { scope: 'platform' }] }
        : { organizationId: orgId },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Sincroniza os templates a partir da Meta (fonte da verdade): status de
   * aprovação, categoria (a Meta pode recategorizar na análise) e corpo.
   *
   * Duas regras, nesta ordem — é o que fecha o vazamento entre organizações
   * que dividem a mesma WABA (canal assistido ou legado apontando para a
   * mesma conta):
   *   1) template já rastreado por `metaTemplateId` E que pertence a esta
   *      organização (ou é genérico da plataforma): atualiza. Mantém o
   *      legado funcionando, inclusive templates sem prefixo criados antes
   *      desta mudança. Rastreado por OUTRA organização é resíduo do
   *      vazamento antigo: não atualiza, não cria — só ignora e registra.
   *   2) template novo: só vira linha se o nome começar com o prefixo desta
   *      organização ou — e só quando a WABA lida É a da plataforma — com o
   *      prefixo dos genéricos. Qualquer outro nome é template de outro
   *      cliente e é ignorado.
   *
   * A resposta ao cliente só conta o que foi processado para a própria
   * organização; total/ignorados sobre a WABA inteira ficam só no log do
   * servidor — devolvê-los ao cliente seria outro oráculo de contagem sobre
   * os demais inquilinos.
   *
   * Env-gated: sem canal real, não faz nada.
   */
  async sync(orgId: string) {
    const credenciais = await this.resolverCredenciais(orgId);
    if (!credenciais) {
      // Saída silenciosa: sem este WARN, "o cliente conectou e não recebeu
      // genérico nenhum" não deixa rastro nenhum no servidor (o retorno é
      // descartado por assisted.service.sincronizarTemplates).
      this.logger.warn(
        `sync org=${orgId}: nenhuma credencial da Meta utilizável (sem canal ativo, canal com placeholder de seed, ou credencial da plataforma ausente) — nada sincronizado`,
      );
      return { synced: false, note: 'Sem canal Meta configurado nesta organização.' };
    }
    // `plataforma` NÃO pode ser descartado aqui: é ele que diz se a WABA que
    // acabamos de escolher é a da Zaplane. Sem ele, o prefixo `zaplane_` viraria
    // autoridade em QUALQUER WABA — um cliente legado criaria `zaplane_promo` no
    // WhatsApp Manager dele e o corpo da mensagem dele nasceria como genérico da
    // plataforma, visível e disparável por todo cliente assistido (e ainda
    // ocuparia o nome no índice único dos genéricos, barrando o verdadeiro).
    const { wabaId, token, plataforma } = credenciais;

    // orgId vem sempre do JWT e é um UUID; se prefixoDaOrg lançar aqui é sinal
    // de dado corrompido, não de entrada de usuário. Deixa propagar (vira 500)
    // em vez de engolir em silêncio e fingir que sincronizou.
    const prefixoOrg = prefixoDaOrg(orgId);

    let remotos: any[];
    try {
      remotos = await this.buscarRemotos(wabaId, token);
    } catch (e: any) {
      const detalhe = e?.response?.data?.error?.message ?? e?.message ?? String(e);
      // Este é o modo de falha PROVÁVEL (a Graph API responde erro), e ele
      // `return`a em vez de lançar — então nada acima registra. Sem esta linha,
      // "meu template não sincroniza" não tem onde ser investigado.
      this.logger.warn(`sync org=${orgId} waba=${wabaId}: falha ao consultar a Meta — ${erroDaMeta(e)}`);
      return { synced: false, note: `Falha ao consultar a Meta: ${detalhe}` };
    }

    let atualizados = 0;
    let criados = 0;
    // conta também templates de outras organizações (residuo do vazamento
    // antigo, ou nome sem prefixo reconhecido) — nunca sai na resposta ao
    // cliente (ver retorno no fim do método); fica só no log do servidor.
    let ignorados = 0;

    for (const r of remotos) {
      if (!r?.name || !r?.language) { ignorados++; continue; }

      const body: string | null =
        (r.components ?? []).find((c: any) => c?.type === 'BODY')?.text ?? null;
      // metaTemplateId NÃO entra aqui: quando existe `conhecido` (abaixo), ele
      // só foi encontrado por `where: { metaTemplateId: r.id }` — ou seja, já
      // é igual a r.id. Reescrevê-lo no update seria sempre o mesmo valor já
      // gravado. Ele só importa em create(), onde inicializa o id pela
      // primeira vez (ali é passado à parte, como `r.id ?? null`).
      const campos = {
        category: r.category ?? 'MARKETING',
        status: statusLocal(r.status),
        ...(body != null ? { body, variablesCount: countVariables(body) } : {}),
      };

      // 1) já rastreado (por id global da Meta, não por nome dentro da
      //    organização — buscar por nome recriaria o vazamento): atualiza,
      //    mas só se a linha já pertencer a esta organização ou for genérica
      //    da plataforma. Linha de OUTRO dono é resíduo do vazamento antigo
      //    (sync anterior a este isolamento importou o que não era dela): não
      //    atualiza nem cria — só ignora e registra, para a operação limpar.
      const conhecido = r.id
        ? await this.prisma.template.findFirst({ where: { metaTemplateId: r.id } })
        : null;
      if (conhecido) {
        const deDonoOuGenerico = conhecido.scope === 'platform' || conhecido.organizationId === orgId;
        if (!deDonoOuGenerico) {
          ignorados++;
          this.logger.warn(
            `sync org=${orgId}: template meta_template_id=${r.id} (${r.name}) já está rastreado por outra organização (linha local ${conhecido.id}) — resíduo do vazamento antigo, ignorado`,
          );
          continue;
        }
        await this.prisma.template.update({ where: { id: conhecido.id }, data: campos });
        atualizados++;
        continue;
      }

      // 2) carrega o prefixo desta organização, ou o dos genéricos — e este
      //    segundo caso SÓ vale dentro da WABA da plataforma (`plataforma`).
      //    Nada no modelo registra em qual WABA um template de escopo
      //    'platform' vive (organization_id é nulo e não há coluna de WABA):
      //    quem afirma que ele é da Zaplane é só o prefixo do nome, e o nome
      //    está sob controle de quem for dono da WABA lida. Fora da WABA da
      //    plataforma, `zaplane_x` é template comum daquele cliente e cai na
      //    mesma regra de qualquer nome alheio: NÃO vira linha de ninguém — é
      //    este `continue` que fecha o vazamento.
      const daOrg = r.name.startsWith(`${prefixoOrg}_`);
      const daPlataforma = plataforma && r.name.startsWith(`${PREFIXO_PLATAFORMA}_`);
      if (!daOrg && !daPlataforma) { ignorados++; continue; }

      try {
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
      } catch (e: unknown) {
        // Índice único (organizationId, name, language): já existe linha
        // local com essa identidade — ex. rascunho criado via create() cujo
        // submitToMeta falhou e ficou com metaTemplateId nulo, e o template
        // acabou existindo na Meta por outro caminho. Um conflito não pode
        // derrubar o lote inteiro: ignora este template e segue os demais.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          ignorados++;
          this.logger.warn(
            `sync org=${orgId}: conflito de índice único ao criar "${r.name}" (meta_template_id=${r.id}) — já existe linha local com esse nome/idioma; ignorado`,
          );
          continue;
        }
        throw e;
      }
    }

    this.logger.log(
      `sync org=${orgId}: ${remotos.length} templates na WABA — ${atualizados} atualizados, ${criados} criados, ${ignorados} ignorados (inclui templates de outras organizações)`,
    );

    // A resposta ao cliente conta só o que é dele: total/ignorados sobre a
    // WABA inteira entregariam quantos templates os outros inquilinos têm
    // (mesma classe de vazamento que este isolamento fecha). Detalhe completo
    // só no log acima.
    return { synced: true, total: atualizados + criados, atualizados, criados };
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

  /** Cria um template. `opts.plataforma` vem da rota (Post / vs. Post
   *  /platform), nunca do corpo — mesmo motivo pelo qual `organizationId`
   *  vem do JWT: dado que decide autorização não vem do body.
   *
   *  Caso genérico (`plataforma: true`): `orgId` ainda é necessário para
   *  `submitToMeta` achar a WABA via `resolverCredenciais`, mas ele NÃO vira
   *  dono do template — `organizationId` fica nulo e `scope` fica
   *  'platform'. O CHECK do banco (`templates_escopo_dono_check`) rejeita as
   *  duas combinações erradas, então um engano aqui vira erro de constraint,
   *  não corrupção silenciosa. */
  async create(orgId: string, dto: CreateTemplateDto, opts: { plataforma: boolean }) {
    const language = dto.language ?? 'pt_BR';
    const variablesCount = countVariables(dto.body);

    let metaName: string;
    try {
      metaName = opts.plataforma
        ? metaNomeDaPlataforma(dto.name)
        : metaNomeDaOrg(orgId, dto.name);
    } catch (e) {
      if (e instanceof NomeInvalidoError) {
        throw new BadRequestException(
          'Dê ao template um nome com letras ou números.',
        );
      }
      throw e;
    }

    // A duplicata é checada pelo meta_name (o que precisa ser único, porque é
    // o que vai para a Meta), não pelo rótulo (dto.name): "Promoção de Banho"
    // e "PROMOÇÃO DE BANHO!!!" são rótulos diferentes que normalizam para o
    // mesmo meta_name — comparar só o rótulo deixava os dois passarem e a
    // colisão só estourava (silenciosamente, porque a submissão é
    // best-effort) ao chegar na Meta.
    const where: Prisma.TemplateWhereInput = opts.plataforma
      ? { scope: 'platform', metaName, language }
      : { organizationId: orgId, metaName, language };
    const exists = await this.prisma.template.findFirst({ where });
    if (exists) {
      // O cliente digitou o rótulo, não o meta_name — "já existe um template
      // com esse nome" soaria estranho se ele estiver olhando dois rótulos
      // visivelmente diferentes na tela. "Equivalente" não presume que ele
      // saiba que existe normalização por trás.
      throw new ConflictException('Já existe um template equivalente a este nome nesse idioma.');
    }

    const template = await this.prisma.template.create({
      data: {
        organizationId: opts.plataforma ? null : orgId,
        scope: opts.plataforma ? 'platform' : 'org',
        name: dto.name,
        metaName,
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
        // Linha que nasce PENDING sem id da Meta é um beco sem saída pela
        // aplicação (não há rota de reenvio nem de exclusão, e recriar o mesmo
        // nome toma 409). Precisa aparecer no log do servidor no momento em que
        // acontece — o cliente só vê um aviso no navegador, que fecha.
        this.logger.warn(
          `create org=${orgId} template=${template.id} meta_name=${template.metaName} escopo=${template.scope}: NÃO submetido à Meta — ${submission.skipped}`,
        );
      }
    } catch (e: any) {
      // O motivo da recusa da Meta só chegava ao console do navegador do
      // cliente. Registrar aqui é o que torna "meu template não é aprovado"
      // diagnosticável dias depois. Vai só o código/mensagem de erro da Meta:
      // nunca o token (o header nunca é ecoado e o `config` do AxiosError não é
      // serializado) e nunca o corpo do template, que é conteúdo do cliente.
      this.logger.warn(
        `create org=${orgId} template=${template.id} meta_name=${template.metaName} escopo=${template.scope}: falha ao submeter à Meta — ${erroDaMeta(e)}`,
      );
      metaWarning = `Falha ao submeter à Meta: ${e?.message ?? e}. Rascunho salvo localmente.`;
    }

    return { ...template, metaWarning };
  }

  private async submitToMeta(
    orgId: string,
    template: { metaName: string; language: string; category: string; body: string | null; variablesCount: number },
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
    // À Meta vai sempre o meta_name (prefixado e único na WABA), nunca o
    // rótulo que o cliente lê — é o `name` do DTO/registro local.
    const { data } = await axios.post(
      url,
      { name: template.metaName, language: template.language, category: template.category, components },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return { id: data?.id };
  }

  /** Qual WABA e qual token esta organização usa para falar com a Meta.
   *
   *  No canal assistido, `access_token_enc` nasce VAZIO de propósito: o token é
   *  da plataforma, não do cliente. Ler a linha do canal aqui é o que faz o
   *  cliente assistido não conseguir usar template nenhum hoje.
   *
   *  A pergunta aqui é sobre o CANAL que acabei de escolher acima (o ativo mais
   *  antigo), não sobre a organização — e é por isso que ela usa
   *  `canalNaWabaDaPlataforma` e não `orgNaWabaDaPlataforma`. Uma organização
   *  com um canal assistido E um canal legado responde `true` à pergunta por
   *  organização e pode responder `false` aqui, dependendo de qual dos dois foi
   *  escolhido; trocar uma pela outra resolveria a credencial errada —
   *  token/WABA de um canal para operação decidida pelo outro. As duas moram
   *  juntas em `PlataformaService`, com a distinção documentada lá. */
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
    const daPlataforma = this.plataforma.canalNaWabaDaPlataforma(canal);

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

/** O que a operação precisa para diagnosticar uma recusa da Meta, e só isso:
 *  código, subcódigo, mensagem e fbtrace_id (o identificador que o suporte da
 *  Meta pede). Nunca sai daqui o token — a Meta não ecoa o header
 *  `Authorization` e o `config` do AxiosError, que o carrega, não é serializado
 *  — nem o corpo do template, que é conteúdo do cliente. */
function erroDaMeta(e: any): string {
  const err = e?.response?.data?.error;
  if (!err) return e?.message ?? String(e);
  return [
    err.code != null ? `code=${err.code}` : null,
    err.error_subcode != null ? `subcode=${err.error_subcode}` : null,
    err.type ? `type=${err.type}` : null,
    err.fbtrace_id ? `fbtrace_id=${err.fbtrace_id}` : null,
    err.message ? `mensagem=${err.message}` : null,
  ]
    .filter(Boolean)
    .join(' ');
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

import { Prisma } from '@prisma/client';
import { TemplatesService } from './templates.service';
import { prefixoDaOrg } from './meta-nome';

const cfg = (vals: Record<string, any>) => ({ get: (k: string) => vals[k] } as any);
const COMPLETA = {
  'whatsapp.graphVersion': 'v21.0',
  'whatsapp.accessToken': 'TOKEN_PLATAFORMA',
  'assisted.wabaId': 'WABA_ZAPLANE',
  assisted: { wabaId: 'WABA_ZAPLANE' },
};
const prismaCom = (canal: any) =>
  ({ whatsappChannel: { findFirst: jest.fn().mockResolvedValue(canal) } } as any);

describe('TemplatesService.resolverCredenciais', () => {
  const resolver = (s: TemplatesService, orgId = 'org') => (s as any).resolverCredenciais(orgId);

  it('canal assistido usa token e WABA da plataforma', async () => {
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'assisted', wabaId: 'WABA_ZAPLANE', accessTokenEnc: '' }),
      cfg(COMPLETA), {} as any,
    );
    expect(await resolver(s)).toEqual({ wabaId: 'WABA_ZAPLANE', token: 'TOKEN_PLATAFORMA', plataforma: true });
  });

  it('canal legado usa a WABA e o token da propria linha', async () => {
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'manual', wabaId: 'WABA_CLIENTE', accessTokenEnc: 'TOKEN_CLIENTE' }),
      cfg(COMPLETA), {} as any,
    );
    expect(await resolver(s)).toEqual({ wabaId: 'WABA_CLIENTE', token: 'TOKEN_CLIENTE', plataforma: false });
  });

  it('canal na WABA da plataforma sem connected_via assistido tambem usa a plataforma', async () => {
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'manual', wabaId: 'WABA_ZAPLANE', accessTokenEnc: '' }),
      cfg(COMPLETA), {} as any,
    );
    expect((await resolver(s))?.plataforma).toBe(true);
  });

  it('canal assistido sem token da plataforma devolve nulo em vez de chamar a Meta com token vazio', async () => {
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'assisted', wabaId: 'WABA_ZAPLANE', accessTokenEnc: '' }),
      cfg({ ...COMPLETA, 'whatsapp.accessToken': '' }), {} as any,
    );
    expect(await resolver(s)).toBeNull();
  });

  it('sem canal ativo devolve nulo', async () => {
    const s = new TemplatesService(prismaCom(null), cfg(COMPLETA), {} as any);
    expect(await resolver(s)).toBeNull();
  });

  it('canal legado com placeholder de seed devolve nulo', async () => {
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'manual', wabaId: 'COLOQUE_AQUI', accessTokenEnc: 'COLOQUE_AQUI' }),
      cfg(COMPLETA), {} as any,
    );
    expect(await resolver(s)).toBeNull();
  });
});

describe('TemplatesService.sync — isolamento', () => {
  const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000000';
  const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000000';
  // computado, não hardcoded: descolar do prefixo real é o que causou a
  // reescrita destes testes na rodada de correção 1 (I4 alargou de 9 p/ 13)
  const PREFIXO_A = prefixoDaOrg(ORG_A);
  const PREFIXO_B = prefixoDaOrg(ORG_B);

  // a WABA tem: um template da org A, um da org B, um generico e um sem prefixo
  const remotos = [
    { name: `${PREFIXO_A}_promocao`, language: 'pt_BR', status: 'APPROVED', category: 'MARKETING', id: 'm1', components: [{ type: 'BODY', text: 'oi {{1}}' }] },
    { name: `${PREFIXO_B}_promocao`, language: 'pt_BR', status: 'APPROVED', category: 'MARKETING', id: 'm2', components: [{ type: 'BODY', text: 'ola' }] },
    { name: 'zaplane_lembrete',      language: 'pt_BR', status: 'APPROVED', category: 'UTILITY',   id: 'm3', components: [{ type: 'BODY', text: 'lembrete' }] },
    { name: 'hello_world',           language: 'en_US', status: 'APPROVED', category: 'UTILITY',   id: 'm4', components: [{ type: 'BODY', text: 'hi' }] },
  ];

  function servico(orgId: string, conhecidos: any[] = []) {
    const criados: any[] = [];
    const prisma: any = {
      whatsappChannel: {
        findFirst: jest.fn().mockResolvedValue({
          connectedVia: 'manual', wabaId: 'WABA_COMPARTILHADA', accessTokenEnc: 'TOKEN',
        }),
      },
      template: {
        findFirst: jest.fn(({ where }: any) =>
          Promise.resolve(conhecidos.find((t) => t.metaTemplateId === where.metaTemplateId) ?? null)),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn((args: any) => { criados.push(args.data); return Promise.resolve(args.data); }),
      },
    };
    const s = new TemplatesService(prisma, cfg(COMPLETA), {} as any);
    (s as any).buscarRemotos = jest.fn().mockResolvedValue(remotos);
    return { s, prisma, criados, orgId };
  }

  it('a organizacao A nao importa o template da organizacao B', async () => {
    const { s, criados } = servico(ORG_A);
    await s.sync(ORG_A);
    const nomes = criados.map((t) => t.metaName);
    expect(nomes).toContain(`${PREFIXO_A}_promocao`);
    expect(nomes).not.toContain(`${PREFIXO_B}_promocao`);
  });

  it('template sem prefixo e desconhecido nao vira linha de ninguem', async () => {
    const { s, criados } = servico(ORG_A);
    await s.sync(ORG_A);
    expect(criados.map((t) => t.metaName)).not.toContain('hello_world');
  });

  it('generico entra com escopo de plataforma e sem dono', async () => {
    const { s, criados } = servico(ORG_A);
    await s.sync(ORG_A);
    const generico = criados.find((t) => t.metaName === 'zaplane_lembrete');
    expect(generico.scope).toBe('platform');
    expect(generico.organizationId).toBeNull();
  });

  it('template da organizacao entra com escopo org e com dono', async () => {
    const { s, criados } = servico(ORG_A);
    await s.sync(ORG_A);
    const meu = criados.find((t) => t.metaName === `${PREFIXO_A}_promocao`);
    expect(meu.scope).toBe('org');
    expect(meu.organizationId).toBe(ORG_A);
  });

  it('template ja rastreado por meta_template_id continua sendo atualizado, mesmo sem prefixo', async () => {
    const conhecido = { id: 'local-1', metaTemplateId: 'm4', organizationId: ORG_A, scope: 'org' };
    const { s, prisma } = servico(ORG_A, [conhecido]);
    await s.sync(ORG_A);
    // inclui metaTemplateId nos campos do update (I3): sem isso, uma linha
    // que um dia perdeu o id (metaTemplateId nulo) e voltou a ser vista com
    // id conhecido nunca teria essa reconciliacao registrada
    expect(prisma.template.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'local-1' },
        data: expect.objectContaining({ metaTemplateId: 'm4' }),
      }),
    );
  });

  it('linha ja rastreada mas de outra organizacao nao e atualizada nem duplicada (residuo do vazamento antigo)', async () => {
    // a org B tem o template m2 na Meta, mas um sync anterior a este
    // isolamento (o bug que a Tarefa 6 fechou) deixou a linha local
    // registrada sob a org A. Rodar o sync da org B agora nao pode nem
    // atualizar a linha alheia nem criar uma segunda para o mesmo id.
    const vazada = { id: 'local-vazada', metaTemplateId: 'm2', organizationId: ORG_A, scope: 'org' };
    const { s, prisma, criados } = servico(ORG_B, [vazada]);
    await s.sync(ORG_B);
    expect(prisma.template.update).not.toHaveBeenCalled();
    expect(criados.map((t) => t.metaTemplateId)).not.toContain('m2');
  });

  it('um P2002 no meio do lote nao interrompe os templates seguintes', async () => {
    // simula uma linha local que ja existe (organizationId, name, language)
    // sem estar rastreada por metaTemplateId ainda: o create do primeiro
    // template bate no indice unico. Isso nao pode derrubar o create do
    // template seguinte no mesmo lote.
    const criados: any[] = [];
    const colisao = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002', clientVersion: '5.20.0',
    });
    const prisma: any = {
      whatsappChannel: {
        findFirst: jest.fn().mockResolvedValue({
          connectedVia: 'manual', wabaId: 'WABA_COMPARTILHADA', accessTokenEnc: 'TOKEN',
        }),
      },
      template: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        create: jest.fn((args: any) => {
          if (args.data.metaName === `${PREFIXO_A}_promocao`) return Promise.reject(colisao);
          criados.push(args.data);
          return Promise.resolve(args.data);
        }),
      },
    };
    const s = new TemplatesService(prisma, cfg(COMPLETA), {} as any);
    (s as any).buscarRemotos = jest.fn().mockResolvedValue(remotos);

    const r: any = await s.sync(ORG_A);

    expect(r.synced).toBe(true);
    expect(criados.map((t) => t.metaName)).toEqual(['zaplane_lembrete']);
    expect(r.criados).toBe(1);
  });

  it('a resposta ao cliente nao vaza quantos templates as outras organizacoes tem', async () => {
    const { s } = servico(ORG_A);
    const r: any = await s.sync(ORG_A);
    // dos 4 remotos: 1 da org A e 1 generico sao desta organizacao (2
    // processados); o da org B e o sem prefixo sao de fora — nem contam nem
    // aparecem na resposta. O detalhe completo (com ignorados) fica so no
    // log do servidor.
    expect(r.criados).toBe(2);
    expect(r.total).toBe(2);
    expect(r).not.toHaveProperty('ignorados');
  });
});

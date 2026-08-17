import { TemplatesService } from './templates.service';

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

  // a WABA tem: um template da org A, um da org B, um generico e um sem prefixo
  const remotos = [
    { name: 'zaaaaaaaa_promocao', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING', id: 'm1', components: [{ type: 'BODY', text: 'oi {{1}}' }] },
    { name: 'zbbbbbbbb_promocao', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING', id: 'm2', components: [{ type: 'BODY', text: 'ola' }] },
    { name: 'zaplane_lembrete',   language: 'pt_BR', status: 'APPROVED', category: 'UTILITY',   id: 'm3', components: [{ type: 'BODY', text: 'lembrete' }] },
    { name: 'hello_world',        language: 'en_US', status: 'APPROVED', category: 'UTILITY',   id: 'm4', components: [{ type: 'BODY', text: 'hi' }] },
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
    expect(nomes).toContain('zaaaaaaaa_promocao');
    expect(nomes).not.toContain('zbbbbbbbb_promocao');
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
    const meu = criados.find((t) => t.metaName === 'zaaaaaaaa_promocao');
    expect(meu.scope).toBe('org');
    expect(meu.organizationId).toBe(ORG_A);
  });

  it('template ja rastreado por meta_template_id continua sendo atualizado, mesmo sem prefixo', async () => {
    const conhecido = { id: 'local-1', metaTemplateId: 'm4' };
    const { s, prisma } = servico(ORG_A, [conhecido]);
    await s.sync(ORG_A);
    expect(prisma.template.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'local-1' } }),
    );
  });

  it('conta os ignorados', async () => {
    const { s } = servico(ORG_A);
    const r: any = await s.sync(ORG_A);
    // dos 4 remotos: 1 da org A, 1 generico, 1 da org B ignorado, 1 sem prefixo ignorado
    expect(r.criados).toBe(2);
    expect(r.ignorados).toBe(2);
  });
});

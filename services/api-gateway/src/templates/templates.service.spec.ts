import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import axios from 'axios';
import { TemplatesService } from './templates.service';
import { PlataformaService } from '../common/plataforma.service';
import { prefixoDaOrg } from './meta-nome';

// axios mockado no arquivo inteiro: nenhum teste daqui pode alcançar a rede, e
// é o que deixa "a submissão não aconteceu" ser afirmado de verdade
// (`axios.post` não chamado) em vez de inferido do valor de retorno.
jest.mock('axios');

// sem isto, "axios.post não foi chamado" herdaria as chamadas do teste anterior
beforeEach(() => jest.clearAllMocks());

const cfg = (vals: Record<string, any>) => ({ get: (k: string) => vals[k] } as any);
const COMPLETA = {
  'whatsapp.graphVersion': 'v21.0',
  'whatsapp.accessToken': 'TOKEN_PLATAFORMA',
  'assisted.wabaId': 'WABA_ZAPLANE',
  assisted: { wabaId: 'WABA_ZAPLANE' },
};
// PlataformaService de verdade, não fake: o critério por canal é justamente o
// que estes testes precisam exercitar. Prisma nulo de propósito — se algum
// caminho aqui chamar `orgNaWabaDaPlataforma` (a pergunta por ORGANIZAÇÃO, que
// é a errada depois de o canal já ter sido escolhido), o teste estoura em vez
// de passar calado.
const plataformaCom = (vals: Record<string, any> = COMPLETA) =>
  new PlataformaService(null as any, cfg(vals));
const prismaCom = (canal: any) =>
  ({ whatsappChannel: { findFirst: jest.fn().mockResolvedValue(canal) } } as any);

describe('TemplatesService.resolverCredenciais', () => {
  const resolver = (s: TemplatesService, orgId = 'org') => (s as any).resolverCredenciais(orgId);

  it('canal assistido usa token e WABA da plataforma', async () => {
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'assisted', wabaId: 'WABA_ZAPLANE', accessTokenEnc: '' }),
      cfg(COMPLETA), plataformaCom(),
    );
    expect(await resolver(s)).toEqual({ wabaId: 'WABA_ZAPLANE', token: 'TOKEN_PLATAFORMA', plataforma: true });
  });

  it('canal legado usa a WABA e o token da propria linha', async () => {
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'manual', wabaId: 'WABA_CLIENTE', accessTokenEnc: 'TOKEN_CLIENTE' }),
      cfg(COMPLETA), plataformaCom(),
    );
    expect(await resolver(s)).toEqual({ wabaId: 'WABA_CLIENTE', token: 'TOKEN_CLIENTE', plataforma: false });
  });

  it('canal na WABA da plataforma sem connected_via assistido tambem usa a plataforma', async () => {
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'manual', wabaId: 'WABA_ZAPLANE', accessTokenEnc: '' }),
      cfg(COMPLETA), plataformaCom(),
    );
    expect((await resolver(s))?.plataforma).toBe(true);
  });

  it('canal assistido sem token da plataforma devolve nulo em vez de chamar a Meta com token vazio', async () => {
    const vals = { ...COMPLETA, 'whatsapp.accessToken': '' };
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'assisted', wabaId: 'WABA_ZAPLANE', accessTokenEnc: '' }),
      cfg(vals), plataformaCom(vals),
    );
    expect(await resolver(s)).toBeNull();
  });

  it('sem canal ativo devolve nulo', async () => {
    const s = new TemplatesService(prismaCom(null), cfg(COMPLETA), plataformaCom());
    expect(await resolver(s)).toBeNull();
  });

  it('canal legado com placeholder de seed devolve nulo', async () => {
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'manual', wabaId: 'COLOQUE_AQUI', accessTokenEnc: 'COLOQUE_AQUI' }),
      cfg(COMPLETA), plataformaCom(),
    );
    expect(await resolver(s)).toBeNull();
  });
});

describe('TemplatesService.findAll', () => {
  const consulta = async (naPlataforma: boolean) => {
    const prisma: any = { template: { findMany: jest.fn().mockResolvedValue([]) } };
    const plataforma: any = { orgNaWabaDaPlataforma: jest.fn().mockResolvedValue(naPlataforma) };
    const s = new TemplatesService(prisma, cfg(COMPLETA), plataforma);
    await s.findAll('org');
    return prisma.template.findMany.mock.calls[0][0].where;
  };

  it('cliente da WABA da plataforma ve os proprios e os genericos', async () => {
    expect(await consulta(true)).toEqual({
      OR: [{ organizationId: 'org' }, { scope: 'platform' }],
    });
  });

  it('cliente de WABA propria NAO ve generico', async () => {
    // generico vive na WABA da Zaplane; disparar de outra WABA morre na Meta
    expect(await consulta(false)).toEqual({ organizationId: 'org' });
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

  // O canal decide QUAL WABA o sync acabou de ler — e é isso que diz se o
  // prefixo dos genéricos vale ali. Assistido: a WABA é a da Zaplane. Legado:
  // a WABA é do próprio cliente, que tem acesso ao WhatsApp Manager dela e
  // portanto escolhe os nomes que quiser lá dentro.
  const CANAL_PLATAFORMA = { connectedVia: 'assisted', wabaId: 'WABA_ZAPLANE', accessTokenEnc: '' };
  const CANAL_LEGADO = { connectedVia: 'manual', wabaId: 'WABA_PROPRIA_DO_CLIENTE', accessTokenEnc: 'TOKEN' };

  function servico(orgId: string, conhecidos: any[] = [], canal: any = CANAL_PLATAFORMA) {
    const criados: any[] = [];
    const prisma: any = {
      whatsappChannel: { findFirst: jest.fn().mockResolvedValue(canal) },
      template: {
        findFirst: jest.fn(({ where }: any) =>
          Promise.resolve(conhecidos.find((t) => t.metaTemplateId === where.metaTemplateId) ?? null)),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn((args: any) => { criados.push(args.data); return Promise.resolve(args.data); }),
      },
    };
    const s = new TemplatesService(prisma, cfg(COMPLETA), plataformaCom());
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

  it('generico entra com escopo de plataforma e sem dono — quando a WABA lida E a da plataforma', async () => {
    const { s, criados } = servico(ORG_A, [], CANAL_PLATAFORMA);
    await s.sync(ORG_A);
    const generico = criados.find((t) => t.metaName === 'zaplane_lembrete');
    expect(generico.scope).toBe('platform');
    expect(generico.organizationId).toBeNull();
  });

  it('nome com prefixo de generico vindo de WABA que NAO e a da plataforma nao vira generico de ninguem', async () => {
    // O caminho do vazamento: um cliente legado tem WABA própria e, por
    // construção (ele forneceu waba_id/app_id/app_secret/token), acesso ao
    // WhatsApp Manager dela. Ele cria lá um template chamado `zaplane_lembrete`
    // e chama POST /templates/sync. Nada no modelo registra em qual WABA um
    // template de escopo 'platform' vive — se o prefixo bastasse, o corpo da
    // mensagem DELE nasceria como genérico da Zaplane, visível e disparável por
    // todo cliente assistido, e ainda ocuparia o nome no índice único parcial
    // dos genéricos, barrando o verdadeiro para sempre.
    const { s, criados } = servico(ORG_A, [], CANAL_LEGADO);
    await s.sync(ORG_A);

    expect(criados.map((t) => t.metaName)).not.toContain('zaplane_lembrete');
    expect(criados.some((t) => t.scope === 'platform')).toBe(false);
    expect(criados.some((t) => t.organizationId === null)).toBe(false);
    // e o template da própria organização continua entrando normalmente: a
    // trava é sobre o prefixo dos genéricos fora da WABA da plataforma, não
    // sobre o sync do cliente legado inteiro
    expect(criados.map((t) => t.metaName)).toContain(`${PREFIXO_A}_promocao`);
  });

  it('generico so nasce em sync de WABA da plataforma — na WABA propria ele e apenas ignorado', async () => {
    // Prova de contagem, complementar à anterior: o `zaplane_lembrete` da WABA
    // alheia não vira linha nem de escopo 'org' com dono trocado — ele
    // simplesmente cai no mesmo `ignorados` de qualquer nome sem prefixo
    // conhecido (o `hello_world` da lista).
    const { s: legado, criados: doLegado } = servico(ORG_A, [], CANAL_LEGADO);
    const rLegado: any = await legado.sync(ORG_A);
    const { s: assistido, criados: doAssistido } = servico(ORG_A, [], CANAL_PLATAFORMA);
    const rAssistido: any = await assistido.sync(ORG_A);

    expect(doLegado.map((t) => t.metaName)).toEqual([`${PREFIXO_A}_promocao`]);
    expect(rLegado.criados).toBe(1);
    expect(doAssistido.map((t) => t.metaName)).toEqual([`${PREFIXO_A}_promocao`, 'zaplane_lembrete']);
    expect(rAssistido.criados).toBe(2);
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
    // category/status/body vem da Meta a cada sync (é a fonte da verdade).
    // metaTemplateId NAO entra no update: a linha só chega aqui por ter sido
    // encontrada com `where: { metaTemplateId: r.id }`, então reescrevê-lo
    // seria sempre o mesmo valor já gravado — reescrita inerte.
    expect(prisma.template.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'local-1' },
        data: expect.objectContaining({ category: 'UTILITY', status: 'APPROVED' }),
      }),
    );
  });

  it('generico ja rastreado continua sendo atualizado mesmo nao pertencendo a esta organizacao', async () => {
    // m3 é o template genérico (`zaplane_lembrete`) na lista de remotos. Uma
    // linha local já rastreada por metaTemplateId, com scope 'platform' e sem
    // dono, tem que ser atualizada mesmo o sync estar rodando pela ORG_A —
    // é a cláusula `scope === 'platform'` do OR que garante isso. Removê-la
    // faria a plataforma parar de sincronizar o próprio catálogo genérico.
    const generico = { id: 'local-generico', metaTemplateId: 'm3', organizationId: null, scope: 'platform' };
    const { s, prisma } = servico(ORG_A, [generico]);
    await s.sync(ORG_A);
    expect(prisma.template.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'local-generico' } }),
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
      whatsappChannel: { findFirst: jest.fn().mockResolvedValue(CANAL_PLATAFORMA) },
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
    const s = new TemplatesService(prisma, cfg(COMPLETA), plataformaCom());
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

describe('TemplatesService.create', () => {
  const ORG = 'cc96458b-1239-4906-b23b-45d27545b620';

  function servico() {
    const criado: any = {};
    const prisma: any = {
      whatsappChannel: { findFirst: jest.fn().mockResolvedValue({
        connectedVia: 'assisted', wabaId: 'WABA_ZAPLANE', accessTokenEnc: '' }) },
      template: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn((a: any) => { Object.assign(criado, a.data); return Promise.resolve({ id: 't1', ...a.data }); }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const s = new TemplatesService(prisma, cfg(COMPLETA), plataformaCom());
    (s as any).submitToMeta = jest.fn().mockResolvedValue({ id: 'meta-1' });
    return { s, prisma, criado };
  }

  const dto = { name: 'Promoção de Banho', category: 'MARKETING', body: 'Oi {{1}}' } as any;

  it('grava o nome de exibicao e o meta_name prefixado', async () => {
    const { s, criado } = servico();
    await s.create(ORG, dto, { plataforma: false });
    expect(criado.name).toBe('Promoção de Banho');
    // I4 alargou o prefixo da organização de 8 para 12 caracteres hexadecimais
    // (ver meta-nome.ts) — este valor é o prefixo de 13 caracteres, não 9.
    expect(criado.metaName).toBe('zcc96458b1239_promocao_de_banho');
    expect(criado.scope).toBe('org');
    expect(criado.organizationId).toBe(ORG);
  });

  it('generico nasce sem dono e com prefixo da plataforma', async () => {
    const { s, criado } = servico();
    await s.create(ORG, { ...dto, name: 'Lembrete de agendamento' }, { plataforma: true });
    expect(criado.metaName).toBe('zaplane_lembrete_de_agendamento');
    expect(criado.scope).toBe('platform');
    expect(criado.organizationId).toBeNull();
  });

  it('submete a Meta o meta_name, nunca o nome de exibicao', async () => {
    const { s } = servico();
    await s.create(ORG, dto, { plataforma: false });
    const enviado = (s as any).submitToMeta.mock.calls[0][1];
    expect(enviado.metaName).toBe('zcc96458b1239_promocao_de_banho');
  });

  it('nome que fica vazio depois de normalizar vira 400, sem gravar nada', async () => {
    const { s, prisma } = servico();
    await expect(s.create(ORG, { ...dto, name: '!!! ---' }, { plataforma: false }))
      .rejects.toThrow(BadRequestException);
    expect(prisma.template.create).not.toHaveBeenCalled();
  });

  it('dois rotulos que normalizam igual: o segundo e recusado antes de qualquer chamada a Meta', async () => {
    // findFirst de verdade (não sempre-null): busca pelo meta_name entre o
    // que já foi criado, exatamente como a checagem de duplicata faz.
    const criados: any[] = [];
    const prisma: any = {
      whatsappChannel: { findFirst: jest.fn().mockResolvedValue({
        connectedVia: 'assisted', wabaId: 'WABA_ZAPLANE', accessTokenEnc: '' }) },
      template: {
        findFirst: jest.fn(({ where }: any) =>
          Promise.resolve(criados.find((t) => t.metaName === where.metaName) ?? null)),
        create: jest.fn((a: any) => {
          criados.push(a.data);
          return Promise.resolve({ id: `t${criados.length}`, ...a.data });
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const s = new TemplatesService(prisma, cfg(COMPLETA), plataformaCom());
    (s as any).submitToMeta = jest.fn().mockResolvedValue({ id: 'meta-1' });

    await s.create(ORG, { ...dto, name: 'Promoção de Banho' }, { plataforma: false });
    (s as any).submitToMeta.mockClear();

    await expect(
      s.create(ORG, { ...dto, name: 'PROMOÇÃO DE BANHO!!!' }, { plataforma: false }),
    ).rejects.toThrow(ConflictException);
    // a checagem de duplicata barra antes de tentar submeter à Meta
    expect((s as any).submitToMeta).not.toHaveBeenCalled();
    expect(criados).toHaveLength(1);
  });
});

// "Meu template não foi aprovado" chega dias depois, com o navegador do cliente
// já fechado. Se o motivo só existiu no `console.info` dele e nos dois `return`
// mudos do sync, não há onde olhar. Estes testes prendem o registro no servidor
// — e prendem também o que NÃO pode entrar nele.
describe('TemplatesService — rastro no servidor quando a Meta recusa', () => {
  const ORG = 'cc96458b-1239-4906-b23b-45d27545b620';
  const CORPO_DO_CLIENTE = 'Oi {{1}}, seu pet está pronto para buscar na Petshop Amiga';

  const espiar = (s: TemplatesService) => jest.spyOn((s as any).logger, 'warn').mockImplementation(() => {});

  it('sync sem credencial da Meta registra WARN em vez de sair calado', async () => {
    const s = new TemplatesService(prismaCom(null), cfg(COMPLETA), plataformaCom());
    const warn = espiar(s);
    const r: any = await s.sync(ORG);
    expect(r.synced).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(ORG));
  });

  it('sync que falha na chamada a Meta registra o codigo do erro dela', async () => {
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'assisted', wabaId: 'WABA_ZAPLANE', accessTokenEnc: '' }),
      cfg(COMPLETA), plataformaCom(),
    );
    (s as any).buscarRemotos = jest.fn().mockRejectedValue({
      message: 'Request failed with status code 400',
      response: { data: { error: { code: 190, error_subcode: 463, message: 'Session has expired' } } },
    });
    const warn = espiar(s);
    const r: any = await s.sync(ORG);
    expect(r.synced).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('code=190'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('subcode=463'));
  });

  it('falha ao submeter registra o codigo da Meta e NAO registra o corpo do cliente nem o token', async () => {
    const prisma: any = {
      whatsappChannel: { findFirst: jest.fn().mockResolvedValue({
        connectedVia: 'assisted', wabaId: 'WABA_ZAPLANE', accessTokenEnc: '' }) },
      template: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn((a: any) => Promise.resolve({ id: 't1', ...a.data })),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const s = new TemplatesService(prisma, cfg(COMPLETA), plataformaCom());
    (s as any).submitToMeta = jest.fn().mockRejectedValue({
      message: 'Request failed with status code 400',
      response: { data: { error: { code: 100, error_subcode: 2388043, message: 'Template name is invalid' } } },
    });
    const warn = espiar(s);

    await s.create(ORG, { name: 'Promoção de Banho', category: 'MARKETING', body: CORPO_DO_CLIENTE } as any,
      { plataforma: false });

    const registrado = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(registrado).toContain('code=100');
    expect(registrado).toContain('subcode=2388043');
    expect(registrado).toContain('zcc96458b1239_promocao_de_banho');
    // conteúdo do cliente e credencial da plataforma NUNCA entram no log
    expect(registrado).not.toContain(CORPO_DO_CLIENTE);
    expect(registrado).not.toContain('TOKEN_PLATAFORMA');
  });

  it('template da organizacao que nem chega a ser submetido (sem canal) deixa rastro', async () => {
    // Rascunho legítimo: o cliente ainda não conectou canal nenhum, a linha
    // fica dele, ele a vê na tela e o sync a adota depois pelo prefixo. O que
    // não pode é isso acontecer em silêncio, como acontecia.
    const prisma: any = {
      whatsappChannel: { findFirst: jest.fn().mockResolvedValue(null) },
      template: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn((a: any) => Promise.resolve({ id: 't1', ...a.data })),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const s = new TemplatesService(prisma, cfg(COMPLETA), plataformaCom());
    const warn = espiar(s);

    const r: any = await s.create(ORG, { name: 'Lembrete', category: 'UTILITY', body: 'oi' } as any,
      { plataforma: false });

    expect(r.metaWarning).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NÃO submetido à Meta'));
  });
});

// Gêmeo do Critical, do outro lado do arquivo: `sync()` descartava o
// `plataforma` de resolverCredenciais e adotava template alheio COMO genérico;
// `submitToMeta` o descartava e criaria o genérico DENTRO da WABA de um
// cliente. Mesma forma, sinal trocado.
describe('TemplatesService.create — generico exige a WABA da plataforma', () => {
  const ORG = 'cc96458b-1239-4906-b23b-45d27545b620';
  const dto = { name: 'Lembrete de agendamento', category: 'UTILITY', body: 'oi' } as any;

  const servico = (canal: any) => {
    const prisma: any = {
      whatsappChannel: { findFirst: jest.fn().mockResolvedValue(canal) },
      template: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn((a: any) => Promise.resolve({ id: 't1', ...a.data })),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const s = new TemplatesService(prisma, cfg(COMPLETA), plataformaCom());
    const warn = jest.spyOn((s as any).logger, 'warn').mockImplementation(() => {});
    return { s, prisma, warn };
  };

  const CANAL_LEGADO = { connectedVia: 'manual', wabaId: 'WABA_PROPRIA', accessTokenEnc: 'TOKEN_CLIENTE' };
  const CANAL_PLATAFORMA = { connectedVia: 'assisted', wabaId: 'WABA_ZAPLANE', accessTokenEnc: '' };

  it('operador cujo canal esta em OUTRA WABA: recusa, nao grava nada e nao chama a Meta', async () => {
    const { s, prisma, warn } = servico(CANAL_LEGADO);

    await expect(s.create(ORG, dto, { plataforma: true })).rejects.toBeInstanceOf(ServiceUnavailableException);

    // o ponto todo da recusa vir ANTES de gravar: sem linha, não há rascunho
    // preso — a linha `scope: 'platform'` PENDING seria visível para todo
    // cliente assistido e não teria rota de conserto pela aplicação
    expect(prisma.template.create).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    // e a operação enxerga o motivo
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recusado criar template genérico'));
  });

  it('operador sem canal ativo nenhum: mesma recusa, pelo mesmo motivo', async () => {
    const { s, prisma, warn } = servico(null);
    await expect(s.create(ORG, dto, { plataforma: true })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.template.create).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recusado criar template genérico'));
  });

  it('a recusa diz ao operador o que fazer, sem falhar calado', async () => {
    const { s } = servico(CANAL_LEGADO);
    await expect(s.create(ORG, dto, { plataforma: true })).rejects.toThrow(/canal ativo na WABA da Zaplane/);
    await expect(s.create(ORG, dto, { plataforma: true })).rejects.toThrow(/Nada foi salvo/);
  });

  it('operador na WABA da plataforma cria normalmente — a trava e estreita', async () => {
    const { s, prisma } = servico(CANAL_PLATAFORMA);
    (axios.post as jest.Mock).mockResolvedValue({ data: { id: 'meta-1' } });
    await expect(s.create(ORG, dto, { plataforma: true })).resolves.toMatchObject({ scope: 'platform' });
    expect(prisma.template.create).toHaveBeenCalled();
  });

  it('template da propria organizacao NAO e afetado: canal em WABA propria cria e submete', async () => {
    // a trava é sobre escopo de plataforma; o caminho do cliente comum segue
    // exatamente como era, inclusive submetendo pela WABA dele
    const { s, prisma } = servico(CANAL_LEGADO);
    (axios.post as jest.Mock).mockResolvedValue({ data: { id: 'meta-2' } });
    await expect(s.create(ORG, dto, { plataforma: false })).resolves.toMatchObject({ scope: 'org' });
    expect(prisma.template.create).toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalled();
  });
});

describe('TemplatesService.submitToMeta — ultima linha de defesa', () => {
  const ORG = 'cc96458b-1239-4906-b23b-45d27545b620';
  const submeter = (s: TemplatesService, scope: string) =>
    (s as any).submitToMeta(ORG, {
      metaName: 'zaplane_lembrete', language: 'pt_BR', category: 'UTILITY',
      body: 'oi', variablesCount: 0, scope,
    });

  it('escopo de plataforma + credenciais que NAO sao da plataforma: nao submete', async () => {
    // O cenário exato do gêmeo. Submeter aqui criaria `zaplane_lembrete` dentro
    // da WABA de um cliente, e a linha local (scope 'platform', visível a todo
    // cliente assistido) passaria a apontar para um template que não existe na
    // WABA de onde eles enviam — 132001 no disparo, para todos.
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'manual', wabaId: 'WABA_PROPRIA', accessTokenEnc: 'TOKEN_CLIENTE' }),
      cfg(COMPLETA), plataformaCom(),
    );

    const r = await submeter(s, 'platform');

    expect(axios.post).not.toHaveBeenCalled();
    expect(r.id).toBeUndefined();
    expect(r.skipped).toBeTruthy();
  });

  it('escopo de plataforma + credenciais da plataforma: submete', async () => {
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'assisted', wabaId: 'WABA_ZAPLANE', accessTokenEnc: '' }),
      cfg(COMPLETA), plataformaCom(),
    );
    (axios.post as jest.Mock).mockResolvedValue({ data: { id: 'meta-3' } });

    expect((await submeter(s, 'platform')).id).toBe('meta-3');
    // e vai para a WABA da plataforma, não para outra
    expect((axios.post as jest.Mock).mock.calls[0][0]).toContain('WABA_ZAPLANE');
  });

  it('escopo de organizacao pelas credenciais dela: submete — a trava nao pega o caminho comum', async () => {
    const s = new TemplatesService(
      prismaCom({ connectedVia: 'manual', wabaId: 'WABA_PROPRIA', accessTokenEnc: 'TOKEN_CLIENTE' }),
      cfg(COMPLETA), plataformaCom(),
    );
    (axios.post as jest.Mock).mockResolvedValue({ data: { id: 'meta-4' } });

    expect((await submeter(s, 'org')).id).toBe('meta-4');
    expect((axios.post as jest.Mock).mock.calls[0][0]).toContain('WABA_PROPRIA');
  });
});

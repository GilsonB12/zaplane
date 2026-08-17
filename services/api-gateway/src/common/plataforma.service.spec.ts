import { PlataformaService } from './plataforma.service';

const cfg = (wabaId: string) => ({ get: (k: string) => (k === 'assisted.wabaId' ? wabaId : undefined) } as any);
const prisma = (n: number) => ({ whatsappChannel: { count: jest.fn().mockResolvedValue(n) } } as any);

describe('PlataformaService.orgNaWabaDaPlataforma', () => {
  it('verdadeiro quando a organizacao tem canal na WABA da plataforma', async () => {
    const s = new PlataformaService(prisma(1), cfg('W'));
    expect(await s.orgNaWabaDaPlataforma('org')).toBe(true);
  });

  it('falso quando nao tem canal nenhum', async () => {
    const s = new PlataformaService(prisma(0), cfg('W'));
    expect(await s.orgNaWabaDaPlataforma('org')).toBe(false);
  });

  it('com ZAPLANE_WABA_ID vazio, ainda reconhece por connected_via', async () => {
    const p = prisma(1);
    const s = new PlataformaService(p, cfg(''));
    expect(await s.orgNaWabaDaPlataforma('org')).toBe(true);
    const where = p.whatsappChannel.count.mock.calls[0][0].where;
    // sem wabaId, o OR nao pode conter filtro por waba vazia (casaria com nada
    // e a trava sumiria para quem realmente divide a WABA)
    expect(where.OR).toEqual([{ connectedVia: 'assisted' }]);
  });

  it('com ZAPLANE_WABA_ID definido, consulta os dois criterios', async () => {
    const p = prisma(1);
    const s = new PlataformaService(p, cfg('W'));
    await s.orgNaWabaDaPlataforma('org');
    const where = p.whatsappChannel.count.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ wabaId: 'W' }, { connectedVia: 'assisted' }]);
    expect(where.organizationId).toBe('org');
  });
});

// A outra pergunta: "este CANAL, o que vai enviar, é da WABA da Zaplane?".
// Ela é o que decide se o genérico pode ser selecionado num disparo — a
// pergunta por organização responde "sim" para quem tem canal legado E número
// assistido, e disparar o genérico pelo legado morre na Meta com 132001.
describe('PlataformaService.canalNaWabaDaPlataforma', () => {
  // prisma nulo: a pergunta por canal não pode consultar o banco — ela decide
  // sobre a linha que o chamador já escolheu.
  const servico = (wabaId: string) => new PlataformaService(null as any, cfg(wabaId));

  it('canal assistido e da plataforma', () => {
    expect(servico('W').canalNaWabaDaPlataforma({ connectedVia: 'assisted', wabaId: 'W' })).toBe(true);
  });

  it('canal legado apontando para a WABA da plataforma tambem e', () => {
    expect(servico('W').canalNaWabaDaPlataforma({ connectedVia: 'manual', wabaId: 'W' })).toBe(true);
  });

  it('canal legado em WABA propria NAO e', () => {
    expect(servico('W').canalNaWabaDaPlataforma({ connectedVia: 'manual', wabaId: 'OUTRA' })).toBe(false);
  });

  it('com ZAPLANE_WABA_ID vazio, so o connected_via decide — waba vazia nao casa com ninguem', () => {
    expect(servico('').canalNaWabaDaPlataforma({ connectedVia: 'assisted', wabaId: 'W' })).toBe(true);
    expect(servico('').canalNaWabaDaPlataforma({ connectedVia: 'manual', wabaId: '' })).toBe(false);
    expect(servico('').canalNaWabaDaPlataforma({ connectedVia: 'manual', wabaId: null })).toBe(false);
  });

  it('sem canal, falso — nunca lanca', () => {
    expect(servico('W').canalNaWabaDaPlataforma(null)).toBe(false);
    expect(servico('W').canalNaWabaDaPlataforma(undefined)).toBe(false);
  });
});

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

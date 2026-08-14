import { ForbiddenException } from '@nestjs/common';
import { QuotaService } from './quota.service';

const cfg = { get: () => ({ orgDailyQuota: 200 }) } as any;
const prismaCom = (usados: number) =>
  ({ $queryRaw: jest.fn().mockResolvedValue([{ n: usados }]) } as any);

describe('QuotaService', () => {
  it('devolve o que resta do dia', async () => {
    const s = new QuotaService(prismaCom(150), cfg);
    expect(await s.destinatariosRestantes('ORG')).toBe(50);
  });

  it('deixa passar quando cabe', async () => {
    const s = new QuotaService(prismaCom(150), cfg);
    await expect(s.garantirCota('ORG', 50)).resolves.toBeUndefined();
  });

  it('bloqueia quando estoura', async () => {
    const s = new QuotaService(prismaCom(150), cfg);
    await expect(s.garantirCota('ORG', 51)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('nunca devolve negativo', async () => {
    const s = new QuotaService(prismaCom(500), cfg);
    expect(await s.destinatariosRestantes('ORG')).toBe(0);
  });
});

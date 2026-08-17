import { ForbiddenException } from '@nestjs/common';
import { QuotaService } from './quota.service';
import { PlataformaService } from './plataforma.service';

const WABA_ZAPLANE = 'WABA-ZAPLANE';

const cfg = (wabaId: string = WABA_ZAPLANE) =>
  ({
    get: (chave: string) => (chave === 'assisted.wabaId' ? wabaId : { orgDailyQuota: 200 }),
  } as any);

// QuotaService não constrói mais PlataformaService sozinho (era um default de
// parâmetro só para não quebrar este arquivo) — em produção quem monta os
// três argumentos é o Nest, via QuotaModule. Aqui, quem monta é este helper,
// com a MESMA instância de prisma/config passada às duas classes — exatamente
// o que o default fazia. Os testes seguem exercitando o PlataformaService de
// verdade (não um mock), porque é o `where.OR` real que `prismaCom` avalia.
const servico = (prisma: any, config: any) =>
  new QuotaService(prisma, config, new PlataformaService(prisma, config));

type Canal = { wabaId: string; connectedVia: string };
const NA_ZAPLANE: Canal = { wabaId: WABA_ZAPLANE, connectedVia: 'assisted' };
const WABA_PROPRIA: Canal = { wabaId: 'WABA-DO-CLIENTE', connectedVia: 'manual' };

/** Fake do count() que avalia de verdade o `where.OR` montado pelo serviço
 *  contra os canais da organização — sem isso o teste só confirmaria que
 *  alguma consulta foi feita, e passaria com qualquer filtro (ou sem filtro
 *  nenhum). O `organizationId` do where é conferido à parte, no teste próprio;
 *  a lista abaixo já representa os canais de UMA organização. */
const prismaCom = (canais: Canal[], usados = 0) =>
  ({
    whatsappChannel: {
      count: jest.fn(({ where }: any) =>
        Promise.resolve(
          canais.filter((c) =>
            ((where.OR ?? []) as any[]).some((cond) =>
              cond.wabaId !== undefined
                ? c.wabaId === cond.wabaId
                : c.connectedVia === cond.connectedVia,
            ),
          ).length,
        ),
      ),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ n: usados }]),
  } as any);

describe('QuotaService — organização na WABA da Zaplane (compartilha o portfólio)', () => {
  it('devolve o que resta do dia', async () => {
    const s = servico(prismaCom([NA_ZAPLANE], 150), cfg());
    expect(await s.destinatariosRestantes('ORG')).toBe(50);
  });

  it('deixa passar quando cabe', async () => {
    const s = servico(prismaCom([NA_ZAPLANE], 150), cfg());
    await expect(s.garantirCota('ORG', 50)).resolves.toBeUndefined();
  });

  it('bloqueia quando estoura', async () => {
    const s = servico(prismaCom([NA_ZAPLANE], 150), cfg());
    await expect(s.garantirCota('ORG', 51)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('nunca devolve negativo', async () => {
    const s = servico(prismaCom([NA_ZAPLANE], 500), cfg());
    expect(await s.destinatariosRestantes('ORG')).toBe(0);
  });

  it('conta canais só da organização do JWT', async () => {
    const prisma = prismaCom([NA_ZAPLANE], 0);
    await servico(prisma, cfg()).sujeitaACota('ORG');
    expect(prisma.whatsappChannel.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: 'ORG' }) }),
    );
  });
});

describe('QuotaService — organização com WABA própria (não compartilha nada)', () => {
  // O limite de mensagens da Meta é do PORTFÓLIO. Cliente legado tem portfólio
  // dele; a cota de 200/dia não tem base nenhuma ali e o 403 cairia no meio de
  // uma campanha que antes funcionava.
  it('não tem cota: destinatariosRestantes devolve null', async () => {
    const s = servico(prismaCom([WABA_PROPRIA], 500), cfg());
    expect(await s.destinatariosRestantes('ORG')).toBeNull();
  });

  it('deixa passar um volume muito acima do limite', async () => {
    const s = servico(prismaCom([WABA_PROPRIA], 500), cfg());
    await expect(s.garantirCota('ORG', 5000)).resolves.toBeUndefined();
  });

  it('nem consulta o uso das últimas 24h', async () => {
    const prisma = prismaCom([WABA_PROPRIA], 500);
    await servico(prisma, cfg()).garantirCota('ORG', 5000);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('organização sem canal nenhum também fica de fora', async () => {
    const s = servico(prismaCom([], 500), cfg());
    expect(await s.destinatariosRestantes('ORG')).toBeNull();
  });
});

describe('QuotaService — ZAPLANE_WABA_ID ausente', () => {
  // Sem a variável, comparar waba_id com '' não casaria com nada e a trava
  // sumiria justamente para quem divide o portfólio. O vínculo é reconhecido
  // pelo connected_via gravado na linha do canal.
  it('mantém a cota para quem tem canal assistido', async () => {
    const s = servico(prismaCom([{ wabaId: WABA_ZAPLANE, connectedVia: 'assisted' }], 150), cfg(''));
    expect(await s.destinatariosRestantes('ORG')).toBe(50);
  });

  it('continua sem cota para quem tem WABA própria', async () => {
    const s = servico(prismaCom([WABA_PROPRIA], 500), cfg(''));
    expect(await s.destinatariosRestantes('ORG')).toBeNull();
  });
});

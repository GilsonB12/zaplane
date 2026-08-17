import { NotFoundException } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';

// Cobre só o que a Tarefa 8 tocou em CampaignsService.create: a busca do
// template (organização OU genérico, quando ela enxerga genérico) e o payload
// enfileirado (meta_name, nunca o rótulo). NÃO é a suíte completa do serviço
// — supressão, estimativa de custo e agendamento ficam fora, de propósito.

const ORG = 'ORG';
const USER = 'USER1';
const CHANNEL = { id: 'CH1', organizationId: ORG, status: 'active' };
const CONTACT = {
  id: 'C1', organizationId: ORG, phoneE164: '+5585999999999',
  optedOut: false, consentStatus: 'granted', deletedAt: null,
};

// UTILITY (não MARKETING): a supressão por consentimento não é escopo desta
// suíte, então a categoria escolhida não pode acionar aquele filtro.
const ORG_TEMPLATE = {
  id: 'T1', organizationId: ORG, scope: 'org', status: 'APPROVED',
  name: 'Boas-vindas', metaName: 'zorg_boas_vindas',
  language: 'pt_BR', category: 'UTILITY', variablesCount: 0,
};
const GENERICO = {
  id: 'T2', organizationId: null, scope: 'platform', status: 'APPROVED',
  name: 'Lembrete', metaName: 'zaplane_lembrete',
  language: 'pt_BR', category: 'UTILITY', variablesCount: 0,
};

const DTO_ORG = { name: 'Campanha teste', templateId: ORG_TEMPLATE.id, channelId: CHANNEL.id };
const DTO_GENERICO = { name: 'Campanha teste', templateId: GENERICO.id, channelId: CHANNEL.id };

/** Fake do findFirst que avalia de verdade o `where.OR` montado pelo serviço
 *  contra um catálogo fixo — sem isso o teste só confirmaria que alguma
 *  consulta foi feita, e passaria com qualquer filtro (mesmo padrão usado em
 *  quota.service.spec.ts para o `where.OR` do PlataformaService). */
const templateFindFirstFake = (templates: any[] = [ORG_TEMPLATE, GENERICO]) =>
  jest.fn(({ where }: any) =>
    Promise.resolve(
      templates.find((t) =>
        t.id === where.id &&
        ((where.OR ?? []) as any[]).some((cond) =>
          cond.organizationId !== undefined ? t.organizationId === cond.organizationId : t.scope === cond.scope,
        ),
      ) ?? null,
    ),
  );

function montar(over: any = {}) {
  const prisma: any = {
    whatsappChannel: { findFirst: jest.fn().mockResolvedValue(CHANNEL) },
    template: { findFirst: templateFindFirstFake() },
    contact: { findMany: jest.fn().mockResolvedValue([CONTACT]) },
    campaign: {
      create: jest.fn().mockResolvedValue({ id: 'CAMP1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    outboundMessage: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    ...over.prisma,
  };
  const billing = {
    estimatePlatformFee: jest.fn().mockResolvedValue({ totalCents: 10, cobraveis: 1, cotaUsada: 0, unitCents: 10 }),
    assertBalanceFor: jest.fn().mockResolvedValue(undefined),
    ...over.billing,
  };
  const quota = {
    garantirCota: jest.fn().mockResolvedValue(undefined),
    ...over.quota,
  };
  const plataforma = {
    orgNaWabaDaPlataforma: jest.fn().mockResolvedValue(false),
    ...over.plataforma,
  };
  return {
    svc: new CampaignsService(prisma as any, billing as any, quota as any, plataforma as any),
    prisma, billing, quota, plataforma,
  };
}

// O rótulo (name) é o que o cliente lê na tela; o meta_name é o que a Meta
// conhece do template. Mandar o rótulo faria a campanha inteira falhar na
// Meta com "template não encontrado" — ela nunca ouviu falar da string que
// aparece na nossa UI.
describe('CampaignsService.create — usa o meta_name no payload', () => {
  it('grava o meta_name no payload de outbound_messages, nunca o rotulo de exibicao', async () => {
    const { svc, prisma } = montar();
    await svc.create(ORG, USER, DTO_ORG);
    const rows = prisma.outboundMessage.createMany.mock.calls[0][0].data;
    expect(rows[0].payload.template.name).toBe(ORG_TEMPLATE.metaName);
  });
});

// Template pertence a uma WABA; um número só dispara template da WABA dele.
// O genérico vive na WABA da Zaplane, então só quem envia por ela pode
// selecioná-lo — do contrário o disparo morreria na Meta.
describe('CampaignsService.create — visibilidade do template generico', () => {
  it('cliente que envia pela WABA da plataforma consegue selecionar um generico', async () => {
    const { svc, prisma } = montar({
      plataforma: { orgNaWabaDaPlataforma: jest.fn().mockResolvedValue(true) },
    });
    await expect(svc.create(ORG, USER, DTO_GENERICO)).resolves.toMatchObject({ campaignId: 'CAMP1' });
    expect(prisma.campaign.create).toHaveBeenCalled();
  });

  it('cliente de WABA propria NAO consegue selecionar um generico — recusado antes de enfileirar', async () => {
    const { svc, prisma } = montar({
      plataforma: { orgNaWabaDaPlataforma: jest.fn().mockResolvedValue(false) },
    });
    await expect(svc.create(ORG, USER, DTO_GENERICO)).rejects.toBeInstanceOf(NotFoundException);
    // recusado ANTES de criar a campanha ou enfileirar qualquer mensagem
    expect(prisma.campaign.create).not.toHaveBeenCalled();
    expect(prisma.outboundMessage.createMany).not.toHaveBeenCalled();
  });

  it('template da propria organizacao continua sendo encontrado nos dois casos', async () => {
    for (const naPlataforma of [true, false]) {
      const { svc } = montar({
        plataforma: { orgNaWabaDaPlataforma: jest.fn().mockResolvedValue(naPlataforma) },
      });
      await expect(svc.create(ORG, USER, DTO_ORG)).resolves.toMatchObject({ campaignId: 'CAMP1' });
    }
  });
});

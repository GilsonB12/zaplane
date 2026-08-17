import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { PlataformaService } from '../common/plataforma.service';

const ORG = 'ORG';
// Os dois canais que uma mesma organização pode ter ao mesmo tempo: o número
// assistido vive na WABA da Zaplane (onde o genérico existe), o legado vive na
// WABA própria do cliente (onde ele NÃO existe).
const CHANNEL = { id: 'CH1', organizationId: ORG, status: 'active', connectedVia: 'assisted', wabaId: 'WABA_ZAPLANE' };
const CHANNEL_LEGADO = { id: 'CH0', organizationId: ORG, status: 'active', connectedVia: 'manual', wabaId: 'WABA_PROPRIA' };
const TEMPLATE = {
  id: 'T1', organizationId: ORG, scope: 'org', status: 'APPROVED',
  name: 'boas_vindas', language: 'pt_BR', category: 'MARKETING',
};
const GENERICO = {
  id: 'T2', organizationId: null, scope: 'platform', status: 'APPROVED',
  name: 'Lembrete', metaName: 'zaplane_lembrete', language: 'pt_BR', category: 'UTILITY',
};
const DTO = { templateId: 'T1', phone: '+5585999999999' };
const DTO_GENERICO = { templateId: 'T2', phone: '+5585999999999' };

/** Fake do findFirst que avalia de verdade o `where.OR` montado pelo serviço
 *  contra um catálogo fixo — sem isso o teste só confirmaria que alguma consulta
 *  foi feita, e passaria mesmo com `{ scope: 'platform' }` incluído
 *  incondicionalmente (mesmo fake usado em campaigns.service.spec.ts). */
const templateFindFirstFake = (templates: any[] = [TEMPLATE, GENERICO]) =>
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

// PlataformaService de verdade (só a config importa para o critério por canal).
// Prisma nulo de propósito: se o serviço voltar a decidir pela ORGANIZAÇÃO
// (`orgNaWabaDaPlataforma`, que consulta o banco), o teste estoura em vez de
// passar calado.
const plataformaReal = () => new PlataformaService(null as any, {
  get: (k: string) => (k === 'assisted.wabaId' ? 'WABA_ZAPLANE' : undefined),
} as any);

function montar(over: any = {}) {
  const canal = over.canal ?? CHANNEL;
  const prisma = {
    whatsappChannel: { findFirst: jest.fn().mockResolvedValue(canal) },
    template: { findFirst: templateFindFirstFake() },
    contact: { findFirst: jest.fn().mockResolvedValue(null) },
    outboundMessage: { create: jest.fn().mockResolvedValue({ id: 'MSG1' }) },
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
  const plataforma = over.plataforma ?? plataformaReal();
  return {
    svc: new MessagesService(prisma as any, billing as any, quota as any, plataforma as any),
    prisma, billing, quota, plataforma,
  };
}

// Prova de que o envio avulso (POST /messages/send) não é uma porta de fundo
// para a cota diária da campanha: sem esta checagem, um cliente poderia
// disparar em loop por este endpoint e ignorar a trava por completo.
describe('MessagesService.sendSingle — cota diária de destinatários', () => {
  it('checa a cota (1 destinatário) antes de enfileirar e deixa passar quando cabe', async () => {
    const { svc, quota, prisma } = montar();
    await svc.sendSingle(ORG, DTO);
    expect(quota.garantirCota).toHaveBeenCalledWith(ORG, 1);
    expect(prisma.outboundMessage.create).toHaveBeenCalled();
  });

  it('bloqueia e NÃO insere em outbound_messages quando a cota está esgotada', async () => {
    // Este teste só é uma prova de verdade porque falha se a chamada a
    // garantirCota for removida de sendSingle: sem ela, o mock de
    // outboundMessage.create (que resolve com sucesso) seria chamado
    // normalmente e a promise resolveria em vez de rejeitar.
    const { svc, prisma } = montar({
      quota: { garantirCota: jest.fn().mockRejectedValue(new ForbiddenException('cota esgotada')) },
    });
    await expect(svc.sendSingle(ORG, DTO)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.outboundMessage.create).not.toHaveBeenCalled();
  });
});

// O rótulo (name) é o que o cliente lê na tela; o meta_name é o que a Meta
// conhece do template. Mandar o rótulo faria a Meta responder "template não
// encontrado" — ela nunca ouviu falar da string que aparece na nossa UI.
describe('MessagesService.sendSingle — usa o meta_name no payload', () => {
  it('envia o meta_name, nunca o nome de exibicao', async () => {
    const template = { ...TEMPLATE, name: 'Promoção', metaName: 'zcc96458b_promocao' };
    const { svc, prisma } = montar({ prisma: { template: { findFirst: jest.fn().mockResolvedValue(template) } } });
    await svc.sendSingle(ORG, DTO);
    const payload = prisma.outboundMessage.create.mock.calls[0][0].data.payload;
    expect(payload.template.name).toBe('zcc96458b_promocao');
  });
});

// O envio avulso é o mesmo bloco de código da campanha, copiado — e era o único
// dos dois sem teste: incluir `{ scope: 'platform' }` incondicionalmente aqui
// mostrava todo genérico a toda organização e a suíte inteira continuava verde.
// O defeito escaparia calado (não dá erro no gateway; falha na Meta depois,
// mensagem a mensagem), então ele precisa do mesmo trio de casos da campanha.
describe('MessagesService.sendSingle — visibilidade do template generico', () => {
  it('envio pelo canal da WABA da plataforma consegue selecionar um generico', async () => {
    const { svc, prisma } = montar({ canal: CHANNEL });
    await expect(svc.sendSingle(ORG, DTO_GENERICO)).resolves.toMatchObject({ queued: true });
    expect(prisma.outboundMessage.create).toHaveBeenCalled();
  });

  it('envio por canal de WABA propria NAO seleciona generico — recusado antes de enfileirar', async () => {
    const { svc, prisma } = montar({ canal: CHANNEL_LEGADO });
    await expect(svc.sendSingle(ORG, DTO_GENERICO)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.outboundMessage.create).not.toHaveBeenCalled();
  });

  it('template da propria organizacao continua sendo encontrado pelos dois canais', async () => {
    for (const canal of [CHANNEL, CHANNEL_LEGADO]) {
      const { svc } = montar({ canal });
      await expect(svc.sendSingle(ORG, DTO)).resolves.toMatchObject({ queued: true });
    }
  });
});

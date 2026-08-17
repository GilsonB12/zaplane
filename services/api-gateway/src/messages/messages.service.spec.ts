import { ForbiddenException } from '@nestjs/common';
import { MessagesService } from './messages.service';

const ORG = 'ORG';
const CHANNEL = { id: 'CH1', organizationId: ORG, status: 'active' };
const TEMPLATE = {
  id: 'T1', organizationId: ORG, status: 'APPROVED',
  name: 'boas_vindas', language: 'pt_BR', category: 'MARKETING',
};
const DTO = { templateId: 'T1', phone: '+5585999999999' };

function montar(over: any = {}) {
  const prisma = {
    whatsappChannel: { findFirst: jest.fn().mockResolvedValue(CHANNEL) },
    template: { findFirst: jest.fn().mockResolvedValue(TEMPLATE) },
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
  const plataforma = {
    orgNaWabaDaPlataforma: jest.fn().mockResolvedValue(false),
    ...over.plataforma,
  };
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

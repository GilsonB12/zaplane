import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AssistedService } from './assisted.service';

const CFG = { wabaId: 'WABA', phoneCap: 20, orgMaxChannels: 1, orgDailyQuota: 200 };
const ORG = '11111111-1111-1111-1111-111111111111';

function montar(over: any = {}) {
  const prisma = {
    whatsappChannel: { count: jest.fn().mockResolvedValue(0), findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    channelConnectionRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: 'REQ', ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 'REQ', ...data })),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    ...over.prisma,
  };
  const meta = {
    contarNumeros: jest.fn().mockResolvedValue({ ok: true, total: 3 }),
    adicionarNumero: jest.fn().mockResolvedValue({ ok: true, phoneNumberId: 'PNID' }),
    pedirCodigo: jest.fn().mockResolvedValue({ ok: true }),
    verificarCodigo: jest.fn().mockResolvedValue({ ok: true }),
    registrar: jest.fn().mockResolvedValue({ ok: true }),
    inscreverWebhook: jest.fn().mockResolvedValue({ ok: true }),
    ...over.meta,
  };
  const config = { get: (k: string) => (k === 'assisted' ? CFG : undefined) };
  return { svc: new AssistedService(prisma as any, config as any, meta as any), prisma, meta };
}

const DTO = { telefone: '(85) 99999-9999', nomeExibicao: 'Loja do Zé', aceitouPreRequisito: true };

describe('AssistedService.iniciar', () => {
  it('recusa sem o aceite do pré-requisito', async () => {
    const { svc } = montar();
    await expect(svc.iniciar(ORG, 'U', { ...DTO, aceitouPreRequisito: false }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('recusa quando a organização já tem canal ativo', async () => {
    const { svc } = montar({ prisma: { whatsappChannel: { count: jest.fn().mockResolvedValue(1), findFirst: jest.fn(), create: jest.fn() } } });
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toBeInstanceOf(ConflictException);
  });

  it('recusa quando a WABA está lotada — sem chamar a Meta para adicionar', async () => {
    const { svc, meta } = montar({ meta: { contarNumeros: jest.fn().mockResolvedValue({ ok: true, total: 20 }) } });
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toThrow(/capacidade/i);
    expect(meta.adicionarNumero).not.toHaveBeenCalled();
  });

  it('recusa quando não consegue verificar a capacidade da WABA — falha fechado', async () => {
    const { svc, meta } = montar({
      meta: { contarNumeros: jest.fn().mockResolvedValue({ ok: false, codigo: 190, detalhe: 'token expirado' }) },
    });
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toThrow(/capacidade/i);
    expect(meta.adicionarNumero).not.toHaveBeenCalled();
  });

  it('recusa número que já é de outra organização', async () => {
    // whatsapp_channels não tem phone_hash — a checagem é contra as
    // solicitações concluídas (channelConnectionRequest), não whatsappChannel.
    const { svc, meta } = montar({
      prisma: {
        channelConnectionRequest: {
          findFirst: jest.fn(async ({ where }: any) =>
            where?.status === 'concluida' ? { id: 'C', organizationId: 'OUTRA' } : null,
          ),
          create: jest.fn(),
          update: jest.fn(),
        },
      },
    });
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toThrow();
    expect(meta.adicionarNumero).not.toHaveBeenCalled();
  });

  it('mapeia colisão de índice único (P2002) para a mensagem genérica, sem chamar a Meta', async () => {
    // Corrida entre a leitura das travas e a escrita: quem segura de verdade
    // são os índices únicos parciais do banco. O P2002 cru não pode subir
    // como 500 nem vazar detalhe — vira a mesma mensagem genérica de sempre.
    const colisao = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '5.20.0',
    });
    const { svc, meta } = montar({
      prisma: {
        channelConnectionRequest: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockRejectedValue(colisao),
          update: jest.fn(),
        },
      },
    });
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toBeInstanceOf(ConflictException);
    expect(meta.adicionarNumero).not.toHaveBeenCalled();
  });

  it('grava a linha ANTES de chamar a Meta', async () => {
    const { svc, prisma, meta } = montar();
    await svc.iniciar(ORG, 'U', DTO);
    const ordemCreate = (prisma.channelConnectionRequest.create as jest.Mock).mock.invocationCallOrder[0];
    const ordemMeta = (meta.adicionarNumero as jest.Mock).mock.invocationCallOrder[0];
    expect(ordemCreate).toBeLessThan(ordemMeta);
  });

  it('nunca persiste o número em texto puro', async () => {
    const { svc, prisma } = montar();
    await svc.iniciar(ORG, 'U', DTO);
    const dados = (prisma.channelConnectionRequest.create as jest.Mock).mock.calls[0][0].data;
    expect(JSON.stringify(dados)).not.toContain('85999999999');
    expect(dados.phoneHash).toBeTruthy();
  });

  it('loga quando inscreverWebhook falha, mas não interrompe o fluxo', async () => {
    const erroLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined as any);
    const { svc } = montar({
      meta: { inscreverWebhook: jest.fn().mockResolvedValue({ ok: false, codigo: 1, detalhe: 'falhou' }) },
    });
    await expect(svc.iniciar(ORG, 'U', DTO)).resolves.toBeDefined();
    expect(erroLog).toHaveBeenCalled();
    erroLog.mockRestore();
  });
});

describe('AssistedService.verificar', () => {
  const req = {
    id: 'REQ', organizationId: ORG, status: 'aguardando_codigo',
    phoneNumberId: 'PNID', codeAttempts: 0, registerPinEnc: null,
    phoneE164Enc: 'x', displayName: 'Loja', wabaId: 'WABA', phoneLast4: '9999',
  };

  it('nunca persiste o código de 6 dígitos', async () => {
    const { svc, prisma } = montar({
      prisma: { channelConnectionRequest: {
        findFirst: jest.fn().mockResolvedValue(req),
        create: jest.fn(), update: jest.fn(async ({ data }: any) => data),
      } },
      // precisa cair no ramo de erro: com verificarCodigo ok (default do
      // montar()) o fluxo vai para registrar()/whatsappChannel.create() (que
      // aqui é jest.fn() sem retorno), estoura em canal.id e o catch(() =>
      // {}) engole tudo — o for abaixo então itera um array vazio e a
      // asserção de "nunca contém 894701" passa vazia, sem checar nada.
      meta: { verificarCodigo: jest.fn().mockResolvedValue({ ok: false, codigo: 136008, detalhe: 'x' }) },
    });
    await svc.verificar(ORG, 'REQ', '894701').catch(() => {});
    const chamadas = (prisma.channelConnectionRequest.update as jest.Mock).mock.calls;
    // sem isso o teste passa mesmo que ninguém tenha chamado update —
    // provando nada sobre o código nunca ser persistido.
    expect(chamadas.length).toBeGreaterThan(0);
    for (const c of chamadas) {
      expect(JSON.stringify(c[0])).not.toContain('894701');
    }
  });

  it('queima a solicitação após 5 tentativas erradas', async () => {
    const { svc } = montar({
      prisma: { channelConnectionRequest: {
        findFirst: jest.fn().mockResolvedValue({ ...req, codeAttempts: 4 }),
        create: jest.fn(), update: jest.fn(async ({ data }: any) => data),
      } },
      meta: { verificarCodigo: jest.fn().mockResolvedValue({ ok: false, codigo: 136008, detalhe: 'x' }) },
    });
    await expect(svc.verificar(ORG, 'REQ', '000000')).rejects.toThrow();
  });

  it('grava o PIN cifrado ANTES de chamar registrar', async () => {
    const { svc, prisma, meta } = montar({
      prisma: {
        channelConnectionRequest: {
          findFirst: jest.fn().mockResolvedValue(req),
          create: jest.fn(),
          update: jest.fn(async ({ data }: any) => data),
        },
        whatsappChannel: {
          count: jest.fn(), findFirst: jest.fn(),
          create: jest.fn().mockResolvedValue({ id: 'CANAL1' }),
        },
      },
    });
    await svc.verificar(ORG, 'REQ', '123456');
    const updateMock = (prisma.channelConnectionRequest.update as jest.Mock).mock;
    const idxPin = updateMock.calls.findIndex((c: any) => 'registerPinEnc' in c[0].data);
    expect(idxPin).toBeGreaterThanOrEqual(0);
    const ordemPin = updateMock.invocationCallOrder[idxPin];
    const ordemRegistrar = (meta.registrar as jest.Mock).mock.invocationCallOrder[0];
    expect(ordemPin).toBeLessThan(ordemRegistrar);
  });

  it('rejeita quando a solicitação ainda não tem phoneNumberId, sem consumir tentativa', async () => {
    // 'criando' está em VIVOS mas ganha phoneNumberId só junto com
    // 'aguardando_codigo', no fim de iniciar() — uma corrida não pode virar
    // chamada à Meta com "null" na URL nem tentativa de código queimada.
    const { svc, prisma, meta } = montar({
      prisma: { channelConnectionRequest: {
        findFirst: jest.fn().mockResolvedValue({ ...req, phoneNumberId: null, status: 'criando' }),
        create: jest.fn(), update: jest.fn(async ({ data }: any) => data),
      } },
    });
    await expect(svc.verificar(ORG, 'REQ', '123456')).rejects.toBeInstanceOf(BadRequestException);
    expect(meta.verificarCodigo).not.toHaveBeenCalled();
    expect(prisma.channelConnectionRequest.update).not.toHaveBeenCalled();
  });
});

describe('AssistedService.reenviar', () => {
  const req = {
    id: 'REQ', organizationId: ORG, status: 'aguardando_codigo',
    phoneNumberId: 'PNID', codeRequests: 0, lastCodeSentAt: null,
    phoneE164Enc: 'x', displayName: 'Loja', wabaId: 'WABA', phoneLast4: '9999',
  };

  it('rejeita quando a solicitação ainda não tem phoneNumberId', async () => {
    const { svc, meta } = montar({
      prisma: { channelConnectionRequest: {
        findFirst: jest.fn().mockResolvedValue({ ...req, phoneNumberId: null, status: 'criando' }),
        create: jest.fn(), update: jest.fn(),
      } },
    });
    await expect(svc.reenviar(ORG, 'REQ', 'SMS')).rejects.toBeInstanceOf(BadRequestException);
    expect(meta.pedirCodigo).not.toHaveBeenCalled();
  });
});

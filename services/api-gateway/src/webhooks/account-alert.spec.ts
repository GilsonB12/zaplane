import { Logger } from '@nestjs/common';
import { WebhooksService, escolherCanaisDoAlerta } from './webhooks.service';

describe('escolherCanaisDoAlerta', () => {
  const canais = [
    { id: 'A', phoneNumberId: '111' },
    { id: 'B', phoneNumberId: '222' },
  ];

  it('com número identificado, afeta só aquele canal — compartilhada ou dedicada', () => {
    expect(escolherCanaisDoAlerta(canais, '222', true).map((c) => c.id)).toEqual(['B']);
    expect(escolherCanaisDoAlerta(canais, '222', false).map((c) => c.id)).toEqual(['B']);
  });

  it('WABA compartilhada sem número identificado: alerta é da plataforma, não afeta ninguém', () => {
    // espalhar marcaria CRITICAL no painel de todos os clientes que
    // compartilham a WABA sobre um problema que nenhum deles resolve
    expect(escolherCanaisDoAlerta(canais, null, true)).toEqual([]);
  });

  it('WABA dedicada sem número identificado: propaga para todos os canais (comportamento antigo preservado)', () => {
    // WABA dedicada de cliente legado autentica pelo mesmo secret global,
    // mas o alerta é sobre a conta DELE — não pode virar silêncio
    expect(escolherCanaisDoAlerta(canais, null, false)).toEqual(canais);
  });
});

// Testes de integração de handleAccountAlert (via process(), que é o método
// público) cobrindo os 4 cenários que distinguem WABA compartilhada de WABA
// dedicada — a extração pura acima não basta para provar o caso do RESOLVED,
// que depende do restante do método (a limpeza dos campos alert_*).
describe('WebhooksService.handleAccountAlert (via process)', () => {
  const WABA_COMPARTILHADA = 'WABA-ZAPLANE';
  const WABA_DEDICADA = 'WABA-CLIENTE-LEGADO';

  const canais = [
    { id: 'CANAL-A', phoneNumberId: '111' },
    { id: 'CANAL-B', phoneNumberId: '222' },
  ];

  function montar() {
    const prisma = {
      whatsappChannel: {
        findMany: jest.fn().mockResolvedValue(canais),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const config = {
      get: jest.fn((key: string) => (key === 'assisted.wabaId' ? WABA_COMPARTILHADA : undefined)),
    };
    const svc = new WebhooksService(prisma as any, config as any);
    return { svc, prisma };
  }

  function corpoAlerta(wabaId: string, value: any) {
    return { entry: [{ id: wabaId, changes: [{ field: 'account_alerts', value }] }] };
  }

  it('1) WABA compartilhada + sem número identificado: nenhum canal afetado (log de plataforma)', async () => {
    const { svc, prisma } = montar();
    const erroLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined as any);

    await svc.process(
      corpoAlerta(WABA_COMPARTILHADA, { alert_status: 'ACTIVE', alert_severity: 'CRITICAL', alert_type: 'PAYMENT' }),
      null,
      null,
    );

    expect(prisma.whatsappChannel.updateMany).not.toHaveBeenCalled();
    expect(erroLog).toHaveBeenCalledWith(expect.stringContaining('ALERTA DE PLATAFORMA'));
    erroLog.mockRestore();
  });

  it('2) WABA compartilhada + com número identificado: só o canal daquele número', async () => {
    const { svc, prisma } = montar();

    await svc.process(
      corpoAlerta(WABA_COMPARTILHADA, { alert_status: 'ACTIVE', alert_severity: 'WARNING', alert_type: 'QUALITY' }),
      '222',
      null,
    );

    expect(prisma.whatsappChannel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['CANAL-B'] } } }),
    );
  });

  it('3) WABA dedicada + sem número identificado: todos os canais daquela WABA (comportamento antigo)', async () => {
    const { svc, prisma } = montar();

    await svc.process(
      corpoAlerta(WABA_DEDICADA, { alert_status: 'ACTIVE', alert_severity: 'CRITICAL', alert_type: 'ACCOUNT_RESTRICTED' }),
      null,
      null,
    );

    expect(prisma.whatsappChannel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['CANAL-A', 'CANAL-B'] } } }),
    );
  });

  it('4) WABA dedicada + RESOLVED sem número identificado: campos alert_* são limpos nos canais daquela WABA', async () => {
    const { svc, prisma } = montar();

    await svc.process(corpoAlerta(WABA_DEDICADA, { alert_status: 'RESOLVED' }), null, null);

    expect(prisma.whatsappChannel.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['CANAL-A', 'CANAL-B'] } },
      data: { alertSeverity: null, alertType: null, alertMessage: null, alertAt: null },
    });
  });

  it('5) assisted.wabaId vazio na config: nenhuma WABA é "compartilhada" — cai no comportamento antigo (seguro)', async () => {
    const prisma = {
      whatsappChannel: {
        findMany: jest.fn().mockResolvedValue(canais),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    // configuration.ts usa `process.env.ZAPLANE_WABA_ID || ''` como default
    const config = { get: jest.fn((key: string) => (key === 'assisted.wabaId' ? '' : undefined)) };
    const svc = new WebhooksService(prisma as any, config as any);

    await svc.process(
      corpoAlerta(WABA_COMPARTILHADA, { alert_status: 'ACTIVE', alert_severity: 'CRITICAL', alert_type: 'PAYMENT' }),
      null,
      null,
    );

    expect(prisma.whatsappChannel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['CANAL-A', 'CANAL-B'] } } }),
    );
  });
});

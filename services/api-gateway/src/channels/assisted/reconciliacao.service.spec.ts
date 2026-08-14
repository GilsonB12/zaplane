import { Logger } from '@nestjs/common';
import { ReconciliacaoService } from './reconciliacao.service';

const CFG = { get: () => ({ wabaId: 'W' }) } as any;

describe('ReconciliacaoService.orfaos', () => {
  it('aponta número que está na Meta e não tem dono aqui', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ phone_number_id: 'PN1' }]),
    } as any;
    const meta = { listarNumeros: jest.fn().mockResolvedValue({ ok: true, ids: ['PN1', 'PN2'] }) } as any;
    const s = new ReconciliacaoService(prisma, CFG, meta);
    const r = await s.orfaos();
    // objeto completo, não só o id: também garante que `motivo` vem preenchido
    expect(r).toEqual([{ phoneNumberId: 'PN2', motivo: 'sem dono no banco' }]);
  });

  it('não aponta nada quando tudo tem dono', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ phone_number_id: 'PN1' }, { phone_number_id: 'PN2' }]),
    } as any;
    const meta = { listarNumeros: jest.fn().mockResolvedValue({ ok: true, ids: ['PN1', 'PN2'] }) } as any;
    const s = new ReconciliacaoService(prisma, CFG, meta);
    expect(await s.orfaos()).toEqual([]);
  });

  it('não aponta números que só existem no banco (não estão na Meta)', async () => {
    // Sem essa checagem, um teste que apenas verificasse "PN2 está na
    // resposta" passaria mesmo se orfaos() devolvesse TODOS os conhecidos em
    // vez de filtrar pela lista da Meta — aqui a Meta só devolve PN2, e PN1
    // (só no banco) não pode aparecer como órfão.
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ phone_number_id: 'PN1' }]),
    } as any;
    const meta = { listarNumeros: jest.fn().mockResolvedValue({ ok: true, ids: ['PN2'] }) } as any;
    const s = new ReconciliacaoService(prisma, CFG, meta);
    expect(await s.orfaos()).toEqual([{ phoneNumberId: 'PN2', motivo: 'sem dono no banco' }]);
  });

  it('devolve lista vazia e registra aviso quando não consegue listar a WABA na Meta', async () => {
    // Falha ao listar (token ruim, 5xx, rede) não pode estourar — e não pode
    // seguir para a query no banco: sem saber o que está na Meta, comparar
    // com o banco não tem sentido nenhum.
    const avisoLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as any);
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ phone_number_id: 'PN1' }]) } as any;
    const meta = {
      listarNumeros: jest.fn().mockResolvedValue({ ok: false, codigo: 190, detalhe: 'token expirado' }),
    } as any;
    const s = new ReconciliacaoService(prisma, CFG, meta);
    const r = await s.orfaos();
    expect(r).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(avisoLog).toHaveBeenCalledWith(expect.stringContaining('190'));
    avisoLog.mockRestore();
  });
});

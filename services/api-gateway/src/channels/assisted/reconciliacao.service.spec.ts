import { Logger } from '@nestjs/common';
import { ReconciliacaoService } from './reconciliacao.service';

const CFG = { get: () => ({ wabaId: 'W' }) } as any;

/** Banco de mentira que aplica ao fixture o MESMO filtro de status declarado
 *  pela consulta (lido do texto do SQL, do lado do UNION que lê
 *  channel_connection_requests). É o que dá poder de falha ao teste: um
 *  `$queryRaw` mockado devolve o que a gente mandar, então sem interpretar o
 *  filtro o teste passaria com a consulta certa e com a errada. */
function bancoFake(canais: string[], solicitacoes: Array<{ pnid: string; status: string }>) {
  return jest.fn((partes: TemplateStringsArray) => {
    const sql = Array.from(partes).join('');
    const ladoDasSolicitacoes = sql.split(/\bUNION\b/i)[1] ?? '';
    const lista = /status\s+IN\s*\(([^)]*)\)/i.exec(ladoDasSolicitacoes);
    const aceitos = lista ? lista[1].split(',').map((s) => s.trim().replace(/'/g, '')) : null;
    const donos = solicitacoes
      .filter((s) => (aceitos === null ? true : aceitos.includes(s.status)))
      .map((s) => s.pnid);
    return Promise.resolve(
      [...new Set([...canais, ...donos])].map((phone_number_id) => ({ phone_number_id })),
    );
  });
}

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

  it('não confunde solicitação viva com órfão nem some com a cancelada', async () => {
    // PN2 está numa solicitação CANCELADA (a Meta aceitou o número, o fluxo
    // não completou: vaga ocupada sem dono) e PN3 numa solicitação VIVA (o
    // cliente está digitando o código agora). Sem o filtro de status na
    // consulta, PN2 conta como "tem dono" e desaparece — que é justamente o
    // número que a ferramenta existe para achar.
    const prisma = {
      $queryRaw: bancoFake(['PN1'], [
        { pnid: 'PN2', status: 'cancelada' },
        { pnid: 'PN3', status: 'aguardando_codigo' },
      ]),
    } as any;
    const meta = {
      listarNumeros: jest.fn().mockResolvedValue({ ok: true, ids: ['PN1', 'PN2', 'PN3'] }),
    } as any;
    const s = new ReconciliacaoService(prisma, CFG, meta);
    expect(await s.orfaos()).toEqual([{ phoneNumberId: 'PN2', motivo: 'sem dono no banco' }]);
  });

  it('aponta também a solicitação que falhou com o número já aceito pela Meta', async () => {
    const prisma = {
      $queryRaw: bancoFake([], [{ pnid: 'PN9', status: 'falhou' }]),
    } as any;
    const meta = { listarNumeros: jest.fn().mockResolvedValue({ ok: true, ids: ['PN9'] }) } as any;
    const s = new ReconciliacaoService(prisma, CFG, meta);
    expect(await s.orfaos()).toEqual([{ phoneNumberId: 'PN9', motivo: 'sem dono no banco' }]);
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

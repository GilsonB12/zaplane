import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AssistedService } from './assisted.service';
import { encrypt, phoneHash } from '../../common/crypto.util';
import { normalizarTelefoneBR } from './telefone';
import { ERROS_CONEXAO } from './erros';

const CFG = {
  wabaId: 'WABA', phoneCap: 20, orgMaxChannels: 1, orgDailyQuota: 200,
  maxConnectAttempts24h: 5, maxBurnedSlots24h: 2,
};
const ORG = '11111111-1111-1111-1111-111111111111';

function montar(over: any = {}) {
  const prisma = {
    whatsappChannel: { count: jest.fn().mockResolvedValue(0), findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    channelConnectionRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: 'REQ', ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 'REQ', ...data })),
      count: jest.fn().mockResolvedValue(0),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    // usado pelo auditar() de AssistedService. Sem isso, as cinco chamadas de
    // auditoria estouram "$executeRaw is not a function" em TODOS os testes
    // (o try/catch de auditar() engole o erro, então nada quebra — mas isso
    // some do log dos testes de auditoria abaixo, que precisam inspecionar
    // as chamadas de verdade).
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    // code_verified_at é lida por SQL cru (a coluna da migração 013 ainda não
    // está no model do Prisma). Array vazio = solicitação ainda não verificada,
    // que é o caminho normal.
    $queryRaw: jest.fn().mockResolvedValue([]),
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
// mesmo cálculo que iniciar() faz internamente (normalizarTelefoneBR + phoneHash)
// — permite comparar resource_id por valor exato, não só "é uma string".
const HASH_DTO = phoneHash(normalizarTelefoneBR(DTO.telefone).e164);

/** Chamada de $executeRaw que grava code_verified_at + register_pin_enc.
 *  $executeRaw é template tag: args[0] é o array de trechos de SQL. */
function chamadaVerificado(prisma: any) {
  const m = (prisma.$executeRaw as jest.Mock).mock;
  const idx = m.calls.findIndex((c: any[]) => c[0].join('').includes('code_verified_at'));
  return { idx, ordem: idx >= 0 ? m.invocationCallOrder[idx] : -1, args: m.calls[idx] };
}

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

  it('recusa quando a organização já tentou 5 vezes nas últimas 24h — sem chamar a Meta', async () => {
    // Recurso protegido (vagas na WABA da Zaplane) é GLOBAL; o @Throttle do
    // controller conta por usuário, então usuários diferentes da mesma org
    // driblariam o throttle somando baldes. Esta trava é contada no banco,
    // por organização, e roda ANTES de qualquer chamada (leitura ou escrita)
    // à Meta — nem contarNumeros deve ser chamado.
    const { svc, meta } = montar({
      prisma: {
        channelConnectionRequest: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
          update: jest.fn(),
          count: jest.fn().mockResolvedValue(5),
        },
      },
    });
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toBeInstanceOf(ConflictException);
    expect(meta.contarNumeros).not.toHaveBeenCalled();
    expect(meta.adicionarNumero).not.toHaveBeenCalled();
  });

  it('recusa quando a organização já queimou o teto de VAGAS em 24h, mesmo com tentativas sobrando', async () => {
    // Tentativa e vaga são coisas diferentes: a vaga é consumida quando a Meta
    // aceita o número (phone_number_id preenchido) e NÃO volta por API. Com 5
    // tentativas e sem esta trava, uma única org queimaria 5 das ~20 vagas da
    // plataforma por dia, todo dia.
    const { svc, meta } = montar({
      prisma: {
        channelConnectionRequest: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
          update: jest.fn(),
          // 1 tentativa no total (longe do teto de 5), mas 2 vagas queimadas
          count: jest.fn(async ({ where }: any) => (where.phoneNumberId ? 2 : 1)),
        },
      },
    });
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toThrow(ERROS_CONEXAO.capacidade);
    expect(meta.contarNumeros).not.toHaveBeenCalled();
    expect(meta.adicionarNumero).not.toHaveBeenCalled();
  });

  it('conta como vaga queimada só o que tem phone_number_id e não concluiu', async () => {
    // a consulta da trava é o conserto inteiro: se ela contasse qualquer
    // solicitação, uma org com tentativas recusadas pela Meta (que não custam
    // vaga) ficaria travada sem motivo.
    const { svc, prisma } = montar();
    await svc.iniciar(ORG, 'U', DTO);
    const filtros = (prisma.channelConnectionRequest.count as jest.Mock).mock.calls.map((c: any[]) => c[0].where);
    const vagas = filtros.find((w: any) => w.phoneNumberId);
    expect(vagas).toMatchObject({
      organizationId: ORG,
      phoneNumberId: { not: null },
      status: { not: 'concluida' },
    });
    expect(vagas.createdAt.gte).toBeInstanceOf(Date);
  });

  it('recusa quando a WABA está lotada — sem chamar a Meta para adicionar', async () => {
    const { svc, meta } = montar({ meta: { contarNumeros: jest.fn().mockResolvedValue({ ok: true, total: 20 }) } });
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toThrow(/capacidade/i);
    expect(meta.adicionarNumero).not.toHaveBeenCalled();
  });

  it('recusa quando não consegue verificar a capacidade da WABA — falha fechado, e loga o motivo', async () => {
    // Sem este log, uma falha de credencial (token vazio/expirado) chega ao
    // operador como silêncio total — indistinguível de "WABA realmente lotada".
    const erroLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined as any);
    const { svc, meta } = montar({
      meta: { contarNumeros: jest.fn().mockResolvedValue({ ok: false, codigo: 190, detalhe: 'token expirado' }) },
    });
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toThrow(/capacidade/i);
    expect(meta.adicionarNumero).not.toHaveBeenCalled();
    expect(erroLog).toHaveBeenCalledWith(expect.stringContaining('190'));
    erroLog.mockRestore();
  });

  it('recusa número que já é de outra organização com 400 e a mensagem do catálogo', async () => {
    // whatsapp_channels não tem phone_hash — a checagem é contra as
    // solicitações concluídas (channelConnectionRequest), não whatsappChannel.
    // O status é 400, o MESMO do ramo P2002: um 409 com o texto de
    // numero_indisponivel só poderia significar "outra organização está
    // conectando este número agora mesmo".
    const { svc, meta } = montar({
      prisma: {
        channelConnectionRequest: {
          findFirst: jest.fn(async ({ where }: any) =>
            where?.status === 'concluida' ? { id: 'C', organizationId: 'OUTRA' } : null,
          ),
          create: jest.fn(),
          update: jest.fn(),
          count: jest.fn().mockResolvedValue(0),
        },
      },
    });
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toThrow(ERROS_CONEXAO.numero_indisponivel);
    expect(meta.adicionarNumero).not.toHaveBeenCalled();
  });

  it('o veto de número de outra organização CONSOME o orçamento de 24h', async () => {
    // Sem gravar nada, sondar a plataforma sai de graça: número livre gasta
    // orçamento e duas idas à Graph API, número de outro cliente não gastava
    // nada — e a diferença entrega justamente o que o catálogo esconde. A
    // linha nasce em 'falhou' para NÃO cair nos índices parciais de
    // solicitação viva (que travariam a própria org).
    const { svc, prisma } = montar({
      prisma: {
        channelConnectionRequest: {
          findFirst: jest.fn(async ({ where }: any) =>
            where?.status === 'concluida' ? { id: 'C', organizationId: 'OUTRA' } : null,
          ),
          create: jest.fn(async ({ data }: any) => ({ id: 'REQ', ...data })),
          update: jest.fn(),
          count: jest.fn().mockResolvedValue(0),
        },
      },
    });
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toBeInstanceOf(BadRequestException);
    const criada = (prisma.channelConnectionRequest.create as jest.Mock).mock.calls[0][0].data;
    expect(criada.organizationId).toBe(ORG);
    expect(criada.status).toBe('falhou');
    expect(criada.errorCode).toBe('numero_de_outra_org');
    // a linha entra no MESMO balde que a trava de 24h conta (createdAt + org)
    expect(criada.phoneHash).toBe(HASH_DTO);
    // e nunca em texto puro
    expect(JSON.stringify(criada)).not.toContain('85999999999');
  });

  it('mapeia colisão de índice único (P2002) para 400 com a mensagem genérica, sem chamar a Meta', async () => {
    // Corrida entre a leitura das travas e a escrita: quem segura de verdade
    // são os índices únicos parciais do banco. O P2002 cru não pode subir
    // como 500 nem vazar detalhe — vira a mesma mensagem genérica de sempre,
    // com o mesmo status do veto de "número de outra organização".
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
          count: jest.fn().mockResolvedValue(0),
        },
      },
    });
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toThrow(ERROS_CONEXAO.numero_indisponivel);
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

  it('não grava nem loga o número que a Meta ecoa no texto do erro', async () => {
    // error_detail é coluna SEM cifra e o único insumo deste fluxo é um
    // telefone — a Meta às vezes devolve o número dentro da mensagem.
    const avisoLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as any);
    const { svc, prisma } = montar({
      meta: {
        adicionarNumero: jest.fn().mockResolvedValue({
          ok: false, codigo: 133005, detalhe: 'Phone number +5585999999999 is already registered',
        }),
      },
    });
    await expect(svc.iniciar(ORG, 'U', DTO)).rejects.toBeInstanceOf(BadRequestException);
    const gravado = (prisma.channelConnectionRequest.update as jest.Mock).mock.calls[0][0].data;
    expect(gravado.errorDetail).not.toContain('5585999999999');
    expect(gravado.errorDetail).toContain('[…]');
    // o código numérico, que é o que o suporte usa, continua inteiro
    expect(gravado.errorCode).toBe('133005');
    expect(avisoLog).toHaveBeenCalledWith(expect.not.stringContaining('5585999999999'));
    avisoLog.mockRestore();
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

  it('grava channel.connect.requested e channel.connect.sms_sent com o hash do telefone', async () => {
    const { svc, prisma } = montar();
    await svc.iniciar(ORG, 'U', DTO);
    const chamadas = (prisma.$executeRaw as jest.Mock).mock.calls;
    const solicitado = chamadas.find((args: any[]) => args[3] === 'channel.connect.requested');
    const smsEnviado = chamadas.find((args: any[]) => args[3] === 'channel.connect.sms_sent');
    expect(solicitado).toBeDefined();
    expect(smsEnviado).toBeDefined();
    // resource_id (4º valor interpolado) é o HASH, nunca o telefone/dado sensível
    expect(solicitado![4]).toBe(HASH_DTO);
    expect(smsEnviado![4]).toBe(HASH_DTO);
  });
});

describe('AssistedService.verificar', () => {
  const req = {
    id: 'REQ', organizationId: ORG, status: 'aguardando_codigo',
    phoneNumberId: 'PNID', codeAttempts: 0, registerPinEnc: null,
    // phoneE164Enc é o número CIFRADO — nunca o número em claro. phoneHash é
    // o HMAC que vai para audit_logs.resource_id (ver describe de auditoria
    // abaixo); um valor fixo e reconhecível aqui ajuda a distinguir "gravou
    // o hash certo" de "gravou qualquer string".
    phoneE164Enc: 'x', phoneHash: 'HASH_FIXO_REQ', displayName: 'Loja', wabaId: 'WABA', phoneLast4: '9999',
  };

  /** prisma padrão dos testes de verificar(): a solicitação existe e o canal
   *  nasce sem colisão. `over` sobrescreve o que cada teste precisa. */
  const comReq = (over: any = {}, dadosReq: any = req) =>
    montar({
      prisma: {
        channelConnectionRequest: {
          findFirst: jest.fn().mockResolvedValue(dadosReq),
          create: jest.fn(),
          update: jest.fn(async ({ data }: any) => data),
        },
        whatsappChannel: {
          count: jest.fn(), findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'CANAL1' }),
        },
        ...over.prisma,
      },
      meta: over.meta,
    });

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
    for (const c of (prisma.$executeRaw as jest.Mock).mock.calls) {
      expect(JSON.stringify(c)).not.toContain('894701');
    }
  });

  it('queima a solicitação após 5 tentativas erradas — com a mensagem de esgotamento e a transição para falhou', async () => {
    const { svc, prisma } = comReq(
      { meta: { verificarCodigo: jest.fn().mockResolvedValue({ ok: false, codigo: 136008, detalhe: 'x' }) } },
      { ...req, codeAttempts: 4 },
    );
    // sem o matcher, o teste passaria com a lógica invertida: os DOIS ramos
    // (código errado e tentativas esgotadas) lançam.
    await expect(svc.verificar(ORG, 'REQ', '000000')).rejects.toThrow(/Tentativas esgotadas/i);
    const gravado = (prisma.channelConnectionRequest.update as jest.Mock).mock.calls[0][0].data;
    expect(gravado).toMatchObject({ codeAttempts: 5, status: 'falhou', errorCode: 'codigo_esgotado' });
  });

  it('conta a tentativa sem queimar a solicitação quando ainda restam tentativas', async () => {
    const { svc, prisma } = comReq(
      { meta: { verificarCodigo: jest.fn().mockResolvedValue({ ok: false, codigo: 136008, detalhe: 'x' }) } },
      { ...req, codeAttempts: 1 },
    );
    await expect(svc.verificar(ORG, 'REQ', '000000')).rejects.toThrow(/3 tentativa/i);
    const gravado = (prisma.channelConnectionRequest.update as jest.Mock).mock.calls[0][0].data;
    expect(gravado.codeAttempts).toBe(2);
    expect(gravado.status).toBeUndefined();
  });

  it('grava o sucesso da verificação e o PIN cifrado ANTES de chamar registrar', async () => {
    const { svc, prisma, meta } = comReq();
    await svc.verificar(ORG, 'REQ', '123456');
    const { idx, ordem, args } = chamadaVerificado(prisma);
    expect(idx).toBeGreaterThanOrEqual(0);
    const ordemRegistrar = (meta.registrar as jest.Mock).mock.invocationCallOrder[0];
    expect(ordem).toBeLessThan(ordemRegistrar);
    // o PIN vai cifrado (formato iv:tag:dados), nunca os 6 dígitos crus
    expect(String(args[1])).toMatch(/^[^:]+:[^:]+:[^:]+$/);
    const pinUsado = (meta.registrar as jest.Mock).mock.calls[0][1];
    expect(String(args[1])).not.toContain(pinUsado);
  });

  it('quando o registrar falha, a solicitação continua VIVA e já marcada como verificada', async () => {
    // é o que torna a segunda tentativa possível: sem o sucesso da verificação
    // persistido, o cliente só pode reenviar o mesmo código, a Meta recusa
    // ("número já verificado"), isso conta como código errado e as 5
    // tentativas terminam a solicitação em 'falhou' — com a vaga consumida.
    const avisoLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as any);
    const { svc, prisma } = comReq({
      meta: { registrar: jest.fn().mockResolvedValue({ ok: false, codigo: 133005, detalhe: 'PIN mismatch' }) },
    });
    await expect(svc.verificar(ORG, 'REQ', '123456')).rejects.toBeInstanceOf(BadRequestException);
    expect(chamadaVerificado(prisma).idx).toBeGreaterThanOrEqual(0);
    for (const c of (prisma.channelConnectionRequest.update as jest.Mock).mock.calls) {
      expect(c[0].data.status).toBeUndefined();
    }
    const auditoria = (prisma.$executeRaw as jest.Mock).mock.calls
      .find((args: any[]) => args[3] === 'channel.connect.register_failed');
    expect(auditoria).toBeDefined();
    expect(auditoria![4]).toBe('HASH_FIXO_REQ');
    avisoLog.mockRestore();
  });

  it('na segunda tentativa pula a verificação e vai direto para o registro, reusando o PIN guardado', async () => {
    // A Meta recusa verify_code de número já verificado. Reenviar o código
    // seria contado como tentativa errada e queimaria a solicitação — e a vaga.
    const { svc, prisma, meta } = comReq(
      { prisma: { $queryRaw: jest.fn().mockResolvedValue([{ verificado: true }]) } },
      { ...req, registerPinEnc: encrypt('424242'), codeAttempts: 2 },
    );
    const r = await svc.verificar(ORG, 'REQ', '000000');
    expect(meta.verificarCodigo).not.toHaveBeenCalled();
    // reusa o MESMO PIN: registrar de novo com outro trocaria o PIN de duas
    // etapas do número, se o register anterior tiver acontecido de fato.
    expect(meta.registrar).toHaveBeenCalledWith('PNID', '424242');
    expect(r).toEqual({ canalId: 'CANAL1' });
    // nenhuma tentativa de código consumida
    for (const c of (prisma.channelConnectionRequest.update as jest.Mock).mock.calls) {
      expect(c[0].data.codeAttempts).toBeUndefined();
    }
  });

  it('conclui SEM código quando a verificação já aconteceu — a tela não precisa inventar um "000000"', async () => {
    // Ramo que o `codigo` opcional existe para servir: a Meta já aceitou o
    // código, só o registro falhou, e não há nada a digitar. Enquanto o DTO
    // exigia 6 dígitos, o botão "Concluir conexão" mandava um valor de fachada
    // — que vira tentativa REAL na Meta se o estado "já verificado" estiver
    // errado, queimando uma das 5 chances do cliente.
    const { svc, meta } = comReq(
      { prisma: { $queryRaw: jest.fn().mockResolvedValue([{ verificado: true }]) } },
      { ...req, registerPinEnc: encrypt('424242') },
    );
    // terceiro argumento AUSENTE — é exatamente assim que a rota chama quando
    // o corpo vem sem `codigo`.
    await expect(svc.verificar(ORG, 'REQ')).resolves.toEqual({ canalId: 'CANAL1' });
    expect(meta.verificarCodigo).not.toHaveBeenCalled();
    expect(meta.registrar).toHaveBeenCalledWith('PNID', '424242');
  });

  it('recusa SEM código quando a verificação ainda está PENDENTE — sem chamar a Meta e sem gastar tentativa', async () => {
    // O outro lado da mesma trava. Sem ela, um corpo vazio chegaria à Meta como
    // verify_code de valor vazio: a Meta recusa, e a recusa é contabilizada
    // como código errado — 5 delas matam a solicitação com a vaga do número já
    // consumida na WABA, e a vaga não volta por API.
    const { svc, prisma, meta } = comReq(); // $queryRaw padrão ([]) = não verificada
    await expect(svc.verificar(ORG, 'REQ')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.verificar(ORG, 'REQ')).rejects.toThrow(ERROS_CONEXAO.codigo_obrigatorio);
    expect(meta.verificarCodigo).not.toHaveBeenCalled();
    expect(meta.registrar).not.toHaveBeenCalled();
    // nenhuma escrita: a tentativa não foi contada contra o cliente
    expect(prisma.channelConnectionRequest.update).not.toHaveBeenCalled();
  });

  it('gera um PIN novo se o guardado não puder ser decifrado, em vez de travar a solicitação', async () => {
    const erroLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined as any);
    const { svc, meta } = comReq(
      { prisma: { $queryRaw: jest.fn().mockResolvedValue([{ verificado: true }]) } },
      { ...req, registerPinEnc: 'lixo:corrompido:aqui' },
    );
    await expect(svc.verificar(ORG, 'REQ', '000000')).resolves.toEqual({ canalId: 'CANAL1' });
    expect(String((meta.registrar as jest.Mock).mock.calls[0][1])).toMatch(/^\d{6}$/);
    erroLog.mockRestore();
  });

  it('canal já existente para a MESMA org fecha a solicitação em vez de virar 500 — a vaga não se perde', async () => {
    // P2002 aqui significa que a tentativa anterior foi até o fim e só a
    // resposta (ou a nossa escrita) se perdeu. O número JÁ está registrado na
    // Meta: 500 aqui é uma vaga irrecuperável por um erro que é nosso.
    const colisao = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002', clientVersion: '5.20.0',
    });
    const { svc, prisma } = comReq({
      prisma: {
        whatsappChannel: {
          count: jest.fn(),
          findFirst: jest.fn().mockResolvedValue({ id: 'CANAL_JA_EXISTE', organizationId: ORG }),
          create: jest.fn().mockRejectedValue(colisao),
        },
      },
    });
    await expect(svc.verificar(ORG, 'REQ', '123456')).resolves.toEqual({ canalId: 'CANAL_JA_EXISTE' });
    const fechou = (prisma.channelConnectionRequest.update as jest.Mock).mock.calls
      .find((c: any[]) => c[0].data.status === 'concluida');
    expect(fechou![0].data.channelId).toBe('CANAL_JA_EXISTE');
    const auditoria = (prisma.$executeRaw as jest.Mock).mock.calls
      .find((args: any[]) => args[3] === 'channel.connect.registered');
    expect(JSON.parse(auditoria![5])).toEqual({ canalId: 'CANAL_JA_EXISTE', reaproveitado: true });
  });

  it('número já em OUTRA organização vira 400 do catálogo, com error_code e log — nunca 500', async () => {
    // colisão no índice global idx_channels_pnid_global: o canal não pode
    // nascer, mas a vaga já foi consumida — o operador precisa do rastro para
    // a baixa manual no WhatsApp Manager.
    const colisao = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002', clientVersion: '5.20.0',
    });
    const erroLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined as any);
    const { svc, prisma } = comReq({
      prisma: {
        whatsappChannel: {
          count: jest.fn(),
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockRejectedValue(colisao),
        },
      },
    });
    await expect(svc.verificar(ORG, 'REQ', '123456')).rejects.toThrow(ERROS_CONEXAO.numero_indisponivel);
    await expect(svc.verificar(ORG, 'REQ', '123456')).rejects.toBeInstanceOf(BadRequestException);
    const morreu = (prisma.channelConnectionRequest.update as jest.Mock).mock.calls
      .find((c: any[]) => c[0].data.errorCode === 'pnid_de_outra_org');
    expect(morreu![0].data.status).toBe('falhou');
    expect(erroLog).toHaveBeenCalledWith(expect.stringContaining('PNID'));
    const auditoria = (prisma.$executeRaw as jest.Mock).mock.calls
      .find((args: any[]) => args[3] === 'channel.connect.channel_failed');
    expect(auditoria).toBeDefined();
    erroLog.mockRestore();
  });

  it('falha do banco ao criar o canal vira mensagem do catálogo e deixa a solicitação retomável', async () => {
    const erroLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined as any);
    const { svc, prisma } = comReq({
      prisma: {
        whatsappChannel: {
          count: jest.fn(),
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockRejectedValue(new Error('conexão com o banco caiu')),
        },
      },
    });
    await expect(svc.verificar(ORG, 'REQ', '123456')).rejects.toThrow(ERROS_CONEXAO.generico);
    const erro = (prisma.channelConnectionRequest.update as jest.Mock).mock.calls
      .find((c: any[]) => c[0].data.errorCode === 'canal_nao_criado');
    expect(erro).toBeDefined();
    // solicitação continua VIVA: nenhum update muda o status
    for (const c of (prisma.channelConnectionRequest.update as jest.Mock).mock.calls) {
      expect(c[0].data.status).toBeUndefined();
    }
    erroLog.mockRestore();
  });

  it('não registra na Meta se não conseguiu persistir o sucesso da verificação', async () => {
    // Falhar aqui é a direção segura: registrar sem ter gravado a verificação
    // recriaria exatamente a armadilha — número registrado, nenhuma marca no
    // banco, e a segunda tentativa só podendo reenviar um código que a Meta
    // já não aceita.
    const { svc, meta } = comReq({
      prisma: {
        $executeRaw: jest.fn(async (trechos: any) => {
          if (trechos.join('').includes('code_verified_at')) throw new Error('banco fora');
        }),
      },
    });
    await expect(svc.verificar(ORG, 'REQ', '123456')).rejects.toThrow();
    expect(meta.registrar).not.toHaveBeenCalled();
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

  // Trilha de auditoria (audit_logs). $executeRaw é chamado como template tag
  // — o mock recebe o array de trechos da query e os valores interpolados
  // como argumentos SEPARADOS, na ordem em que aparecem no INSERT de
  // auditar(): (strings, orgId, userId, acao, hash, metadataJson). Por isso
  // as asserções abaixo indexam os argumentos da chamada, e não tentam casar
  // por substring de SQL.
  it('grava channel.connect.registered com o hash do telefone (nao com dado sensivel) e o canalId em metadata', async () => {
    const { svc, prisma } = comReq({
      prisma: {
        whatsappChannel: {
          count: jest.fn(), findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'CANAL_XYZ' }),
        },
      },
    });
    await svc.verificar(ORG, 'REQ', '123456');
    const chamadas = (prisma.$executeRaw as jest.Mock).mock.calls;
    const registrado = chamadas.find((args: any[]) => args[3] === 'channel.connect.registered');
    expect(registrado).toBeDefined();
    // resource_id (4º valor interpolado) é o HASH, nunca o telefone/dado sensível
    expect(registrado![4]).toBe('HASH_FIXO_REQ');
    expect(JSON.parse(registrado![5])).toEqual({ canalId: 'CANAL_XYZ' });
  });

  it('grava channel.connect.verify_failed com o hash do telefone, as tentativas e o codigo numerico da Meta', async () => {
    const { svc, prisma } = montar({
      prisma: { channelConnectionRequest: {
        findFirst: jest.fn().mockResolvedValue(req),
        create: jest.fn(), update: jest.fn(async ({ data }: any) => data),
      } },
      meta: { verificarCodigo: jest.fn().mockResolvedValue({ ok: false, codigo: 136008, detalhe: 'x' }) },
    });
    await svc.verificar(ORG, 'REQ', '000000').catch(() => {});
    const chamadas = (prisma.$executeRaw as jest.Mock).mock.calls;
    const falhou = chamadas.find((args: any[]) => args[3] === 'channel.connect.verify_failed');
    expect(falhou).toBeDefined();
    // resource_id (4º valor interpolado) é o HASH, nunca o telefone/dado sensível
    expect(falhou![4]).toBe('HASH_FIXO_REQ');
    // o código do catálogo (ERROS_CONEXAO) esconde o código da Meta do
    // cliente de propósito — é exatamente esse código que tem que sobreviver
    // aqui, junto da tentativa consumida.
    expect(JSON.parse(falhou![5])).toEqual({ tentativas: 1, codigoMeta: 136008 });
  });

  it('nao deixa falha ao gravar auditoria derrubar o fluxo — o canal é criado e o retorno é o do caminho feliz', async () => {
    // .sms_sent e .registered gravam DEPOIS que a Meta já consumiu a vaga do
    // número. Se essa falha virasse exceção, o cliente veria erro numa
    // operação que na verdade deu certo, tentaria de novo, e queimaria outra
    // vaga — que não volta por API. auditar() precisa engolir isso.
    const erroLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined as any);
    const { svc, prisma } = comReq({
      prisma: {
        whatsappChannel: {
          count: jest.fn(), findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'CANAL_OK' }),
        },
        // só a gravação da AUDITORIA falha: a escrita de code_verified_at é
        // pré-requisito do registro e, essa sim, tem que abortar (teste abaixo).
        $executeRaw: jest.fn(async (trechos: any) => {
          if (trechos.join('').includes('audit_logs')) throw new Error('conexão com o banco caiu');
        }),
      },
    });
    const resultado = await svc.verificar(ORG, 'REQ', '123456');
    // mesmo retorno do caminho feliz — a operação não vira erro pro cliente
    expect(resultado).toEqual({ canalId: 'CANAL_OK' });
    expect(prisma.whatsappChannel.create).toHaveBeenCalled();
    // a falha vira log de erro visível, nunca exceção propagada
    expect(erroLog).toHaveBeenCalledWith(expect.stringContaining('channel.connect.registered'));
    erroLog.mockRestore();
  });
});

describe('AssistedService.reenviar', () => {
  const req = {
    id: 'REQ', organizationId: ORG, status: 'aguardando_codigo',
    phoneNumberId: 'PNID', codeRequests: 0, lastCodeSentAt: null, createdBy: 'U',
    phoneE164Enc: 'x', phoneHash: 'HASH_REENVIO', displayName: 'Loja', wabaId: 'WABA', phoneLast4: '9999',
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

  it('falha da Meta no reenvio deixa rastro: log, error_code e auditoria', async () => {
    // era o único erro da Meta no fluxo inteiro sem rastro nenhum — o cliente
    // liga para o suporte dizendo "não chega SMS" e não havia o que olhar.
    const avisoLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as any);
    const { svc, prisma } = montar({
      prisma: { channelConnectionRequest: {
        findFirst: jest.fn().mockResolvedValue(req),
        create: jest.fn(), update: jest.fn(async ({ data }: any) => data),
      } },
      meta: { pedirCodigo: jest.fn().mockResolvedValue({ ok: false, codigo: 131048, detalhe: 'rate limit' }) },
    });
    await expect(svc.reenviar(ORG, 'REQ', 'VOICE')).rejects.toBeInstanceOf(BadRequestException);
    expect(avisoLog).toHaveBeenCalledWith(expect.stringContaining('131048'));
    const gravado = (prisma.channelConnectionRequest.update as jest.Mock).mock.calls[0][0].data;
    expect(gravado.errorCode).toBe('131048');
    // a solicitação continua VIVA: reenviar é retentável
    expect(gravado.status).toBeUndefined();
    const auditoria = (prisma.$executeRaw as jest.Mock).mock.calls
      .find((args: any[]) => args[3] === 'channel.connect.resend_failed');
    expect(auditoria).toBeDefined();
    expect(auditoria![4]).toBe('HASH_REENVIO');
    expect(JSON.parse(auditoria![5])).toEqual({ metodo: 'VOICE', codigoMeta: 131048 });
    avisoLog.mockRestore();
  });
});

describe('AssistedService.cancelar', () => {
  // Mínimo para exercitar o caminho e afirmar o evento de auditoria — não é
  // o conjunto completo de testes de cancelar() (fica para a revisão final).
  it('grava channel.connect.cancelled com o hash do telefone', async () => {
    const req = {
      id: 'REQ', organizationId: ORG, status: 'aguardando_codigo',
      phoneNumberId: 'PNID', wabaId: 'WABA', phoneHash: 'HASH_CANCELAR',
    };
    const { svc, prisma } = montar({
      prisma: { channelConnectionRequest: {
        findFirst: jest.fn().mockResolvedValue(req),
        create: jest.fn(), update: jest.fn(async ({ data }: any) => data),
      } },
    });
    await svc.cancelar(ORG, 'REQ');
    const chamadas = (prisma.$executeRaw as jest.Mock).mock.calls;
    const cancelado = chamadas.find((args: any[]) => args[3] === 'channel.connect.cancelled');
    expect(cancelado).toBeDefined();
    // resource_id (4º valor interpolado) é o HASH, nunca o telefone/dado sensível
    expect(cancelado![4]).toBe('HASH_CANCELAR');
  });
});

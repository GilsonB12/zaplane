import { MetaNumerosClient } from './meta-numeros.client';

/** `body` string é devolvido cru pelo text() — é assim que se simula uma
 *  resposta que NÃO é JSON (HTML de proxy, corpo vazio). Objeto vira JSON. */
function mockFetch(respostas: Array<{ status: number; body: any }>) {
  const chamadas: Array<{ url: string; init: any }> = [];
  let i = 0;
  global.fetch = jest.fn(async (url: any, init: any) => {
    chamadas.push({ url: String(url), init });
    const r = respostas[Math.min(i++, respostas.length - 1)];
    const texto = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { status: r.status, ok: r.status < 400, text: async () => texto } as any;
  }) as any;
  return chamadas;
}

const TEL = {
  cc: '55', nacional: '85999999999', semNono: '8599999999',
  e164: '+5585999999999', ultimos4: '9999',
};

const cli = (timeoutMs?: number) => new MetaNumerosClient('v21.0', 'TOKEN_SECRETO', timeoutMs);

describe('MetaNumerosClient', () => {
  it('manda o token por header, nunca na URL', async () => {
    const chamadas = mockFetch([{ status: 200, body: { id: '123' } }]);
    await cli().adicionarNumero('WABA', TEL, 'Loja');
    expect(chamadas[0].url).not.toContain('TOKEN_SECRETO');
    expect(chamadas[0].init.headers.Authorization).toBe('Bearer TOKEN_SECRETO');
  });

  it('devolve o phone_number_id quando a Meta aceita', async () => {
    mockFetch([{ status: 200, body: { id: '1162435340296069' } }]);
    const r = await cli().adicionarNumero('WABA', TEL, 'Loja');
    expect(r).toEqual({ ok: true, phoneNumberId: '1162435340296069' });
  });

  it('tenta a variante sem o nono digito quando a primeira falha por parametro', async () => {
    // formato do assinante e ponto em aberto (spec §4)
    const chamadas = mockFetch([
      { status: 400, body: { error: { code: 100, message: 'Invalid parameter' } } },
      { status: 200, body: { id: '999' } },
    ]);
    const r = await cli().adicionarNumero('WABA', TEL, 'Loja');
    expect(r).toEqual({ ok: true, phoneNumberId: '999' });
    // comparação por igualdade do parâmetro (não por substring): semNono é
    // prefixo de nacional nesse fixture, então toContain não pegaria uma
    // regressão que reenviasse o mesmo numero nas duas tentativas
    const numero0 = new URLSearchParams(chamadas[0].init.body).get('phone_number');
    const numero1 = new URLSearchParams(chamadas[1].init.body).get('phone_number');
    expect(numero0).toBe('85999999999');
    expect(numero1).toBe('8599999999');
  });

  it('expoe o codigo da Meta para o log, sem repassar texto', async () => {
    mockFetch([{ status: 400, body: { error: { code: 133005, message: 'x' } } }]);
    const r = await cli().verificarCodigo('PNID', '123456');
    expect(r).toEqual({ ok: false, codigo: 133005, detalhe: 'x' });
  });

  it('aborta a chamada quando estoura o timeout, e devolve Falha (nao excecao)', async () => {
    // fetch pendurado: sem timeout a requisição do cliente ficaria presa até o
    // socket morrer e a exceção subiria como 500 em inglês, deixando a
    // solicitação em 'criando' sem mensagem de catálogo nem error_code.
    global.fetch = jest.fn(
      (_url: any, init: any) =>
        new Promise((_resolver, rejeitar) => {
          init.signal.addEventListener('abort', () => {
            const e = new Error('abortado');
            e.name = 'AbortError';
            rejeitar(e);
          });
        }),
    ) as any;
    const r = await cli(20).pedirCodigo('PNID', 'SMS');
    expect(r).toEqual({ ok: false, codigo: null, detalhe: expect.stringMatching(/tempo esgotado/i) });
  });

  it('trata falha de rede como Falha normal do client', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNRESET');
    }) as any;
    const r = await cli().registrar('PNID', '123456');
    expect(r).toEqual({ ok: false, codigo: null, detalhe: expect.stringMatching(/falha de rede/i) });
    // o texto cru do erro carrega a URL chamada — não pode vazar para o detalhe
    expect((r as any).detalhe).not.toContain('ECONNRESET');
  });

  it('NAO trata 200 com corpo nao-JSON como sucesso', async () => {
    // o caso perigoso: um HTML de proxy com status 200 faria verificarCodigo e
    // registrar responderem "ok" olhando só o status, e o fluxo criaria canal
    // para um número que nunca foi registrado.
    mockFetch([{ status: 200, body: '<html>bloqueado pelo proxy</html>' }]);
    const r = await cli().verificarCodigo('PNID', '123456');
    expect(r.ok).toBe(false);
  });

  it('contarNumeros segue paging.next ate o fim', async () => {
    // a trava de capacidade não pode enxergar só a primeira página: hoje isso
    // funciona por coincidência (página padrão 25 > teto 20) e viraria no-op
    // silencioso no dia em que ZAPLANE_WABA_PHONE_CAP subisse.
    const proxima = 'https://graph.facebook.com/v21.0/WABA/phone_numbers?fields=id&after=CURSOR';
    const chamadas = mockFetch([
      { status: 200, body: { data: [{ id: '1' }, { id: '2' }], paging: { next: proxima } } },
      { status: 200, body: { data: [{ id: '3' }] } },
    ]);
    const r = await cli().contarNumeros('WABA');
    expect(r).toEqual({ ok: true, total: 3 });
    expect(chamadas).toHaveLength(2);
    expect(chamadas[1].url).toBe(proxima);
  });

  it('listarNumeros devolve os ids de todas as paginas', async () => {
    mockFetch([
      {
        status: 200,
        body: {
          data: [{ id: 'PN1' }],
          paging: { next: 'https://graph.facebook.com/v21.0/WABA/phone_numbers?after=C' },
        },
      },
      { status: 200, body: { data: [{ id: 'PN2' }] } },
    ]);
    const r = await cli().listarNumeros('WABA');
    expect(r).toEqual({ ok: true, ids: ['PN1', 'PN2'] });
  });

  it('nao segue paging.next para fora da Graph API', async () => {
    const chamadas = mockFetch([
      { status: 200, body: { data: [{ id: '1' }], paging: { next: 'https://evil.example.com/x' } } },
    ]);
    const r = await cli().contarNumeros('WABA');
    expect(r).toEqual({ ok: true, total: 1 });
    expect(chamadas).toHaveLength(1);
  });

  it('erro em qualquer pagina vira Falha — a contagem nunca sai parcial', async () => {
    mockFetch([
      {
        status: 200,
        body: {
          data: [{ id: '1' }],
          paging: { next: 'https://graph.facebook.com/v21.0/WABA/phone_numbers?after=C' },
        },
      },
      { status: 400, body: { error: { code: 190, message: 'token expirado' } } },
    ]);
    const r = await cli().contarNumeros('WABA');
    expect(r).toEqual({ ok: false, codigo: 190, detalhe: 'token expirado' });
  });
});

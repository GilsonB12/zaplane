import { MetaNumerosClient } from './meta-numeros.client';

function mockFetch(respostas: Array<{ status: number; body: any }>) {
  const chamadas: Array<{ url: string; init: any }> = [];
  let i = 0;
  global.fetch = jest.fn(async (url: any, init: any) => {
    chamadas.push({ url: String(url), init });
    const r = respostas[Math.min(i++, respostas.length - 1)];
    return { status: r.status, ok: r.status < 400, json: async () => r.body } as any;
  }) as any;
  return chamadas;
}

const cli = () => new MetaNumerosClient('v21.0', 'TOKEN_SECRETO');

describe('MetaNumerosClient', () => {
  it('manda o token por header, nunca na URL', async () => {
    const chamadas = mockFetch([{ status: 200, body: { id: '123' } }]);
    await cli().adicionarNumero('WABA', { cc: '55', nacional: '85999999999', semNono: '8599999999', e164: '+5585999999999', ultimos4: '9999' }, 'Loja');
    expect(chamadas[0].url).not.toContain('TOKEN_SECRETO');
    expect(chamadas[0].init.headers.Authorization).toBe('Bearer TOKEN_SECRETO');
  });

  it('devolve o phone_number_id quando a Meta aceita', async () => {
    mockFetch([{ status: 200, body: { id: '1162435340296069' } }]);
    const r = await cli().adicionarNumero('WABA', { cc: '55', nacional: '85999999999', semNono: '8599999999', e164: '+5585999999999', ultimos4: '9999' }, 'Loja');
    expect(r).toEqual({ ok: true, phoneNumberId: '1162435340296069' });
  });

  it('tenta a variante sem o nono digito quando a primeira falha por parametro', async () => {
    // formato do assinante e ponto em aberto (spec §4)
    const chamadas = mockFetch([
      { status: 400, body: { error: { code: 100, message: 'Invalid parameter' } } },
      { status: 200, body: { id: '999' } },
    ]);
    const r = await cli().adicionarNumero('WABA', { cc: '55', nacional: '85999999999', semNono: '8599999999', e164: '+5585999999999', ultimos4: '9999' }, 'Loja');
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
});

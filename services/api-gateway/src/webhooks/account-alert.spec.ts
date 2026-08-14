import { escolherCanaisDoAlerta } from './webhooks.service';

describe('escolherCanaisDoAlerta', () => {
  const canais = [
    { id: 'A', phoneNumberId: '111' },
    { id: 'B', phoneNumberId: '222' },
  ];

  it('afeta só o canal identificado no payload', () => {
    expect(escolherCanaisDoAlerta(canais, '222').map((c) => c.id)).toEqual(['B']);
  });

  it('NÃO afeta ninguém quando o payload não identifica o número', () => {
    // WABA compartilhada: espalhar marcaria CRITICAL no painel de todos os
    // clientes sobre um problema que nenhum deles pode resolver
    expect(escolherCanaisDoAlerta(canais, null)).toEqual([]);
  });
});

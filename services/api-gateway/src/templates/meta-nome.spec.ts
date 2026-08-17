import {
  PREFIXO_PLATAFORMA, prefixoDaOrg, normalizarNome,
  metaNomeDaOrg, metaNomeDaPlataforma, NomeInvalidoError,
} from './meta-nome';

const ORG = 'cc96458b-1239-4906-b23b-45d27545b620';

describe('normalizarNome', () => {
  it('tira acento, baixa a caixa e troca separador por underscore', () => {
    expect(normalizarNome('Promoção de Banho')).toBe('promocao_de_banho');
  });

  it('colapsa repetição e apara as bordas', () => {
    expect(normalizarNome('  --Olá!!  mundo--  ')).toBe('ola_mundo');
  });

  it('rejeita nome que fica vazio depois de normalizar', () => {
    expect(() => normalizarNome('!!! ---')).toThrow(NomeInvalidoError);
  });

  it('limita o tamanho', () => {
    expect(normalizarNome('a'.repeat(300))).toHaveLength(200);
  });

  it('remove underscore da borda quando o corte cai exatamente nele', () => {
    // Nome com 199 caracteres válidos + espaço (vira underscore na posição 200)
    // Sem a proteção, resultado terminaria em underscore
    const nome = 'a'.repeat(199) + '  b';
    const resultado = normalizarNome(nome);
    expect(resultado).toHaveLength(199);
    expect(resultado).not.toMatch(/_$/); // não termina em underscore
  });
});

describe('prefixoDaOrg', () => {
  it('usa z + 8 caracteres do uuid, sem hifen', () => {
    expect(prefixoDaOrg(ORG)).toBe('zcc96458b');
  });

  it('e estavel para o mesmo id', () => {
    expect(prefixoDaOrg(ORG)).toBe(prefixoDaOrg(ORG));
  });

  it('sempre tem 9 caracteres [a-z0-9] para todo uuid valido', () => {
    // Valida a propriedade sobre vários UUIDs diferentes
    const uuids = [
      ORG,
      'ffffffff-1111-2222-3333-444444444444',
      '00000000-0000-0000-0000-000000000000',
      'abcdef12-3456-7890-abcd-ef1234567890',
    ];
    uuids.forEach((uuid) => {
      const prefix = prefixoDaOrg(uuid);
      expect(prefix).toHaveLength(9);
      expect(prefix).toMatch(/^[a-z0-9]+$/);
      expect(prefix).toMatch(/^z/); // começa com 'z'
    });
  });

  it('nunca colide com o prefixo da plataforma', () => {
    // 'zaplane' tem 7 caracteres; o da org tem sempre 9 por construção
    // Portanto nunca é igual a PREFIXO_PLATAFORMA
    expect(prefixoDaOrg(ORG)).not.toBe(PREFIXO_PLATAFORMA);
  });

  it('rejeita id de organizacao sem pelo menos 8 caracteres hexadecimais', () => {
    // 'aplane' tem só 6 caracteres hexadecimais (a, p, l, a, n, e)
    // espera falha
    expect(() => prefixoDaOrg('aplane')).toThrow(NomeInvalidoError);

    // Entrada inválida com caracteres especiais também falha
    expect(() => prefixoDaOrg('Ω$$$-!!!!')).toThrow(NomeInvalidoError);
  });
});

describe('meta_name', () => {
  it('monta o nome da organizacao', () => {
    expect(metaNomeDaOrg(ORG, 'Promoção de Banho')).toBe('zcc96458b_promocao_de_banho');
  });

  it('monta o nome da plataforma', () => {
    expect(metaNomeDaPlataforma('Lembrete de agendamento')).toBe('zaplane_lembrete_de_agendamento');
  });

  it('so produz caracteres que a Meta aceita', () => {
    expect(metaNomeDaOrg(ORG, 'Açaí 50% OFF!!')).toMatch(/^[a-z0-9_]+$/);
  });

  it('duas organizacoes com o mesmo nome de exibicao nao colidem', () => {
    const outra = 'ffffffff-1111-2222-3333-444444444444';
    expect(metaNomeDaOrg(ORG, 'promoção')).not.toBe(metaNomeDaOrg(outra, 'promoção'));
  });
});

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
});

describe('prefixoDaOrg', () => {
  it('usa z + 8 caracteres do uuid, sem hifen', () => {
    expect(prefixoDaOrg(ORG)).toBe('zcc96458b');
  });

  it('e estavel para o mesmo id', () => {
    expect(prefixoDaOrg(ORG)).toBe(prefixoDaOrg(ORG));
  });

  it('nunca colide com o prefixo da plataforma', () => {
    // 'zaplane' tem 7 caracteres; o da org tem sempre 9
    expect(prefixoDaOrg(ORG)).not.toBe(PREFIXO_PLATAFORMA);
    expect(prefixoDaOrg(ORG)).toHaveLength(9);
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

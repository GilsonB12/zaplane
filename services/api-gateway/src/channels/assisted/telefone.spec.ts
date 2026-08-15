import { normalizarTelefoneBR, TelefoneInvalidoError } from './telefone';

describe('normalizarTelefoneBR', () => {
  it('aceita celular de 9 dígitos com máscara', () => {
    const t = normalizarTelefoneBR('(85) 99999-9999');
    expect(t.cc).toBe('55');
    expect(t.nacional).toBe('85999999999');
    expect(t.semNono).toBe('8599999999');
    expect(t.e164).toBe('+5585999999999');
    expect(t.ultimos4).toBe('9999');
  });

  it('aceita número antigo de 8 dígitos e devolve as duas variantes', () => {
    // o chip de teste do projeto: a Meta guarda sem o nono dígito
    const t = normalizarTelefoneBR('85 9806-2656');
    expect(t.semNono).toBe('8598062656');
    expect(t.nacional).toBe('85998062656');
  });

  it('remove o 55 quando o usuário digita o país', () => {
    expect(normalizarTelefoneBR('+55 85 99999-9999').nacional).toBe('85999999999');
  });

  it('preserva o DDD 55 (Mato Grosso do Sul)', () => {
    expect(normalizarTelefoneBR('55 99999-9999').nacional).toBe('55999999999');
  });

  it('recusa número curto demais', () => {
    expect(() => normalizarTelefoneBR('85 9999')).toThrow(TelefoneInvalidoError);
  });
});

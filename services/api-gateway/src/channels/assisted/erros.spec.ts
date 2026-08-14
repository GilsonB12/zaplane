import { ERROS_CONEXAO, mensagemParaCliente } from './erros';

describe('catálogo de erros', () => {
  it('número em uso e número inválido são indistinguíveis', () => {
    // impede que a rota vire oráculo de enumeração (spec §8)
    expect(mensagemParaCliente(133005)).toBe(mensagemParaCliente(100));
  });

  it('nunca devolve o código numérico da Meta ao cliente', () => {
    for (const codigo of [131042, 133005, 100, 80007, 999999, null]) {
      expect(mensagemParaCliente(codigo)).not.toMatch(/\d{3,}/);
    }
  });

  it('limite de SMS tem mensagem própria', () => {
    expect(mensagemParaCliente(80007)).toBe(ERROS_CONEXAO.sms_limite);
  });
});

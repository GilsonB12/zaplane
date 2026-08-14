import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { VerificarCodigoDto } from './iniciar.dto';

/** Nomes das propriedades que falharam — o que o ValidationPipe usaria para
 *  montar o 400. Vazio = corpo aceito. */
function erros(corpo: unknown): string[] {
  return validateSync(plainToInstance(VerificarCodigoDto, corpo as object)).map((e) => e.property);
}

describe('VerificarCodigoDto', () => {
  it('aceita o corpo SEM código', () => {
    // A rota conclui a conexão sem código quando a Meta já aceitou o código
    // numa tentativa anterior e só o registro falhou. Enquanto o DTO exigia 6
    // dígitos, a tela mandava um "000000" de fachada só para passar aqui — e um
    // valor de fachada vira tentativa REAL na Meta se o estado "já verificado"
    // estiver errado, queimando uma das 5 chances do cliente.
    // Quem decide se a ausência é aceitável é AssistedService.verificar(), que
    // lê `code_verified_at` do banco: a validação de formato não tem como saber.
    expect(erros({})).toEqual([]);
    expect(erros({ codigo: undefined })).toEqual([]);
  });

  it('continua exigindo 6 dígitos quando o código VEM', () => {
    // opcional não é "vale qualquer coisa": código malformado segue morrendo
    // no 400, sem consumir tentativa na Meta.
    expect(erros({ codigo: '12345' })).toEqual(['codigo']);
    expect(erros({ codigo: '1234567' })).toEqual(['codigo']);
    expect(erros({ codigo: 'abcdef' })).toEqual(['codigo']);
    expect(erros({ codigo: '' })).toEqual(['codigo']);
    expect(erros({ codigo: 123456 })).toEqual(['codigo']);
  });

  it('aceita o código de 6 dígitos', () => {
    expect(erros({ codigo: '123456' })).toEqual([]);
  });
});

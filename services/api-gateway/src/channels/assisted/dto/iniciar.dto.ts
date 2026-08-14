import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

export class IniciarConexaoDto {
  @IsString() @Length(10, 20)
  telefone!: string;

  @IsString() @Length(2, 60)
  nomeExibicao!: string;

  @IsBoolean()
  aceitouPreRequisito!: boolean;
}

export class VerificarCodigoDto {
  /** OPCIONAL de propósito. Quando a Meta já aceitou o código numa tentativa
   *  anterior (`code_verified_at` preenchida) e só o registro falhou, não há
   *  código nenhum a digitar — o servidor pula direto para o registro. Exigir
   *  6 dígitos aqui obrigava a tela a inventar um valor de fachada ("000000")
   *  só para passar na validação; se o estado "já verificado" estivesse errado,
   *  esse valor viraria uma tentativa REAL na Meta e queimaria uma das 5
   *  chances do cliente. A trava que decide se a ausência é aceitável vive no
   *  serviço (AssistedService.verificar), não aqui: só o banco sabe se a
   *  verificação aconteceu.
   *
   *  O formato continua exigido quando o código VEM — 5 dígitos ou letras
   *  seguem sendo 400 sem chegar à Meta. */
  @IsOptional() @IsString() @Matches(/^\d{6}$/, { message: 'O código tem 6 dígitos.' })
  codigo?: string;
}

export class ReenviarDto {
  @IsOptional() @IsIn(['SMS', 'VOICE'])
  metodo?: 'SMS' | 'VOICE';
}

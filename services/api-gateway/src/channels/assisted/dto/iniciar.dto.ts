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
  @IsString() @Matches(/^\d{6}$/, { message: 'O código tem 6 dígitos.' })
  codigo!: string;
}

export class ReenviarDto {
  @IsOptional() @IsIn(['SMS', 'VOICE'])
  metodo?: 'SMS' | 'VOICE';
}

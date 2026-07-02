import { IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

// Texto livre (mensagem de serviço). Só é entregue pela Meta dentro da
// janela de atendimento de 24h (depois que o contato escreve para o número).
export class SendTextDto {
  @IsString() @MinLength(8)
  phone!: string;

  @IsString() @MinLength(1)
  text!: string;

  // opcional: se omitido, usa o canal ativo do org
  @IsOptional() @IsUUID()
  channelId?: string;
}

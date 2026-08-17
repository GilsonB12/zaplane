import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateTemplateDto {
  // rótulo que o cliente lê; o nome que vai para a Meta é gerado a partir dele
  // (ver meta-nome.ts), porque a Meta só aceita [a-z0-9_] e o nome é único na WABA
  @IsString() @MinLength(1) @MaxLength(200)
  name!: string;

  @IsIn(['MARKETING', 'UTILITY', 'AUTHENTICATION'])
  category!: string;

  @IsOptional() @IsString()
  language?: string;

  @IsString() @MinLength(1)
  body!: string;
}

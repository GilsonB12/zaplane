import { IsIn, IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class CreateTemplateDto {
  // regra de nome da Meta: minúsculas, dígitos e underscore
  @Matches(/^[a-z0-9_]+$/, {
    message: 'O nome deve conter apenas letras minúsculas, dígitos e underscore.',
  })
  name!: string;

  @IsIn(['MARKETING', 'UTILITY', 'AUTHENTICATION'])
  category!: string;

  @IsOptional() @IsString()
  language?: string;

  @IsString() @MinLength(1)
  body!: string;
}

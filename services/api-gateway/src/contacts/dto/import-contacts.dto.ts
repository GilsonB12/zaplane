import { IsIn, IsOptional, IsString } from 'class-validator';

// Campos enviados junto do arquivo (multipart). A base legal é obrigatória
// para registrar consentimento conforme a LGPD.
export class ImportContactsDto {
  @IsIn(['granted', 'pending', 'unknown'])
  consentStatus!: string;

  @IsString()
  consentSource!: string; // ex.: cadastro_loja, formulario_site, relacao_contratual

  @IsOptional() @IsString()
  defaultCountry?: string; // default BR
}

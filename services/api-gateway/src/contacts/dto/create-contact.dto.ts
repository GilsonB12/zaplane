import { IsArray, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateContactDto {
  @IsString() @MinLength(8)
  phone!: string; // aceita formatos variados; normalizado p/ E.164 no serviço

  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];

  @IsOptional() @IsIn(['granted', 'pending', 'denied', 'unknown'])
  consentStatus?: string;

  @IsOptional() @IsString()
  consentSource?: string;
}

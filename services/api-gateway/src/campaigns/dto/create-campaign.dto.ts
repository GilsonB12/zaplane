import { IsObject, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class AudienceRule {
  @IsOptional() ddd?: string[];
  @IsOptional() tags?: string[];
  @IsOptional() consent?: string;
}

export class CreateCampaignDto {
  @IsString() @MinLength(2)
  name!: string;

  @IsOptional() @IsUUID()
  channelId?: string;

  @IsUUID()
  templateId!: string;

  // público: uma lista OU uma regra de segmento
  @IsOptional() @IsUUID()
  listId?: string;

  @IsOptional() @IsObject()
  audienceRule?: AudienceRule;

  // mapeamento das variáveis do template, ex.: { "1": "{{name}}" }
  @IsOptional() @IsObject()
  templateParams?: Record<string, string>;

  @IsOptional() @IsString()
  scheduledAt?: string;
}

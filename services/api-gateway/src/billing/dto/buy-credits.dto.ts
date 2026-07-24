import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

// Valor mínimo de compra de créditos: R$10,00 (1000 centavos). O painel
// oferece presets de R$20/R$50/R$100 (2000/5000/10000), mas qualquer valor
// >= 1000 é aceito (compra "avulsa"). Teto de R$5.000,00 (500000 centavos —
// Fix M2 do review B3): sem limite superior, um erro de digitação (ou abuso)
// geraria uma cobrança avulsa arbitrariamente grande no Asaas.
export class BuyCreditsDto {
  @IsInt()
  @Min(1000)
  @Max(500000)
  amountCents!: number;

  // CPF/CNPJ do responsável pela cobrança. Opcional: se a organização já tem
  // um documento salvo, reusa; se informado, o billing valida os dígitos e
  // persiste. MaxLength cobre "00.000.000/0000-00" formatado (18 chars); a
  // normalização (só dígitos) + validação de dígito verificador acontece no
  // billing.service (tax-id.ts).
  @IsOptional()
  @IsString()
  @MaxLength(18)
  cpfCnpj?: string;
}

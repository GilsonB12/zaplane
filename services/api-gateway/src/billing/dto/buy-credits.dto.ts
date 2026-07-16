import { IsInt, Max, Min } from 'class-validator';

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
}

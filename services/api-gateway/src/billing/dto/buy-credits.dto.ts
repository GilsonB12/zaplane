import { IsInt, Min } from 'class-validator';

// Valor mínimo de compra de créditos: R$10,00 (1000 centavos). O painel
// oferece presets de R$20/R$50/R$100 (2000/5000/10000), mas qualquer valor
// >= 1000 é aceito (compra "avulsa").
export class BuyCreditsDto {
  @IsInt()
  @Min(1000)
  amountCents!: number;
}

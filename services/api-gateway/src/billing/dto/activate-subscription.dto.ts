import { IsOptional, IsString, MaxLength } from 'class-validator';

// Corpo (opcional) de POST /billing/subscription/activate. Serve só para o
// painel poder informar o CPF/CNPJ do responsável pela cobrança no momento de
// ativar a assinatura, quando a organização ainda não tem um salvo. A
// validação real dos dígitos verificadores é feita no billing.service.
export class ActivateSubscriptionDto {
  @IsOptional()
  @IsString()
  @MaxLength(18)
  cpfCnpj?: string;
}

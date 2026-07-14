import { IsString, MinLength } from 'class-validator';

// Body do POST /channels/manual — credenciais coladas pelo cliente no modal
// "Conectar manualmente" (concierge). Ver spec §5.2.
export class ConnectManualDto {
  @IsString() @MinLength(2)
  label!: string;

  @IsString() @MinLength(1)
  phoneNumberId!: string;

  @IsString() @MinLength(1)
  wabaId!: string;

  @IsString() @MinLength(10)
  accessToken!: string;

  @IsString() @MinLength(1)
  appId!: string;

  @IsString() @MinLength(1)
  appSecret!: string;
}

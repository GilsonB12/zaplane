import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

// Body do POST /channels/manual — credenciais coladas pelo cliente no modal
// "Conectar manualmente" (concierge). Ver spec §5.2.
export class ConnectManualDto {
  @IsString() @MinLength(2) @MaxLength(60)
  label!: string;

  @IsString() @MinLength(1) @MaxLength(32)
  @Matches(/^\d+$/, { message: 'phoneNumberId deve conter apenas dígitos.' })
  phoneNumberId!: string;

  @IsString() @MinLength(1) @MaxLength(32)
  @Matches(/^\d+$/, { message: 'wabaId deve conter apenas dígitos.' })
  wabaId!: string;

  @IsString() @MinLength(10) @MaxLength(512)
  accessToken!: string;

  @IsString() @MinLength(1) @MaxLength(32)
  @Matches(/^\d+$/, { message: 'appId deve conter apenas dígitos.' })
  appId!: string;

  @IsString() @MinLength(1) @MaxLength(512)
  appSecret!: string;
}

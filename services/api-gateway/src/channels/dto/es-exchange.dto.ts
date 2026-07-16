import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

// Body do POST /channels/es/exchange — vem do popup do Embedded Signup
// (code do OAuth + session info capturada via postMessage). Ver spec §5.3.
export class EsExchangeDto {
  @IsString() @MinLength(10) @MaxLength(512)
  code!: string;

  @IsString() @MinLength(1) @MaxLength(32)
  @Matches(/^\d+$/, { message: 'wabaId deve conter apenas dígitos.' })
  wabaId!: string;

  @IsString() @MinLength(1) @MaxLength(32)
  @Matches(/^\d+$/, { message: 'phoneNumberId deve conter apenas dígitos.' })
  phoneNumberId!: string;
}

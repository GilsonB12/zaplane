import { IsString, MinLength } from 'class-validator';

// Body do POST /channels/es/exchange — vem do popup do Embedded Signup
// (code do OAuth + session info capturada via postMessage). Ver spec §5.3.
export class EsExchangeDto {
  @IsString() @MinLength(10)
  code!: string;

  @IsString() @MinLength(1)
  wabaId!: string;

  @IsString() @MinLength(1)
  phoneNumberId!: string;
}

import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  /** Renova a sessão sem exigir novo login. Sem esta rota o usuário era
   *  derrubado a cada 15 minutos (validade do access token). */
  @Post('refresh')
  refresh(@Body() body: { refreshToken?: string }) {
    return this.auth.refresh(body?.refreshToken ?? '');
  }

  /** Encerra a sessão revogando o refresh token (um token roubado deixaria de
   *  valer só quando expirasse, em 30 dias). */
  @Post('logout')
  logout(@Body() body: { refreshToken?: string }) {
    return this.auth.logout(body?.refreshToken);
  }

  /** Quem sou eu — o painel usa para mostrar o usuário logado de verdade. */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser('userId') userId: string) {
    return this.auth.me(userId);
  }
}

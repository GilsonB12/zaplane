import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
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

  /** Pede o e-mail de redefinição. A resposta é sempre a mesma, exista o
   *  cadastro ou não — senão a rota viraria um verificador de quem é cliente. */
  @Post('forgot-password')
  forgotPassword(@Body() body: { email?: string }, @Req() req: any) {
    const ip = (req?.headers?.['x-forwarded-for'] || '').split(',')[0]?.trim() || req?.ip;
    return this.auth.forgotPassword(body?.email ?? '', ip);
  }

  /** Conclui a redefinição com o token recebido por e-mail. */
  @Post('reset-password')
  resetPassword(@Body() body: { token?: string; password?: string }) {
    return this.auth.resetPassword(body?.token ?? '', body?.password ?? '');
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

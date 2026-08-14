import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SubscriptionGuard } from '../../common/guards/subscription.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequireActiveSubscription } from '../../common/decorators/subscription.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AssistedService } from './assisted.service';
import { IniciarConexaoDto, ReenviarDto, VerificarCodigoDto } from './dto/iniciar.dto';

/** Conexão assistida: o número do cliente entra na WABA da Zaplane.
 *  Cada chamada aqui consome recurso real — uma vaga na WABA ou um SMS de
 *  verdade — daí o throttle apertado e a exigência de assinatura ativa. */
@Controller('channels/assisted')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@Roles('owner', 'admin')
export class AssistedController {
  constructor(private readonly assisted: AssistedService) {}

  @Get('current')
  atual(@CurrentUser('organizationId') orgId: string) {
    return this.assisted.atual(orgId);
  }

  @Post()
  @RequireActiveSubscription()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  iniciar(
    @CurrentUser('organizationId') orgId: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: IniciarConexaoDto,
  ) {
    return this.assisted.iniciar(orgId, userId, dto);
  }

  @Post(':id/resend')
  @RequireActiveSubscription()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  reenviar(
    @CurrentUser('organizationId') orgId: string,
    @Param('id') id: string,
    @Body() dto: ReenviarDto,
  ) {
    return this.assisted.reenviar(orgId, id, dto.metodo ?? 'SMS');
  }

  @Post(':id/verify')
  @RequireActiveSubscription()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verificar(
    @CurrentUser('organizationId') orgId: string,
    @Param('id') id: string,
    @Body() dto: VerificarCodigoDto,
  ) {
    return this.assisted.verificar(orgId, id, dto.codigo);
  }

  @Delete(':id')
  cancelar(@CurrentUser('organizationId') orgId: string, @Param('id') id: string) {
    return this.assisted.cancelar(orgId, id);
  }
}

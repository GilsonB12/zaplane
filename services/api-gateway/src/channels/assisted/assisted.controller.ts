import {
  Body, Controller, Delete, Get, Param, Post, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SubscriptionGuard } from '../../common/guards/subscription.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequireActiveSubscription } from '../../common/decorators/subscription.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AssistedService } from './assisted.service';
import { ReconciliacaoService } from './reconciliacao.service';
import { IniciarConexaoDto, ReenviarDto, VerificarCodigoDto } from './dto/iniciar.dto';

/** Conexão assistida: o número do cliente entra na WABA da Zaplane.
 *  Cada chamada aqui consome recurso real — uma vaga na WABA ou um SMS de
 *  verdade — daí o throttle apertado e a exigência de assinatura ativa. */
@Controller('channels/assisted')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard)
@Roles('owner', 'admin')
export class AssistedController {
  constructor(
    private readonly assisted: AssistedService,
    private readonly reconciliacao: ReconciliacaoService,
    private readonly config: ConfigService,
  ) {}

  /** Sem `ZAPLANE_WABA_ID` não existe WABA da plataforma para receber o
   *  número: toda chamada à Graph API sairia com a WABA vazia na URL, a Meta
   *  recusaria, e `contarNumeros` devolvendo !ok vira "Estamos com a
   *  capacidade cheia" — mensagem que mente para o cliente (ele tenta de novo
   *  amanhã) e esconde do operador que a causa é configuração ausente.
   *  503 diz a verdade: o recurso não está disponível AGORA, e não por culpa
   *  ou limite do cliente. Ver a decisão de boot em channels.module.ts. */
  private garantirDisponivel(): void {
    if (this.config.get<string>('assisted.wabaId')) return;
    throw new ServiceUnavailableException(
      'A conexão assistida está temporariamente indisponível. Fale com o suporte.',
    );
  }

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
    this.garantirDisponivel();
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
    this.garantirDisponivel();
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
    this.garantirDisponivel();
    return this.assisted.verificar(orgId, id, dto.codigo);
  }

  /** Números que ocupam vaga na WABA da PLATAFORMA sem dono no banco — a rede
   *  de segurança do fluxo (a vaga não volta por API; a baixa é manual no
   *  WhatsApp Manager). Sem esta rota o ReconciliacaoService era código morto:
   *  nenhum agendador existe no projeto e introduzir um está fora do escopo.
   *
   *  A resposta é OPERACIONAL, não do cliente: ela olha a WABA inteira, não a
   *  organização de quem chamou. Por isso 'owner' (o papel mais alto do RBAC,
   *  sobrescrevendo o 'owner','admin' da classe) e throttle apertado — cada
   *  chamada varre as páginas de `{waba}/phone_numbers` na Graph API.
   *  O que ela devolve são `phone_number_id`s (identificadores opacos da Meta,
   *  inúteis sem o token de System User da Zaplane): nenhum telefone, nome ou
   *  organização de outro cliente. Ver a limitação anotada no relatório. */
  @Get('orphans')
  @Roles('owner')
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  async orfaos() {
    this.garantirDisponivel();
    return { orfaos: await this.reconciliacao.orfaos() };
  }

  @Delete(':id')
  cancelar(@CurrentUser('organizationId') orgId: string, @Param('id') id: string) {
    return this.assisted.cancelar(orgId, id);
  }
}

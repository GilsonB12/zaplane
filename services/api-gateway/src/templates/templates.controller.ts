import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { PlataformaAdminGuard } from '../common/guards/plataforma-admin.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { PlataformaAdmin } from '../common/decorators/plataforma-admin.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TemplatesService } from './templates.service';
import { CreateTemplateDto } from './dto/create-template.dto';

@Controller('templates')
@UseGuards(JwtAuthGuard, RolesGuard, PlataformaAdminGuard)
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  findAll(@CurrentUser('organizationId') orgId: string) {
    return this.templates.findAll(orgId);
  }

  @Post()
  @Roles('owner', 'admin', 'operator')
  create(@CurrentUser('organizationId') orgId: string, @Body() dto: CreateTemplateDto) {
    return this.templates.create(orgId, dto, { plataforma: false });
  }

  /** Template genérico da Zaplane: aprovado uma vez, serve todos os clientes
   *  assistidos. Ação de operação, não de cliente — daí o guard de plataforma
   *  e não o RBAC da organização (nenhum @Roles aqui: o RolesGuard já sai do
   *  caminho em rota marcada como de plataforma). */
  @Post('platform')
  @PlataformaAdmin()
  criarGenerico(@CurrentUser('organizationId') orgId: string, @Body() dto: CreateTemplateDto) {
    return this.templates.create(orgId, dto, { plataforma: true });
  }

  /** Puxa os templates da WABA em que esta organização envia. Para cliente
   *  assistido, essa WABA é a da Zaplane e a chamada roda com o token de System
   *  User da PLATAFORMA — o mesmo que o dispatcher usa para entregar mensagem
   *  de todo mundo. Daí papel e throttle próprios: sem eles, um `viewer` de
   *  qualquer cliente assistido chamava isto em laço (até 10 páginas de
   *  `GET /{waba}/message_templates` por chamada) e gastava a cota da Graph API
   *  compartilhada, degradando a entrega dos outros clientes. Mesmo padrão de
   *  `AssistedController`, que já protege assim toda rota que consome recurso
   *  real.
   *
   *  A lista de papéis é a mesma de `POST /` acima, e de propósito: quem pode
   *  CRIAR template tem de poder sincronizar o status dele. Quem fica de fora é
   *  o `viewer`, que era o buraco — conta somente-leitura dirigindo a credencial
   *  da plataforma. O laço em si quem segura é o `@Throttle`, não o papel. */
  @Post('sync')
  @Roles('owner', 'admin', 'operator')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  sync(@CurrentUser('organizationId') orgId: string) {
    return this.templates.sync(orgId);
  }
}

import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
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

  @Post('sync')
  sync(@CurrentUser('organizationId') orgId: string) {
    return this.templates.sync(orgId);
  }
}

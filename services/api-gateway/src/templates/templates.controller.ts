import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TemplatesService } from './templates.service';

@Controller('templates')
@UseGuards(JwtAuthGuard)
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  findAll(@CurrentUser('organizationId') orgId: string) {
    return this.templates.findAll(orgId);
  }

  @Post('sync')
  sync(@CurrentUser('organizationId') orgId: string) {
    return this.templates.sync(orgId);
  }
}

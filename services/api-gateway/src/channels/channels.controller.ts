import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ChannelsService } from './channels.service';
import { ConnectManualDto } from './dto/connect-manual.dto';
import { EsExchangeDto } from './dto/es-exchange.dto';

@Controller('channels')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  list(@CurrentUser('organizationId') orgId: string) {
    return this.channels.list(orgId);
  }

  @Post('manual')
  @Roles('owner', 'admin')
  connectManual(@CurrentUser('organizationId') orgId: string, @Body() dto: ConnectManualDto) {
    return this.channels.connectManual(orgId, dto);
  }

  @Post('es/exchange')
  @Roles('owner', 'admin')
  esExchange(@CurrentUser('organizationId') orgId: string, @Body() dto: EsExchangeDto) {
    return this.channels.esExchange(orgId, dto);
  }

  @Delete(':id')
  @Roles('owner', 'admin')
  disconnect(@CurrentUser('organizationId') orgId: string, @Param('id') id: string) {
    return this.channels.disconnect(orgId, id);
  }
}

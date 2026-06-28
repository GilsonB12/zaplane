import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CampaignsService } from './campaigns.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';

@Controller('campaigns')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Post()
  @Roles('owner', 'admin', 'operator')
  create(
    @CurrentUser('organizationId') orgId: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateCampaignDto,
  ) {
    return this.campaigns.create(orgId, userId, dto);
  }

  @Get(':id')
  progress(@CurrentUser('organizationId') orgId: string, @Param('id') id: string) {
    return this.campaigns.progress(orgId, id);
  }

  @Post(':id/cancel')
  @Roles('owner', 'admin')
  cancel(@CurrentUser('organizationId') orgId: string, @Param('id') id: string) {
    return this.campaigns.cancel(orgId, id);
  }
}

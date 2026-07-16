import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { SubscriptionGuard } from '../common/guards/subscription.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RequireActiveSubscription } from '../common/decorators/subscription.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CampaignsService } from './campaigns.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { QueryCampaignsDto } from './dto/query-campaigns.dto';

@Controller('campaigns')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Post()
  @Roles('owner', 'admin', 'operator')
  @UseGuards(SubscriptionGuard)
  @RequireActiveSubscription()
  create(
    @CurrentUser('organizationId') orgId: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateCampaignDto,
  ) {
    return this.campaigns.create(orgId, userId, dto);
  }

  @Get()
  list(@CurrentUser('organizationId') orgId: string, @Query() q: QueryCampaignsDto) {
    return this.campaigns.list(orgId, q);
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

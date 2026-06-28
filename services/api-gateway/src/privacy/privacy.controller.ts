import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrivacyService } from './privacy.service';

@Controller('privacy')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Post('data-requests')
  @Roles('owner', 'admin')
  create(
    @CurrentUser('organizationId') orgId: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: { type: 'export' | 'delete'; subjectPhone: string },
  ) {
    return this.privacy.createRequest(orgId, userId, dto);
  }

  @Get('data-requests/:id')
  @Roles('owner', 'admin')
  get(@CurrentUser('organizationId') orgId: string, @Param('id') id: string) {
    return this.privacy.getRequest(orgId, id);
  }
}

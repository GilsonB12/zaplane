import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MessagesService } from './messages.service';

@Controller('messages')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post('send')
  @Roles('owner', 'admin', 'operator')
  send(
    @CurrentUser('organizationId') orgId: string,
    @Body() dto: { channelId: string; templateId: string; phone: string; params?: Record<string, string> },
  ) {
    return this.messages.sendSingle(orgId, dto);
  }
}

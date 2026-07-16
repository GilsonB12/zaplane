import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { SubscriptionGuard } from '../common/guards/subscription.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RequireActiveSubscription } from '../common/decorators/subscription.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MessagesService } from './messages.service';
import { SendTextDto } from './dto/send-text.dto';

@Controller('messages')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post('send')
  @Roles('owner', 'admin', 'operator')
  @UseGuards(SubscriptionGuard)
  @RequireActiveSubscription()
  send(
    @CurrentUser('organizationId') orgId: string,
    @Body() dto: { channelId?: string; templateId: string; phone: string; params?: Record<string, string> },
  ) {
    return this.messages.sendSingle(orgId, dto);
  }

  // texto livre (mensagem de serviço) — válido dentro da janela de 24h
  @Post('text')
  @Roles('owner', 'admin', 'operator')
  @UseGuards(SubscriptionGuard)
  @RequireActiveSubscription()
  sendText(@CurrentUser('organizationId') orgId: string, @Body() dto: SendTextDto) {
    return this.messages.sendText(orgId, dto);
  }
}

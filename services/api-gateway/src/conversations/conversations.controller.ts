import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ConversationsService } from './conversations.service';

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(@CurrentUser('organizationId') orgId: string) {
    return this.conversations.list(orgId);
  }

  // ATENÇÃO: precisa vir antes de ':phone/messages' p/ não colidir com o parâmetro.
  @Get('windows')
  windows(@CurrentUser('organizationId') orgId: string) {
    return this.conversations.windows(orgId);
  }

  @Get(':phone/messages')
  thread(@CurrentUser('organizationId') orgId: string, @Param('phone') phone: string) {
    return this.conversations.thread(orgId, phone);
  }
}

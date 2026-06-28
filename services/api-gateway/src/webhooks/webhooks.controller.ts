import {
  Controller, Get, Post, Query, Req, Body, Headers,
  ForbiddenException, HttpCode,
} from '@nestjs/common';
import { Request } from 'express';
import { WebhooksService } from './webhooks.service';

// IMPORTANTE: rota pública (sem JwtAuthGuard). A autenticidade vem da
// verificação da assinatura X-Hub-Signature-256 (corpo cru).
@Controller('webhooks/whatsapp')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  // handshake de verificação do webhook (Meta envia GET com hub.*)
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    const result = this.webhooks.verify(mode, token, challenge);
    if (result === null) throw new ForbiddenException('Verificação falhou.');
    return result;
  }

  // recebe eventos (status + inbound)
  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature: string,
    @Body() body: any,
  ) {
    if (!this.webhooks.validSignature(req.rawBody, signature)) {
      throw new ForbiddenException('Assinatura inválida.');
    }
    await this.webhooks.process(body);
    return { received: true };
  }
}

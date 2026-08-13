import {
  Controller, Get, Post, Query, Req, Body, Headers,
  ForbiddenException, HttpCode,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { WebhooksService } from './webhooks.service';

// IMPORTANTE: rota pública (sem JwtAuthGuard). A autenticidade vem da
// verificação da assinatura X-Hub-Signature-256 (corpo cru).
//
// O limite aqui é deliberadamente altíssimo, não ausente. Um 429 nesta rota
// vira entrega/leitura que nunca é registrada e mensagem tarifada que nunca é
// cobrada — perda silenciosa de dado e de dinheiro, e a Meta não reenvia para
// sempre. Mas isenção total deixaria uma rota pública sem nenhum teto. 3.000/min
// por IP é ordens de grandeza acima do tráfego real da Meta (que ainda agrupa
// vários status por requisição) e continua sendo um teto.
@Throttle({ default: { limit: 3000, ttl: 60_000 } })
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
    const result = await this.webhooks.validateSignature(req.rawBody, signature, body);
    if (!result.valid) {
      throw new ForbiddenException('Assinatura inválida.');
    }
    await this.webhooks.process(body, result.scopedPhoneNumberId, result.scopedChannel);
    return { received: true };
  }
}

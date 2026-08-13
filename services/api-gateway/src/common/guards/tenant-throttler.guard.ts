import { Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerStorage,
  getOptionsToken,
  getStorageToken,
} from '@nestjs/throttler';

/**
 * Rate limit por INQUILINO, não por processo.
 *
 * O guard padrão conta por IP. Atrás do proxy do Railway todo mundo chega com
 * o mesmo IP de borda, então o balde global virava um recurso compartilhado:
 * um cliente com dez abas do painel abertas enchia o balde e derrubava o resto
 * — inclusive os webhooks da Meta e do Asaas, que são justamente os que não
 * podem tomar 429 (entrega não registrada, cobrança que nunca acontece).
 *
 * Aqui a chave passa a ser o usuário autenticado. Cada cliente tem o próprio
 * balde e não alcança o dos outros. Quem não está autenticado cai no IP real
 * (depende de `trust proxy` ligado no main.ts, senão todos voltam a colidir).
 *
 * O token é VERIFICADO antes de virar chave. Confiar no `sub` sem verificar
 * deixaria qualquer um forjar identidades e criar baldes infinitos, que é o
 * mesmo que não ter limite nenhum.
 */
@Injectable()
export class TenantThrottlerGuard extends ThrottlerGuard {
  constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(getStorageToken()) storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    // JwtAuthGuard é de controller e roda DEPOIS deste guard global, então
    // `req.user` ainda não existe aqui — daí a verificação própria.
    const sub = this.subjectDoToken(req);
    if (sub) return `u:${sub}`;
    return `ip:${this.ipDoCliente(req)}`;
  }

  /** Devolve o `sub` do access token, ou null se ausente/inválido/expirado. */
  private subjectDoToken(req: Record<string, any>): string | null {
    const header: string | undefined =
      req?.headers?.authorization ?? req?.headers?.Authorization;
    if (!header || typeof header !== 'string') return null;

    const [esquema, token] = header.split(' ');
    if (!token || esquema?.toLowerCase() !== 'bearer') return null;

    try {
      const payload = this.jwt.verify(token, {
        secret: this.config.get<string>('jwt.accessSecret'),
      }) as { sub?: string };
      return payload?.sub ?? null;
    } catch {
      // token inválido/expirado → trata como anônimo (cai no balde de IP)
      return null;
    }
  }

  private ipDoCliente(req: Record<string, any>): string {
    // com `trust proxy` ligado, req.ip já é o IP real do cliente
    return req?.ip || req?.socket?.remoteAddress || 'desconhecido';
  }
}

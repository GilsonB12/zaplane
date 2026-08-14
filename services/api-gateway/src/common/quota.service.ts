import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/** Cota diária de destinatários únicos por organização.
 *
 *  Existe porque o limite da Meta é do PORTFÓLIO e compartilhado por todos os
 *  números (desde 07/10/2025). Numa WABA com vários clientes, um deles pode
 *  consumir a capacidade de todos no mesmo dia — e os outros descobrem pelo
 *  suporte. Ver spec §2. */
@Injectable()
export class QuotaService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  private limite(): number {
    return this.config.get<any>('assisted')?.orgDailyQuota ?? 200;
  }

  async destinatariosRestantes(orgId: string): Promise<number> {
    const linhas = await this.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(DISTINCT to_phone_e164)::int AS n
        FROM outbound_messages
       WHERE organization_id = ${orgId}::uuid
         AND created_at >= now() - interval '24 hours'
         AND status <> 'failed'`;
    const usados = Number(linhas?.[0]?.n ?? 0);
    return Math.max(this.limite() - usados, 0);
  }

  async garantirCota(orgId: string, novos: number): Promise<void> {
    const restam = await this.destinatariosRestantes(orgId);
    if (novos > restam) {
      throw new ForbiddenException(
        `Sua cota de hoje permite mais ${restam} destinatário(s). A cota renova em 24 horas.`,
      );
    }
  }
}

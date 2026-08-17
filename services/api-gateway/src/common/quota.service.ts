import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PlataformaService } from './plataforma.service';

/** Cota diária de destinatários únicos por organização.
 *
 *  Existe por UM motivo só: desde 07/10/2025 a Meta calcula o limite de
 *  mensagens no nível do PORTFÓLIO EMPRESARIAL, compartilhado por todos os
 *  números dele. Como os clientes da conexão assistida vivem todos na WABA da
 *  Zaplane, um deles disparando forte consome a capacidade dos outros — e os
 *  outros só descobrem pelo suporte. Ver spec §2.
 *
 *  Fora daí a trava não tem base: um cliente com WABA e portfólio PRÓPRIOS
 *  (connected_via 'manual'/'embedded_signup') não divide capacidade com
 *  ninguém, e capá-lo em 200 destinatários/dia seria inventar um limite que a
 *  Meta não impõe — 403 no meio de uma campanha que antes funcionava. Por isso
 *  a cota é decidida por organização, em sujeitaACota(). */
@Injectable()
export class QuotaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    // Default só para não quebrar quem hoje instancia QuotaService direto nos
    // testes (sem passar um terceiro argumento); em produção o Nest injeta o
    // singleton real de PlataformaService por tipo, via QuotaModule.
    private readonly plataforma: PlataformaService = new PlataformaService(prisma, config),
  ) {}

  private limite(): number {
    return this.config.get<any>('assisted')?.orgDailyQuota ?? 200;
  }

  /** A organização tem ao menos um número dentro da WABA da Zaplane? Delega
   *  para PlataformaService — a mesma pergunta de segurança que decide quem
   *  enxerga os templates genéricos. As bordas do predicado estão documentadas
   *  lá, não aqui. */
  async sujeitaACota(orgId: string): Promise<boolean> {
    return this.plataforma.orgNaWabaDaPlataforma(orgId);
  }

  /** Quantos destinatários únicos ainda cabem nas próximas 24h, ou `null`
   *  quando a organização não está sujeita à cota (WABA própria). `null` e não
   *  Infinity: quem exibir esse número na tela precisa distinguir "resta muito"
   *  de "não há limite nosso a mostrar". */
  async destinatariosRestantes(orgId: string): Promise<number | null> {
    if (!(await this.sujeitaACota(orgId))) return null;
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
    if (restam === null) return; // WABA própria: o limite do portfólio é só dele
    if (novos > restam) {
      throw new ForbiddenException(
        `Sua cota de hoje permite mais ${restam} destinatário(s). A cota renova em 24 horas.`,
      );
    }
  }
}

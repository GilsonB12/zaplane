import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  private limite(): number {
    return this.config.get<any>('assisted')?.orgDailyQuota ?? 200;
  }

  /** A organização tem ao menos um número dentro da WABA da Zaplane?
   *
   *  Discriminador igual ao de webhooks.service.ts (handleAccountAlert), que
   *  usa `assisted.wabaId` para separar a WABA compartilhada da plataforma da
   *  WABA dedicada de um cliente legado.
   *
   *  Duas bordas, e a escolha segura de cada uma:
   *
   *  1) `assisted.wabaId` vazio/ausente (ZAPLANE_WABA_ID não definido — que é
   *     o estado do Railway hoje). Comparar com '' não casa com nada: a trava
   *     sumiria para TODO mundo, inclusive para quem realmente divide o
   *     portfólio. Aplicar a todos também não serve — voltaria a punir a WABA
   *     própria. Então o vínculo com a plataforma é reconhecido também por
   *     `connected_via = 'assisted'`, que é gravado na PRÓPRIA linha do canal
   *     no momento em que ele nasce (assisted.service.ts) e não depende de
   *     variável de ambiente nenhuma. Com a variável definida, os dois
   *     critérios apontam para o mesmo conjunto; sem ela, o registro do banco
   *     segura a trava de pé exatamente para quem precisa dela.
   *
   *  2) Organização sem canal nenhum: sem cota. Ela não compartilha
   *     capacidade porque não tem número, e na prática nem chega aqui — tanto
   *     CampaignsService quanto MessagesService resolvem o canal (e falham sem
   *     ele) antes de chamar garantirCota.
   *
   *  Sem filtro de `status` de propósito: a vaga do número na WABA da Zaplane
   *  não volta por API, então um canal assistido desativado continua sendo um
   *  número da plataforma — na dúvida, mantém a cota. */
  async sujeitaACota(orgId: string): Promise<boolean> {
    const wabaId = this.config.get<string>('assisted.wabaId') || '';
    const naPlataforma = await this.prisma.whatsappChannel.count({
      where: {
        organizationId: orgId,
        OR: [...(wabaId ? [{ wabaId }] : []), { connectedVia: 'assisted' }],
      },
    });
    return naPlataforma > 0;
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

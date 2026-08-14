import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { MetaNumerosClient } from './meta-numeros.client';

/** Números que existem na WABA da Zaplane e não têm dono no banco.
 *
 *  Acontece quando a Meta aceita o número e o nosso UPDATE falha logo depois.
 *  Como `DELETE /{pnid}` não é suportado, a vaga não volta por API — este
 *  serviço só APONTA; a remoção é manual no WhatsApp Manager. Ver spec §4.
 *
 *  Deliberadamente global (não filtra por organização): varre a WABA inteira
 *  da plataforma, não a de um tenant. */
@Injectable()
export class ReconciliacaoService {
  private readonly logger = new Logger('ReconciliacaoWABA');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly meta: MetaNumerosClient,
  ) {}

  async orfaos(): Promise<Array<{ phoneNumberId: string; motivo: string }>> {
    const wabaId = this.config.get<any>('assisted').wabaId;
    const naMeta = await this.meta.listarNumeros(wabaId);
    if (!naMeta.ok) {
      this.logger.warn(`não consegui listar os números da WABA: ${naMeta.codigo} — ${naMeta.detalhe}`);
      return [];
    }
    const conhecidos = await this.prisma.$queryRaw<Array<{ phone_number_id: string }>>`
      SELECT phone_number_id FROM whatsapp_channels WHERE phone_number_id IS NOT NULL
      UNION
      SELECT phone_number_id FROM channel_connection_requests WHERE phone_number_id IS NOT NULL`;
    const donos = new Set(conhecidos.map((r) => r.phone_number_id));
    const orfaos = naMeta.ids
      .filter((id) => !donos.has(id))
      .map((id) => ({ phoneNumberId: id, motivo: 'sem dono no banco' }));
    if (orfaos.length) {
      this.logger.warn(
        `${orfaos.length} número(s) órfão(s) ocupando vaga na WABA ${wabaId}: ${orfaos
          .map((o) => o.phoneNumberId)
          .join(', ')} — remover no WhatsApp Manager`,
      );
    }
    return orfaos;
  }
}

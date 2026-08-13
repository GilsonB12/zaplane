import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Pausa do canal ainda em vigor? (paused_until no futuro) */
const ativa = (ate: Date | null | undefined): boolean => !!ate && ate > new Date();

/** Métricas agregadas do Dashboard.
 *
 *  Substituem os três KPIs que o painel exibia como "—" com selo "em breve".
 *  Todos os números saem de dados que já existem: outbound_messages (envio e
 *  entrega), contacts (opt-out) e whatsapp_channels (saúde do número, que a
 *  Meta devolve no momento da conexão).
 *
 *  Tudo é filtrado por organization_id — nunca confie no corpo da requisição
 *  para isso; o orgId vem do JWT. */
@Injectable()
export class MetricsService {
  constructor(private prisma: PrismaService) {}

  async dashboard(orgId: string) {
    const agora = new Date();
    const inicioDoDia = new Date(agora);
    inicioDoDia.setHours(0, 0, 0, 0);
    const trintaDias = new Date(agora.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      contatosAtivos,
      enviadasHoje,
      entreguesHoje,
      falhasHoje,
      optOuts30d,
      canal,
    ] = await Promise.all([
      // contatos que podem receber (exclui quem saiu da base)
      this.prisma.contact.count({ where: { organizationId: orgId, optedOut: false } }),

      // enviadas hoje: mensagens que de fato saíram (têm sent_at)
      this.prisma.outboundMessage.count({
        where: { organizationId: orgId, sentAt: { gte: inicioDoDia } },
      }),

      // entregues hoje: base da taxa de entrega
      this.prisma.outboundMessage.count({
        where: { organizationId: orgId, deliveredAt: { gte: inicioDoDia } },
      }),

      this.prisma.outboundMessage.count({
        where: { organizationId: orgId, status: 'failed', updatedAt: { gte: inicioDoDia } },
      }),

      this.prisma.contact.count({
        where: { organizationId: orgId, optedOut: true, updatedAt: { gte: trintaDias } },
      }),

      // canal ativo mais recente — a saúde do número vem daqui
      this.prisma.whatsappChannel.findFirst({
        where: { organizationId: orgId, status: 'active' },
        orderBy: { updatedAt: 'desc' },
        select: {
          label: true, displayNumber: true, qualityRating: true,
          throughputLimit: true, status: true, connectedVia: true,
          alertSeverity: true, alertType: true, alertMessage: true, alertAt: true,
          pausedUntil: true, pausedReason: true,
        },
      }),
    ]);

    // Taxa de entrega do dia: entregues / enviadas. Só faz sentido com envio no
    // período — sem mensagens, devolvemos null para o painel dizer "sem envios
    // hoje" em vez de exibir 0% (que sugeriria falha).
    const taxaEntregaPct = enviadasHoje > 0
      ? Math.round((entreguesHoje / enviadasHoje) * 100)
      : null;

    return {
      contatosAtivos,
      enviadasHoje,
      entreguesHoje,
      falhasHoje,
      taxaEntregaPct,
      optOuts30d,
      canal: canal
        ? {
            label: canal.label,
            displayNumber: canal.displayNumber || null,
            qualityRating: canal.qualityRating || null,
            throughputLimit: canal.throughputLimit ?? null,
            status: canal.status,
            connectedVia: canal.connectedVia || null,
            // alerta ativo da Meta (pagamento pendente, qualidade, restrição).
            // O alerta que o dispatcher grava ao pausar é sintético e some
            // junto com a pausa — a Meta nunca mandaria o RESOLVED dele.
            alerta:
              canal.alertSeverity &&
              !(canal.alertType === 'dispatcher_pause' && !ativa(canal.pausedUntil))
                ? {
                    severidade: canal.alertSeverity,
                    tipo: canal.alertType,
                    mensagem: canal.alertMessage,
                    quando: canal.alertAt,
                  }
                : null,
            // pausa automática do dispatcher — explica campanha parada sem erro
            pausadoAte: ativa(canal.pausedUntil) ? canal.pausedUntil : null,
            pausadoMotivo: ativa(canal.pausedUntil) ? canal.pausedReason || null : null,
          }
        : null,
    };
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Estado da janela de 24h calculado a partir do último inbound. */
interface WindowInfo {
  windowOpen: boolean;
  windowExpiresAt: Date | null;
}

/**
 * Módulo somente leitura: agrega `inbound_messages` (webhook) e
 * `outbound_messages` (envios) por telefone para alimentar a tela de
 * Conversas. Nenhuma escrita aqui — responder usa `POST /messages/*`.
 */
@Injectable()
export class ConversationsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Helper único de janela de 24h: aberta se `lastInboundAt + 24h > agora`.
   * Sem inbound (nunca respondeu), a janela nunca esteve aberta.
   */
  private computeWindow(lastInboundAt: Date | string | null | undefined): WindowInfo {
    if (!lastInboundAt) return { windowOpen: false, windowExpiresAt: null };
    const last = lastInboundAt instanceof Date ? lastInboundAt : new Date(lastInboundAt);
    const windowExpiresAt = new Date(last.getTime() + 24 * 60 * 60 * 1000);
    return { windowOpen: windowExpiresAt.getTime() > Date.now(), windowExpiresAt };
  }

  /** Normaliza o parâmetro de rota (só dígitos) para E.164 (`+dígitos`). */
  private normalizePhone(rawPhone: string): string {
    return '+' + rawPhone.replace(/\D/g, '');
  }

  /** Lista as conversas do org, ordenadas pela última atividade (in ou out). */
  async list(orgId: string) {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `WITH msgs AS (
         SELECT from_phone_e164 AS phone, body AS preview, 'in' AS direction, received_at AS at
           FROM inbound_messages WHERE organization_id = $1::uuid
         UNION ALL
         SELECT to_phone_e164 AS phone,
                COALESCE(payload->'text'->>'body', '[template] ' || (payload->'template'->>'name'), '[mensagem]') AS preview,
                'out' AS direction, created_at AS at
           FROM outbound_messages WHERE organization_id = $1::uuid
       ), last_msg AS (
         SELECT DISTINCT ON (phone) phone, preview, direction, at FROM msgs ORDER BY phone, at DESC
       ), last_in AS (
         SELECT from_phone_e164 AS phone, MAX(received_at) AS last_inbound_at
           FROM inbound_messages WHERE organization_id = $1::uuid GROUP BY 1
       )
       SELECT lm.phone, lm.preview, lm.direction, lm.at, li.last_inbound_at, c.id AS contact_id, c.name
         FROM last_msg lm
         LEFT JOIN last_in li ON li.phone = lm.phone
         LEFT JOIN contacts c ON c.organization_id = $1::uuid AND c.phone_e164 = lm.phone AND c.deleted_at IS NULL
        ORDER BY lm.at DESC LIMIT 100`,
      orgId,
    );

    const items = rows.map((r) => {
      const { windowOpen, windowExpiresAt } = this.computeWindow(r.last_inbound_at);
      return {
        phone: r.phone,
        name: r.name ?? null,
        contactId: r.contact_id ?? null,
        lastMessage: { direction: r.direction, preview: r.preview, at: r.at },
        lastInboundAt: r.last_inbound_at ?? null,
        windowOpen,
        windowExpiresAt,
      };
    });
    return { items };
  }

  /** Thread 1:1 de um telefone (asc, últimas 200 mensagens). */
  async thread(orgId: string, rawPhone: string) {
    const phone = this.normalizePhone(rawPhone);

    const [rows, contact, lastInboundRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<any[]>(
        `SELECT id::text AS id, 'in' AS direction, body, type, NULL::text AS status, received_at AS at
           FROM inbound_messages WHERE organization_id = $1::uuid AND from_phone_e164 = $2
         UNION ALL
         SELECT id::text AS id, 'out' AS direction,
                COALESCE(payload->'text'->>'body', '[template] ' || (payload->'template'->>'name'), '[mensagem]') AS body,
                COALESCE(payload->>'type', 'text') AS type,
                status, created_at AS at
           FROM outbound_messages WHERE organization_id = $1::uuid AND to_phone_e164 = $2
         ORDER BY at DESC LIMIT 200`,
        orgId,
        phone,
      ),
      this.prisma.contact.findFirst({
        where: { organizationId: orgId, phoneE164: phone, deletedAt: null },
        select: { id: true, name: true },
      }),
      this.prisma.$queryRawUnsafe<any[]>(
        `SELECT MAX(received_at) AS last_inbound_at
           FROM inbound_messages WHERE organization_id = $1::uuid AND from_phone_e164 = $2`,
        orgId,
        phone,
      ),
    ]);

    // busca DESC LIMIT 200 no SQL (mais recentes) → inverte para asc na resposta
    const items = rows
      .slice()
      .reverse()
      .map((r) => ({
        id: r.id,
        direction: r.direction,
        body: r.body,
        type: r.type,
        status: r.status ?? null,
        at: r.at,
      }));

    const { windowOpen, windowExpiresAt } = this.computeWindow(lastInboundRows[0]?.last_inbound_at ?? null);

    return {
      contact: contact ? { id: contact.id, name: contact.name } : null,
      windowOpen,
      windowExpiresAt,
      items,
    };
  }

  /** Mapa leve (uma linha por telefone com inbound) p/ badges de janela em lote. */
  async windows(orgId: string) {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT from_phone_e164 AS phone, MAX(received_at) AS last_inbound_at
         FROM inbound_messages WHERE organization_id = $1::uuid GROUP BY 1`,
      orgId,
    );
    const items = rows.map((r) => {
      const { windowExpiresAt } = this.computeWindow(r.last_inbound_at);
      return { phone: r.phone, lastInboundAt: r.last_inbound_at, windowExpiresAt };
    });
    return { items };
  }
}

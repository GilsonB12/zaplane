import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/** "Esta organização envia pela WABA da Zaplane?"
 *
 *  Pergunta de segurança usada em mais de um lugar: decide quem está sujeito à
 *  cota diária (o limite da Meta é do portfólio e compartilhado) e quem enxerga
 *  os templates genéricos (template pertence a uma WABA, e um número só dispara
 *  template da WABA dele). Mora aqui, sozinha, porque duas cópias divergem.
 *
 *  Critério duplo de propósito: `waba_id` casa com a configuração, e
 *  `connected_via = 'assisted'` está gravado na própria linha do canal — é ele
 *  que segura a regra de pé quando `ZAPLANE_WABA_ID` está vazio.
 *
 *  Sem filtro de `status`: a vaga do número na WABA não volta por API, então um
 *  canal assistido desativado continua sendo um número da plataforma. */
@Injectable()
export class PlataformaService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  async orgNaWabaDaPlataforma(orgId: string): Promise<boolean> {
    const wabaId = this.config.get<string>('assisted.wabaId') || '';
    const n = await this.prisma.whatsappChannel.count({
      where: {
        organizationId: orgId,
        OR: [...(wabaId ? [{ wabaId }] : []), { connectedVia: 'assisted' }],
      },
    });
    return n > 0;
  }
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/** As duas perguntas sobre "quem está na WABA da Zaplane" — que NÃO são a mesma
 *  pergunta, e por isso moram lado a lado: é a diferença entre elas que se perde
 *  quando cada uma vive num arquivo.
 *
 *  1) `orgNaWabaDaPlataforma(orgId)` — "esta ORGANIZAÇÃO tem algum canal na WABA
 *     da Zaplane?". Use quando a decisão é sobre a organização inteira e não há
 *     canal escolhido: a cota diária (o limite da Meta é do PORTFÓLIO, dividido
 *     por todos os números dele — ver `quota.service.ts`) e a galeria de
 *     templates (`GET /templates`), que mostra o que ela pode vir a usar.
 *
 *  2) `canalNaWabaDaPlataforma(canal)` — "este CANAL, o que vai enviar, é da WABA
 *     da Zaplane?". Use em todo caminho que JÁ escolheu o canal: resolver a
 *     credencial da Meta, criar campanha, envio avulso. Template pertence a uma
 *     WABA e um número só dispara template da WABA dele; decidir pela
 *     organização aqui deixaria uma organização com canal legado E número
 *     assistido selecionar o genérico e disparar pelo canal errado — a Meta
 *     responde 132001, que é permanente e não tem retry (a campanha inteira
 *     morre). Pelo mesmo motivo, unificar as duas resolveria a credencial errada:
 *     token/WABA de um canal para operação decidida pelo outro.
 *
 *  Critério duplo de propósito nas duas: `waba_id` casa com a configuração, e
 *  `connected_via = 'assisted'` está gravado na PRÓPRIA linha do canal — é ele
 *  que segura a regra de pé quando `ZAPLANE_WABA_ID` está vazio. Mesmo
 *  discriminador usado por `webhooks.service.ts` (handleAccountAlert), que
 *  separa a WABA compartilhada da plataforma da WABA dedicada de um cliente
 *  legado: são três consumidores do mesmo critério, e é assim que a terceira
 *  cópia divergiria.
 *
 *  Sem filtro de `status`: a vaga do número na WABA não volta por API, então um
 *  canal assistido desativado continua sendo um número da plataforma.
 *
 *  Organização sem canal nenhum: falso nas duas — sem número, ela não divide
 *  capacidade com ninguém (logo, sem cota). Pelo caminho de envio nem chega
 *  aqui: `CampaignsService` e `MessagesService` resolvem o canal, e falham sem
 *  ele, antes de perguntar qualquer coisa. */
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

  /** Síncrono e sem banco de propósito: decide sobre a linha de canal que o
   *  chamador já tem em mãos (ele acabou de escolhê-la). Reconsultar o banco
   *  aqui só abriria espaço para responder sobre um canal diferente do que vai
   *  enviar — que é exatamente o defeito que este método existe para fechar. */
  canalNaWabaDaPlataforma(
    canal: { connectedVia?: string | null; wabaId?: string | null } | null | undefined,
  ): boolean {
    if (!canal) return false;
    const wabaId = this.config.get<string>('assisted.wabaId') || '';
    return canal.connectedVia === 'assisted' || (!!wabaId && canal.wabaId === wabaId);
  }
}

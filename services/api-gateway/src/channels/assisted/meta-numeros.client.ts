import { Injectable } from '@nestjs/common';
import { TelefoneBR } from './telefone';

export type Falha = { ok: false; codigo: number | null; detalhe: string };
const falha = (b: any): Falha => ({
  ok: false,
  codigo: typeof b?.error?.code === 'number' ? b.error.code : null,
  detalhe: b?.error?.error_data?.details ?? b?.error?.message ?? 'erro desconhecido',
});

/** Chamadas da Meta para adicionar, verificar e registrar um número.
 *  Contrato verificado em produção — ver spec §4. O token vai SEMPRE por
 *  header: em query string ele vazaria para log de proxy e histórico. */
@Injectable()
export class MetaNumerosClient {
  constructor(private readonly versao: string, private readonly token: string) {}

  private async chamar(caminho: string, metodo: 'GET' | 'POST', corpo?: URLSearchParams) {
    const r = await fetch(`https://graph.facebook.com/${this.versao}/${caminho}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(corpo ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(corpo ? { body: corpo.toString() } : {}),
    });
    return { status: r.status, body: await r.json() };
  }

  /** Tenta o assinante com o nono dígito e cai na variante sem ele se a Meta
   *  recusar por parâmetro — o formato aceito é ponto em aberto (spec §4). */
  async adicionarNumero(
    wabaId: string,
    tel: TelefoneBR,
    nomeExibicao: string,
  ): Promise<{ ok: true; phoneNumberId: string } | Falha> {
    let ultima: Falha | null = null;
    for (const assinante of [tel.nacional, tel.semNono]) {
      const r = await this.chamar(
        `${wabaId}/phone_numbers`,
        'POST',
        new URLSearchParams({ cc: tel.cc, phone_number: assinante, verified_name: nomeExibicao }),
      );
      if (r.status < 400 && r.body?.id) return { ok: true, phoneNumberId: String(r.body.id) };
      ultima = falha(r.body);
      // só vale tentar a outra variante se o problema foi de parâmetro
      if (ultima.codigo !== 100) break;
      if (assinante === tel.semNono) break;
    }
    return ultima!;
  }

  async pedirCodigo(pnid: string, metodo: 'SMS' | 'VOICE'): Promise<{ ok: true } | Falha> {
    const r = await this.chamar(
      `${pnid}/request_code`,
      'POST',
      new URLSearchParams({ code_method: metodo, language: 'pt_BR' }),
    );
    return r.status < 400 ? { ok: true } : falha(r.body);
  }

  async verificarCodigo(pnid: string, codigo: string): Promise<{ ok: true } | Falha> {
    const r = await this.chamar(`${pnid}/verify_code`, 'POST', new URLSearchParams({ code: codigo }));
    return r.status < 400 ? { ok: true } : falha(r.body);
  }

  async registrar(pnid: string, pin: string): Promise<{ ok: true } | Falha> {
    const r = await this.chamar(
      `${pnid}/register`,
      'POST',
      new URLSearchParams({ messaging_product: 'whatsapp', pin }),
    );
    return r.status < 400 ? { ok: true } : falha(r.body);
  }

  async contarNumeros(wabaId: string): Promise<{ ok: true; total: number } | Falha> {
    const r = await this.chamar(`${wabaId}/phone_numbers?fields=id`, 'GET');
    if (r.status >= 400) return falha(r.body);
    return { ok: true, total: (r.body?.data ?? []).length };
  }

  /** Lista os IDs de todos os números atualmente na WABA — usado pela
   *  reconciliação para achar números sem dono no banco (spec §8). */
  async listarNumeros(wabaId: string): Promise<{ ok: true; ids: string[] } | Falha> {
    const r = await this.chamar(`${wabaId}/phone_numbers?fields=id`, 'GET');
    if (r.status >= 400) return falha(r.body);
    return { ok: true, ids: (r.body?.data ?? []).map((x: any) => String(x.id)) };
  }

  /** Obrigatório por WABA: sem isso o número envia e NENHUM status volta. */
  async inscreverWebhook(wabaId: string): Promise<{ ok: true } | Falha> {
    const r = await this.chamar(`${wabaId}/subscribed_apps`, 'POST', new URLSearchParams());
    return r.status < 400 ? { ok: true } : falha(r.body);
  }
}

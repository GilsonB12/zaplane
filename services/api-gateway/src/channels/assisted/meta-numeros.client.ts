import { Injectable } from '@nestjs/common';
import { TelefoneBR } from './telefone';

export type Falha = { ok: false; codigo: number | null; detalhe: string };
const falha = (b: any): Falha => ({
  ok: false,
  codigo: typeof b?.error?.code === 'number' ? b.error.code : null,
  detalhe: b?.error?.error_data?.details ?? b?.error?.message ?? 'erro desconhecido',
});

const BASE_GRAPH = 'https://graph.facebook.com/';

/** Status sintético para falha de transporte (rede, timeout, resposta não-JSON).
 *  Precisa ser >= 400: todo chamador decide por `status < 400`, então um 0 ou
 *  um 200 aqui viraria "deu certo" para pedirCodigo/verificarCodigo/registrar. */
const STATUS_TRANSPORTE = 599;
const falhaDeTransporte = (motivo: string) => ({
  status: STATUS_TRANSPORTE,
  body: { error: { message: motivo } },
});

/** Teto de páginas ao varrer os números da WABA. Estourar significa não saber
 *  quantos números existem — e essa contagem é a trava da capacidade, então o
 *  estouro falha FECHADO (vira Falha) em vez de devolver um total menor. */
const MAX_PAGINAS = 50;

/** Timeout padrão de cada chamada à Graph API. É uma CONSTANTE de propósito: se
 *  fosse lido de `process.env` aqui, a validação do provider (timeoutDaMeta)
 *  viraria enfeite — ela devolve `undefined` para valor inválido justamente para
 *  cair neste default, e cair de volta na mesma env var traria o valor inválido
 *  de volta. `META_HTTP_TIMEOUT_MS=abc` daria `NaN`, e `setTimeout(NaN)` aborta
 *  em 1 ms: toda chamada à Meta morreria e o cliente leria "capacidade cheia". */
const TIMEOUT_PADRAO_MS = 15_000;

/** Chamadas da Meta para adicionar, verificar e registrar um número.
 *  Contrato verificado em produção — ver spec §4. O token vai SEMPRE por
 *  header: em query string ele vazaria para log de proxy e histórico. */
@Injectable()
export class MetaNumerosClient {
  constructor(
    private readonly versao: string,
    private readonly token: string,
    /** Timeout de cada chamada à Graph API. Configurável por
     *  META_HTTP_TIMEOUT_MS, mas quem lê e valida a variável é o provider
     *  (channels.module.ts); aqui só entra o valor já aprovado ou o default. */
    private readonly timeoutMs = TIMEOUT_PADRAO_MS,
  ) {}

  private chamar(caminho: string, metodo: 'GET' | 'POST', corpo?: URLSearchParams) {
    return this.chamarUrl(`${BASE_GRAPH}${this.versao}/${caminho}`, metodo, corpo);
  }

  /** Toda falha de transporte vira Falha normal do client, nunca exceção.
   *  `fetch` sem timeout pendura a requisição do cliente até o socket morrer, e
   *  `r.json()` estoura em qualquer resposta não-JSON (HTML de proxy, corpo
   *  vazio) — os dois escapariam como 500 em inglês, deixando a solicitação
   *  presa em 'criando', sem mensagem do catálogo e sem error_code. */
  private async chamarUrl(
    url: string,
    metodo: 'GET' | 'POST',
    corpo?: URLSearchParams,
  ): Promise<{ status: number; body: any }> {
    const abortador = new AbortController();
    const relogio = setTimeout(() => abortador.abort(), this.timeoutMs);
    try {
      const r = await fetch(url, {
        method: metodo,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(corpo ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(corpo ? { body: corpo.toString() } : {}),
        signal: abortador.signal,
      });
      // text() antes de JSON.parse: é o único jeito de sobreviver a um 200 com
      // HTML no corpo, que é justamente o caso perigoso (o status sozinho diria
      // "sucesso" para um registro que nunca aconteceu).
      const texto = await r.text();
      try {
        return { status: r.status, body: texto ? JSON.parse(texto) : {} };
      } catch {
        return falhaDeTransporte('resposta inválida da Meta (não é JSON)');
      }
    } catch (e) {
      const expirou = e instanceof Error && e.name === 'AbortError';
      // mensagem fixa, sem o texto cru do erro: ele carrega a URL chamada.
      return falhaDeTransporte(
        expirou ? 'tempo esgotado ao falar com a Meta' : 'falha de rede ao falar com a Meta',
      );
    } finally {
      clearTimeout(relogio);
    }
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

  /** Varre TODAS as páginas de `{waba}/phone_numbers`.
   *
   *  Ler só a primeira página funciona por coincidência — a página padrão da
   *  Graph API (25) é maior que o teto atual (ZAPLANE_WABA_PHONE_CAP=20). No
   *  dia em que o teto subisse, `contarNumeros` viraria no-op silencioso e a
   *  plataforma queimaria vagas achando que tem espaço. */
  private async paginarNumeros(wabaId: string): Promise<{ ok: true; ids: string[] } | Falha> {
    const ids: string[] = [];
    let url: string | null = `${BASE_GRAPH}${this.versao}/${wabaId}/phone_numbers?fields=id&limit=100`;
    let paginas = 0;
    while (url) {
      if (++paginas > MAX_PAGINAS) {
        // falha FECHADO: um total parcial aqui é pior que erro nenhum — ele
        // liberaria a adição de número numa WABA possivelmente lotada.
        return { ok: false, codigo: null, detalhe: 'paginação da Graph API não terminou' };
      }
      const r = await this.chamarUrl(url, 'GET');
      if (r.status >= 400) return falha(r.body);
      for (const x of r.body?.data ?? []) ids.push(String(x.id));
      const proxima = r.body?.paging?.next;
      // `next` vem de resposta externa: só seguimos se for da própria Graph API.
      url = typeof proxima === 'string' && proxima.startsWith(BASE_GRAPH) ? proxima : null;
    }
    return { ok: true, ids };
  }

  async contarNumeros(wabaId: string): Promise<{ ok: true; total: number } | Falha> {
    const r = await this.paginarNumeros(wabaId);
    return r.ok ? { ok: true, total: r.ids.length } : r;
  }

  /** Lista os IDs de todos os números atualmente na WABA — usado pela
   *  reconciliação para achar números sem dono no banco (spec §8). */
  async listarNumeros(wabaId: string): Promise<{ ok: true; ids: string[] } | Falha> {
    return this.paginarNumeros(wabaId);
  }

  /** Obrigatório por WABA: sem isso o número envia e NENHUM status volta. */
  async inscreverWebhook(wabaId: string): Promise<{ ok: true } | Falha> {
    const r = await this.chamar(`${wabaId}/subscribed_apps`, 'POST', new URLSearchParams());
    return r.status < 400 ? { ok: true } : falha(r.body);
  }
}

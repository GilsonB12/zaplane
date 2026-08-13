import { Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';

// O pacote não reexporta ThrottlerStorageRecord no index, então o formato é
// declarado aqui (idêntico ao de throttler-storage-record.interface).
type RegistroThrottler = {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
};

type Balde = {
  hits: number;
  /** epoch ms em que a janela atual vence */
  expiraEm: number;
  /** epoch ms até quando este balde está bloqueado (0 = livre) */
  bloqueadoAte: number;
};

/**
 * Armazenamento de rate limit por JANELA FIXA, derivando o vencimento do
 * relógio em vez de setTimeout.
 *
 * Motivo de existir: o storage em memória que vem no @nestjs/throttler guarda
 * os timers de decremento numa lista ÚNICA por nome de throttler, e quando um
 * balde qualquer sai de bloqueio ele executa clearTimeout em TODOS os timers da
 * lista. O efeito prático é que o contador dos outros baldes para de decrementar
 * e passa a crescer para sempre: um cliente leva 429 sem nunca ter abusado,
 * porque outro cliente foi bloqueado. Como esta plataforma é multi-tenant, esse
 * vazamento entre baldes é exatamente o que a correção do rate limit precisa
 * impedir.
 *
 * Aqui não há timer algum — a janela vence pela comparação com Date.now(), então
 * baldes são completamente independentes entre si.
 *
 * Limite conhecido: é memória do processo. Com mais de uma réplica no Railway,
 * cada uma tem sua contagem e o limite efetivo multiplica pelo número de
 * réplicas. Se um dia houver réplicas, o caminho é ThrottlerStorageRedis.
 */
@Injectable()
export class JanelaFixaStorage implements ThrottlerStorage {
  private readonly baldes = new Map<string, Balde>();

  constructor() {
    // Sem faxina o Map cresceria indefinidamente (uma chave por usuário/IP
    // visto). unref() para o intervalo não segurar o processo no shutdown.
    setInterval(() => this.limpar(), 60_000).unref?.();
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ): Promise<RegistroThrottler> {
    const agora = Date.now();
    let b = this.baldes.get(key);

    // janela vencida (ou primeira visita) → começa uma nova
    if (!b || agora >= b.expiraEm) {
      b = { hits: 0, expiraEm: agora + ttl, bloqueadoAte: 0 };
    }

    if (b.bloqueadoAte > agora) {
      this.baldes.set(key, b);
      return {
        totalHits: b.hits,
        timeToExpire: Math.ceil((b.expiraEm - agora) / 1000),
        isBlocked: true,
        timeToBlockExpire: Math.ceil((b.bloqueadoAte - agora) / 1000),
      };
    }

    b.hits += 1;
    const bloqueado = b.hits > limit;
    if (bloqueado) b.bloqueadoAte = agora + blockDuration;
    this.baldes.set(key, b);

    return {
      totalHits: b.hits,
      timeToExpire: Math.ceil((b.expiraEm - agora) / 1000),
      isBlocked: bloqueado,
      timeToBlockExpire: bloqueado ? Math.ceil(blockDuration / 1000) : 0,
    };
  }

  private limpar() {
    const agora = Date.now();
    for (const [chave, b] of this.baldes) {
      if (agora >= b.expiraEm && agora >= b.bloqueadoAte) {
        this.baldes.delete(chave);
      }
    }
  }
}

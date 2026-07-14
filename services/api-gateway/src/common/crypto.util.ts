import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Utilitários de PII.
 * - phoneHash: HMAC-SHA256 do E.164 → permite dedup/busca sem expor o número.
 * - encrypt/decrypt: AES-256-GCM para cifrar o número/segredos em repouso.
 *
 * A chave vem de APP_ENCRYPTION_KEY (base64 de 32 bytes). TODO produção:
 * usar um KMS/secret manager e rotação de chave.
 */
function key(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY || '';
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    if (process.env.NODE_ENV === 'production') {
      // em produção não há fallback seguro: sem chave válida, aborta o processo.
      throw new Error(
        'APP_ENCRYPTION_KEY ausente ou inválida (32 bytes base64) — obrigatória em produção.',
      );
    }
    // fallback de dev — NÃO usar em produção
    return Buffer.alloc(32, 0);
  }
  return buf;
}

export function phoneHash(e164: string): string {
  return createHmac('sha256', key()).update(e164).digest('hex');
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(':');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

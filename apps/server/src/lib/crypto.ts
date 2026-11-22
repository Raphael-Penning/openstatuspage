import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const GCM_TAG_BYTES = 16;

/**
 * Symmetric encryption for secrets stored in the database (monitoring
 * credentials). AES-256-GCM with a key derived from SECRET_KEY.
 * Format: v1.<iv b64url>.<tag b64url>.<ciphertext b64url>
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash('sha256').update(`openstatuspage:secretbox:${secret}`).digest();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split('.');
    if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unsupported secret format');
    const authTag = Buffer.from(tag, 'base64url');
    // Only full 16-byte tags: GCM accepts truncated ones, which are easier to forge.
    if (authTag.length !== GCM_TAG_BYTES) throw new Error('Unsupported secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'), {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T = unknown>(payload: string): T {
    return JSON.parse(this.decrypt(payload)) as T;
  }
}

/** SHA-256 hex digest, used to store tokens without keeping them in clear text. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

import { randomBytes, randomUUID } from 'node:crypto';

/** Random, URL-safe, time-independent ID. */
export function newId(): string {
  return randomUUID();
}

/** High-entropy secret token (session, API token, ingest token). */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

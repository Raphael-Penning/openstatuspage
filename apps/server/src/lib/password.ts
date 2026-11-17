import { hash, verify } from '@node-rs/argon2';

/** Argon2id with library defaults (OWASP-compliant). */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  try {
    return await verify(hashValue, password);
  } catch {
    return false;
  }
}

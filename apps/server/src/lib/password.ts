/**
 * Argon2 (native module), loaded with the first hash or check: a public or worker
 * instance never handles passwords and does not keep it in memory.
 */
let argon2: Promise<typeof import('@node-rs/argon2')> | null = null;
const load = () => (argon2 ??= import('@node-rs/argon2'));

/** Argon2id with library defaults (OWASP-compliant). */
export async function hashPassword(password: string): Promise<string> {
  return (await load()).hash(password);
}

export async function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  try {
    return await (await load()).verify(hashValue, password);
  } catch {
    return false;
  }
}

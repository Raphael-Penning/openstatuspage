/**
 * Version of the server package: built in by tsup (process.env.OSP_VERSION is
 * replaced at build time, tsup.config.ts), read from package.json when running
 * from source (development, tests). Only the management API shows it, never
 * anonymous clients.
 */
import { readFileSync } from 'node:fs';

function fromPackageJson(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

let cached: string | undefined;

export function appVersion(): string {
  return (cached ??= process.env.OSP_VERSION || fromPackageJson());
}

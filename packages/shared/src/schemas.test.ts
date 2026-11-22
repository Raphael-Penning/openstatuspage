import { describe, expect, it } from 'vitest';
import { zHttpUrlOrPath } from './schemas.js';

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: string) => schema.safeParse(value).success;

describe('zHttpUrlOrPath', () => {
  it('accepts http(s) URLs and paths on this site', () => {
    expect(ok(zHttpUrlOrPath, 'https://cdn.example.com/logo.svg')).toBe(true);
    expect(ok(zHttpUrlOrPath, '/logo.svg')).toBe(true);
    expect(ok(zHttpUrlOrPath, '/brand/favicon.ico?v=2')).toBe(true);
  });

  it('rejects paths that a browser reads as another host or that carry hidden characters', () => {
    for (const value of ['//evil.example.com/x.svg', '/\\evil.example.com/x.svg', '/a\\b.svg', '/logo .svg', '/logo\t.svg', '/a\n.svg', '/a\u0000']) {
      expect(ok(zHttpUrlOrPath, value)).toBe(false);
    }
    expect(ok(zHttpUrlOrPath, 'javascript:alert(1)')).toBe(false);
    expect(ok(zHttpUrlOrPath, 'logo.svg')).toBe(false);
  });
});

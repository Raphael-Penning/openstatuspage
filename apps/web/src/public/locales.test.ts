import { describe, expect, it } from 'vitest';
import de from '../locales/de/public.json';
import en from '../locales/en/public.json';

function keys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

const sources = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('public locales', () => {
  it('have the same keys in every language', () => {
    expect(keys(de).sort()).toEqual(keys(en).sort());
  });

  it('have no empty strings', () => {
    const empty = (obj: unknown): boolean =>
      typeof obj === 'string' ? obj.trim() === '' : Object.values(obj as object).some(empty);
    expect(empty(en)).toBe(false);
    expect(empty(de)).toBe(false);
  });

  it('define every subscription key used in the public sources', () => {
    const defined = new Set(keys(en).map((k) => k.replace(/_(zero|one|two|few|many|other)$/, '')));
    const used = new Set<string>();
    for (const [file, code] of Object.entries(sources)) {
      if (file.endsWith('.test.ts')) continue;
      for (const m of code.matchAll(/'(subscription\.[a-zA-Z.]+)'/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(30);
    expect([...used].filter((k) => !defined.has(k))).toEqual([]);
  });
});

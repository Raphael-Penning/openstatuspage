import { describe, expect, it } from 'vitest';
import de from '../locales/de/public.json';
import en from '../locales/en/public.json';

function keys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

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
});

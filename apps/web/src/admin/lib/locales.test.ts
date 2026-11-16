import { describe, expect, it } from 'vitest';
import commonDe from '../../locales/de/common.json';
import adminDe from '../../locales/de/admin.json';
import commonEn from '../../locales/en/common.json';
import adminEn from '../../locales/en/admin.json';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' ? [`${prefix}${k}`] : flatten(v, `${prefix}${k}.`)));
}

/** Plural forms (key_one / key_other) are resolved by i18next from the base key. */
const stripPlural = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, '');

const sources = import.meta.glob('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Literal keys passed to t('...') in the admin sources, plus prefixes of template keys. */
function usedKeys(): { literal: Set<string>; prefixes: Set<string> } {
  const literal = new Set<string>();
  const prefixes = new Set<string>();
  for (const [file, code] of Object.entries(sources)) {
    if (file.endsWith('.test.ts')) continue;
    for (const m of code.matchAll(/\bt\(\s*'([^']+)'/g)) literal.add(m[1]!);
    for (const m of code.matchAll(/\bt\(\s*`([^`$]+)\$\{/g)) prefixes.add(m[1]!);
    for (const m of code.matchAll(/key: '(validation\.[a-zA-Z.]+)'/g)) literal.add(m[1]!);
  }
  return { literal, prefixes };
}

describe('admin locales', () => {
  const en = new Set(flatten(adminEn as Tree).map(stripPlural));
  const de = new Set(flatten(adminDe as Tree).map(stripPlural));
  const common = new Set(flatten(commonEn as Tree));

  it('has the same keys in English and German', () => {
    expect([...en].filter((k) => !de.has(k))).toEqual([]);
    expect([...de].filter((k) => !en.has(k))).toEqual([]);
    expect(flatten(commonEn as Tree).sort()).toEqual(flatten(commonDe as Tree).sort());
  });

  it('defines every key used in the admin sources', () => {
    const { literal, prefixes } = usedKeys();
    expect(literal.size).toBeGreaterThan(100);
    const missing = [...literal].filter((k) => (k.startsWith('common:') ? !common.has(k.slice(7)) : !en.has(k)));
    expect(missing).toEqual([]);
    const missingPrefixes = [...prefixes].filter((p) => {
      const set = p.startsWith('common:') ? common : en;
      const prefix = p.startsWith('common:') ? p.slice(7) : p;
      return ![...set].some((k) => k.startsWith(prefix));
    });
    expect(missingPrefixes).toEqual([]);
  });
});

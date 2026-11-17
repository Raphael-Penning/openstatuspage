import { describe, expect, it } from 'vitest';
import commonEn from '../locales/en/common.json';
import de from '../locales/de/help.json';
import en from '../locales/en/help.json';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' ? [`${prefix}${k}`] : flatten(v, `${prefix}${k}.`)));
}

const sources = import.meta.glob('./*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const layout = import.meta.glob('../admin/components/AdminLayout.tsx', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

describe('help locales', () => {
  it('has the same keys in English and German, none empty', () => {
    expect(flatten(de as Tree).sort()).toEqual(flatten(en as Tree).sort());
    const values = [...Object.values(en), ...Object.values(de)];
    expect(values.every((v) => typeof v === 'string' && v.trim() !== '')).toBe(true);
  });

  it('defines every key used by the help area', () => {
    const keys = new Set(flatten(en as Tree));
    const common = new Set(flatten(commonEn as Tree));
    const used = Object.values(sources).flatMap((code) => [...code.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]!));
    const nav = Object.values(layout).flatMap((code) => [...code.matchAll(/\btHelp\(\s*'([^']+)'/g)].map((m) => m[1]!));
    expect(used.length).toBeGreaterThan(5);
    expect(nav).toEqual(['nav']);
    const missing = [...used, ...nav].filter((k) => (k.startsWith('common:') ? !common.has(k.slice(7)) : !keys.has(k)));
    expect(missing).toEqual([]);
  });
});

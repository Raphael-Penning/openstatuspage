const UMLAUTS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/** Builds a URL-safe slug from a display name. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[\u00e4\u00f6\u00fc\u00df]/g, (c) => UMLAUTS[c] ?? c)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'item';
}

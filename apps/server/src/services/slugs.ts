import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { conflict } from '../lib/errors.js';
import { slugify } from '../lib/slug.js';

type SluggedTable = 'locations' | 'service_groups' | 'services';

async function taken(db: Kysely<Database>, table: SluggedTable, base: string, excludeId?: string): Promise<Set<string>> {
  let q = db
    .selectFrom(table)
    .select(['slug'])
    .where((eb) => eb.or([eb('slug', '=', base), eb('slug', 'like', `${base}-%`)]));
  if (excludeId) q = q.where('id', '!=', excludeId);
  const rows = await q.execute();
  return new Set(rows.map((r) => r.slug));
}

/**
 * Resolves the slug for a create/update.
 * - explicit slug: used as is, 409 when another row has it
 * - no slug, existing row: keeps `currentSlug`
 * - no slug, new row: generated from `name`, duplicates get `-2`, `-3`, ...
 */
export async function resolveSlug(
  db: Kysely<Database>,
  table: SluggedTable,
  opts: { slug?: string | null; name: string; excludeId?: string; currentSlug?: string },
): Promise<string> {
  if (opts.slug) {
    const used = await taken(db, table, opts.slug, opts.excludeId);
    if (used.has(opts.slug)) throw conflict(`Slug "${opts.slug}" is already in use`);
    return opts.slug;
  }
  if (opts.currentSlug) return opts.currentSlug;

  const base = slugify(opts.name).slice(0, 72).replace(/-+$/, '') || 'item';
  const used = await taken(db, table, base, opts.excludeId);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

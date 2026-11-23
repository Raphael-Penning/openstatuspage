/**
 * Content pages (migration 0014_site_pages_uploads, packages/shared/src/site-pages.ts).
 *
 * Public reads (the public settings document, the page document, the sitemap,
 * llms.txt) select only published pages and only the columns of the view
 * osp_public.site_pages: on PostgreSQL with APP_ROLE=public they read that view,
 * everywhere else the table with the same filter.
 */
import {
  isSystemPageKey,
  sitePagePath,
  uploadPathsIn,
  type AdminSitePage,
  type ImageSize,
  type LocalizedText,
  type PublicSitePage,
  type PublicSitePageLink,
  type SystemPageKey,
} from '@openstatuspage/shared';
import type { Selectable } from 'kysely';
import type { DB } from '../db/index.js';
import type { SitePagesTable } from '../db/types.js';
import { uploadSizes } from './uploads.js';

/** The columns of osp_public.site_pages (not created_by). */
const PUBLIC_COLUMNS = [
  'id',
  'system_key',
  'slug',
  'title_en',
  'title_de',
  'description_en',
  'description_de',
  'body_en',
  'body_de',
  'published',
  'show_in_footer',
  'show_in_nav',
  'sort_order',
  'created_at',
  'updated_at',
] as const;

type PageRow = Pick<Selectable<SitePagesTable>, (typeof PUBLIC_COLUMNS)[number]>;

const text = (en: string | null | undefined, de: string | null | undefined): LocalizedText => ({ en: en ?? '', de: de ?? '' });
const systemKey = (value: string | null): SystemPageKey | null => (isSystemPageKey(value) ? value : null);

export function toAdminSitePage(row: PageRow): AdminSitePage {
  const key = systemKey(row.system_key);
  return {
    id: row.id,
    systemKey: key,
    slug: row.slug,
    path: sitePagePath({ systemKey: key, slug: row.slug }),
    title: text(row.title_en, row.title_de),
    description: text(row.description_en, row.description_de),
    body: text(row.body_en, row.body_de),
    published: row.published === 1,
    showInFooter: row.show_in_footer === 1,
    showInNav: row.show_in_nav === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every page for the management UI: system pages first, then by order and slug. */
export async function loadAdminSitePages(db: DB, ids?: string[]): Promise<AdminSitePage[]> {
  let query = db.selectFrom('site_pages').select(PUBLIC_COLUMNS);
  if (ids) {
    if (ids.length === 0) return [];
    query = query.where('id', 'in', ids);
  }
  const rows = await query.orderBy('sort_order').orderBy('slug').execute();
  return rows.map(toAdminSitePage).sort((a, b) => Number(b.systemKey !== null) - Number(a.systemKey !== null));
}

/** The published pages for the navigation of the public page (no texts). */
export async function loadPublicPageLinks(db: DB): Promise<PublicSitePageLink[]> {
  const rows = await db
    .selectFrom('site_pages')
    .select(['system_key', 'slug', 'title_en', 'title_de', 'show_in_footer', 'show_in_nav', 'sort_order'])
    .where('published', '=', 1)
    .orderBy('sort_order')
    .orderBy('slug')
    .execute();
  return rows.map((r) => {
    const key = systemKey(r.system_key);
    return {
      systemKey: key,
      slug: r.slug,
      path: sitePagePath({ systemKey: key, slug: r.slug }),
      title: text(r.title_en, r.title_de),
      showInFooter: r.show_in_footer === 1,
      showInNav: r.show_in_nav === 1,
      sortOrder: r.sort_order,
    };
  });
}

/** A published page by its slug; null when there is none (or it is not published). */
export async function loadPublicSitePage(db: DB, slug: string): Promise<PublicSitePage | null> {
  const row = await db.selectFrom('site_pages').select(PUBLIC_COLUMNS).where('slug', '=', slug).where('published', '=', 1).executeTakeFirst();
  if (!row) return null;
  const page = toAdminSitePage(row);
  const images: Record<string, ImageSize> = await uploadSizes(db, uploadPathsIn(`${page.body.en}\n${page.body.de}`));
  return {
    id: page.id,
    systemKey: page.systemKey,
    slug: page.slug,
    path: page.path,
    title: page.title,
    description: page.description,
    body: page.body,
    images,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

/** Published pages for the sitemap (path and last change). */
export async function publicPagePaths(db: DB): Promise<{ path: string; updatedAt: string; title: LocalizedText; description: LocalizedText }[]> {
  const rows = await db
    .selectFrom('site_pages')
    .select(['system_key', 'slug', 'title_en', 'title_de', 'description_en', 'description_de', 'updated_at'])
    .where('published', '=', 1)
    .orderBy('sort_order')
    .orderBy('slug')
    .execute();
  return rows.map((r) => ({
    path: sitePagePath({ systemKey: systemKey(r.system_key), slug: r.slug }),
    updatedAt: r.updated_at,
    title: text(r.title_en, r.title_de),
    description: text(r.description_en, r.description_de),
  }));
}

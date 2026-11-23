/**
 * Content pages and uploads on PostgreSQL (migration 0014_site_pages_uploads):
 * the restricted public role holds no privilege on the base tables and reads
 * them only through the views of osp_public, which show published pages only
 * and leave out created_by and the original file names. A public instance
 * serves pages, the page links of the settings and the uploaded files.
 */
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { DB } from '../src/db/index.js';
import { prepareDatabase } from '../src/startup.js';
import { createWebDir, renderFromSource } from '../test/web-fixture.js';
import { createTestDatabase, type PgTestDatabase } from './setup.js';

const NOW = new Date().toISOString();
const log = { info: () => undefined, warn: () => undefined };

let pgdb: PgTestDatabase;
let owner: DB;
let pub: DB;

function pngBytes(width: number, height: number): Buffer {
  const b = Buffer.alloc(45);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
const IMAGE = pngBytes(64, 32);
const HASH = createHash('sha256').update(IMAGE).digest('hex');

async function attempt(query: string): Promise<string> {
  try {
    await sql.raw(query).execute(pub);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

const rows = async <T = Record<string, unknown>>(query: string, db: DB = pub) => (await sql.raw(query).execute(db)).rows as T[];

beforeAll(async () => {
  pgdb = await createTestDatabase();
  owner = await pgdb.connect('admin');
  await prepareDatabase(owner, pgdb.config('admin'), log);
  await owner.insertInto('settings').values({ key: 'page', value: JSON.stringify({ siteName: 'Example Status', logoUrl: `/uploads/${HASH}.png` }), updated_at: NOW }).execute();
  await owner.updateTable('site_pages').set({ published: 1, body_en: 'Example Ltd.', body_de: 'Beispiel GmbH' }).where('system_key', '=', 'legal-notice').execute();
  await owner
    .insertInto('site_pages')
    .values([
      { id: 'p-faq', system_key: null, slug: 'faq', title_en: 'FAQ', body_en: `![Diagram](/uploads/${HASH}.png)`, published: 1, show_in_footer: 1, sort_order: 10, created_at: NOW, updated_at: NOW },
      { id: 'p-draft', system_key: null, slug: 'draft', title_en: 'Draft', body_en: 'SECRET DRAFT', published: 0, created_at: NOW, updated_at: NOW },
    ] as never)
    .execute();
  await owner
    .insertInto('uploads')
    .values({
      id: 'u-1',
      hash: HASH,
      extension: 'png',
      content_type: 'image/png',
      byte_size: IMAGE.length,
      width: 64,
      height: 32,
      data: IMAGE,
      filename: 'internal-name.png',
      created_by: null,
      created_at: NOW,
    })
    .execute();
  pub = await pgdb.connect('public');
}, 60_000);

afterAll(async () => {
  await pub?.destroy();
  await owner?.destroy();
  await pgdb?.drop();
});

describe('base tables', () => {
  it('are not readable by the public role', async () => {
    for (const table of ['site_pages', 'uploads']) {
      expect(await attempt(`select * from public.${table}`), table).toBe('42501');
      expect(await attempt(`select count(*) from public.${table}`), table).toBe('42501');
    }
    expect(await attempt(`update public.site_pages set body_en = 'pwned'`)).toBe('42501');
    expect(await attempt(`delete from public.uploads`)).toBe('42501');
  });

  it('have row level security with the policy of the public role', async () => {
    const tables = await rows<{ name: string; rls: boolean; policy: boolean }>(
      `select c.relname as name, c.relrowsecurity as rls,
        exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'osp_public_role') as policy
       from pg_class c where c.relnamespace = current_schema()::regnamespace and c.relname in ('site_pages', 'uploads') order by 1`,
      owner,
    );
    expect(tables).toEqual([
      { name: 'site_pages', rls: true, policy: true },
      { name: 'uploads', rls: true, policy: true },
    ]);
  });
});

describe('osp_public views', () => {
  it('show only published pages, without created_by', async () => {
    const pages = await rows<{ slug: string }>('select slug from osp_public.site_pages order by slug');
    expect(pages.map((p) => p.slug)).toEqual(['faq', 'legal-notice']);
    expect(JSON.stringify(await rows('select * from osp_public.site_pages'))).not.toContain('SECRET DRAFT');
    expect(await attempt('select created_by from osp_public.site_pages')).toBe('42703');
    // Writes through the view are refused.
    expect(await attempt(`update osp_public.site_pages set body_en = 'pwned'`)).toBe('42501');
  });

  it('show the uploads without file name or creator', async () => {
    expect(await rows('select hash, width, height from osp_public.uploads')).toEqual([{ hash: HASH, width: 64, height: 32 }]);
    expect(await attempt('select filename from osp_public.uploads')).toBe('42703');
    expect(await attempt('select created_by from osp_public.uploads')).toBe('42703');
    expect(await attempt(`delete from osp_public.uploads`)).toBe('42501');
  });
});

describe('a public instance', () => {
  it('serves pages, page links, uploads and their sizes', async () => {
    const web = createWebDir();
    const app = await buildApp({ config: { ...pgdb.config('public'), WEB_DIST_DIR: web.dir }, db: pub, ssrModule: renderFromSource });
    try {
      await app.ready();
      const settings = (await app.inject('/api/public/settings')).json().data.attributes;
      expect(settings.pages.map((p: { path: string }) => p.path)).toEqual(['/legal-notice', '/pages/faq']);
      expect(settings.logoSize).toEqual({ width: 64, height: 32 });

      const page = await app.inject('/api/public/pages/faq');
      expect(page.statusCode).toBe(200);
      expect(page.json().data.attributes.images).toEqual({ [`/uploads/${HASH}.png`]: { width: 64, height: 32 } });
      expect((await app.inject('/api/public/pages/draft')).statusCode).toBe(404);

      const file = await app.inject(`/uploads/${HASH}.png`);
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toBe('image/png');
      expect(file.rawPayload.equals(IMAGE)).toBe(true);

      const html = await app.inject('/legal-notice');
      expect(html.statusCode).toBe(200);
      expect(html.body).toContain('Example Ltd.');
      const sitemap = (await app.inject('/sitemap-pages.xml')).body;
      expect(sitemap).toContain('/legal-notice</loc>');
      expect(sitemap).not.toContain('/pages/draft');
    } finally {
      await app.close();
      web.remove();
    }
  });
});

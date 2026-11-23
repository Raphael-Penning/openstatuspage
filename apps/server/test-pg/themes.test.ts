/**
 * Themes on PostgreSQL (migration 0017_themes): the restricted public role
 * holds no privilege on the base tables and reads only the active theme
 * through the views of osp_public (no other stored theme, no created_by). A
 * public instance serves the active theme's stylesheets, its extra CSS too.
 */
import { BUILTIN_THEMES, themeTokensCss, type ThemeFile } from '@openstatuspage/shared';
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

const theme = (id: string): ThemeFile => ({ ...(JSON.parse(JSON.stringify(BUILTIN_THEMES[1])) as ThemeFile), id, name: `Theme ${id}` });

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
  await owner
    .insertInto('themes')
    .values([
      { id: 'ocean', name: 'Ocean', definition: JSON.stringify(theme('ocean')), css: '.osp-group{gap:1rem}', created_by: null, created_at: NOW, updated_at: NOW },
      { id: 'draft', name: 'Draft', definition: JSON.stringify(theme('draft')), css: '/* SECRET DRAFT */', created_by: null, created_at: NOW, updated_at: NOW },
    ])
    .execute();
  await owner.updateTable('active_theme').set({ theme_id: 'ocean', updated_at: NOW }).where('slot', '=', 'active').execute();
  pub = await pgdb.connect('public');
}, 60_000);

afterAll(async () => {
  await pub?.destroy();
  await owner?.destroy();
  await pgdb?.drop();
});

describe('base tables', () => {
  it('are not readable or writable by the public role', async () => {
    for (const table of ['themes', 'active_theme']) {
      expect(await attempt(`select * from public.${table}`), table).toBe('42501');
      expect(await attempt(`select count(*) from public.${table}`), table).toBe('42501');
    }
    expect(await attempt(`update public.active_theme set theme_id = 'draft'`)).toBe('42501');
    expect(await attempt(`insert into public.themes (id, name, definition, created_at, updated_at) values ('x', 'x', '{}', 'now', 'now')`)).toBe('42501');
    expect(await attempt(`delete from public.themes`)).toBe('42501');
  });

  it('have row level security', async () => {
    const result = await rows<{ name: string; rls: boolean }>(
      `select c.relname as name, c.relrowsecurity as rls from pg_class c
       where c.relnamespace = current_schema()::regnamespace and c.relname in ('themes', 'active_theme') order by 1`,
      owner,
    );
    expect(result).toEqual([
      { name: 'active_theme', rls: true },
      { name: 'themes', rls: true },
    ]);
  });
});

describe('osp_public views', () => {
  it('show the active theme only, without its creator', async () => {
    expect(await rows('select theme_id from osp_public.active_theme')).toEqual([{ theme_id: 'ocean' }]);
    expect(await rows('select id, css from osp_public.themes')).toEqual([{ id: 'ocean', css: '.osp-group{gap:1rem}' }]);
    expect(JSON.stringify(await rows('select * from osp_public.themes'))).not.toContain('SECRET DRAFT');
    expect(await attempt('select created_by from osp_public.themes')).toBe('42703');
  });

  it('are read-only', async () => {
    expect(await attempt(`update osp_public.active_theme set theme_id = 'draft'`)).toBe('42501');
    expect(await attempt(`update osp_public.themes set css = 'x'`)).toBe('42501');
    expect(await attempt(`delete from osp_public.themes`)).toBe('42501');
  });

  it('follow the active theme', async () => {
    await owner.updateTable('active_theme').set({ theme_id: 'forest' }).where('slot', '=', 'active').execute();
    try {
      // A built-in theme: no stored theme is visible at all.
      expect(await rows('select id from osp_public.themes')).toEqual([]);
      expect(await rows('select theme_id from osp_public.active_theme')).toEqual([{ theme_id: 'forest' }]);
    } finally {
      await owner.updateTable('active_theme').set({ theme_id: 'ocean' }).where('slot', '=', 'active').execute();
    }
  });
});

describe('a public instance', () => {
  it('serves the active theme with its extra CSS', async () => {
    const web = createWebDir();
    const app = await buildApp({ config: { ...pgdb.config('public'), WEB_DIST_DIR: web.dir }, db: pub, ssrModule: renderFromSource });
    try {
      await app.ready();
      const settings = (await app.inject('/api/public/settings')).json().data.attributes;
      expect(settings.theme.id).toBe('ocean');
      expect(settings.theme.stylesheets).toHaveLength(2);
      const page = await app.inject('/');
      expect(page.statusCode).toBe(200);
      for (const href of settings.theme.stylesheets as string[]) expect(page.body).toContain(`<link rel="stylesheet" href="${href}" data-osp-theme>`);
      const [tokens, extra] = await Promise.all((settings.theme.stylesheets as string[]).map((href) => app.inject(href)));
      expect(tokens!.body).toBe(themeTokensCss(theme('ocean')));
      expect(extra!.body).toBe('.osp-group{gap:1rem}');
      expect(extra!.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      // No preview on a public instance.
      const preview = await app.inject({ url: '/?theme=draft', headers: { cookie: 'osp_session=x' } });
      expect(preview.body).not.toContain('SECRET');
    } finally {
      await app.close();
      web.remove();
    }
  });
});

/**
 * Themes (docs/themes.md): the themes folder, the management API (import,
 * edit, delete, export, activation with the WCAG AA guard, audit log), the
 * stylesheets at /theme/<hash>.css, the server-rendered pages (theme links,
 * no inline style, the admin-only preview) and migration 0017.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_THEMES, themeTokensCss, type AdminTheme, type ThemeFile } from '@openstatuspage/shared';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, migrateToLatest } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';
import { loadThemeFolder, ThemeService, themesDir } from '../src/services/themes.js';
import { client, createTestApp, createUser, data, doc, errors, login, page, type Client, type TestApp } from './helpers.js';
import { createWebDir, renderFromSource } from './web-fixture.js';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const slate = BUILTIN_THEMES.find((t) => t.id === 'slate')!;
const custom = (id: string, patch: (t: ThemeFile) => void = () => {}): ThemeFile => {
  const theme = clone(slate);
  theme.id = id;
  theme.name = `Theme ${id}`;
  patch(theme);
  return theme;
};
const failing = (id: string) => custom(id, (t) => (t.light.muted = '#b4b4b4'));
const hash = 'c'.repeat(64);

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('themes folder', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'osp-themes-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('loads valid themes with their CSS and logs and skips the rest', () => {
    const write = (name: string, content: unknown) => writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
    write('ocean.json', custom('ocean'));
    write('ocean.css', `header { background-image: url(/uploads/${hash}.png); }`);
    write('plain.json', custom('plain'));
    write('broken.json', '{ not json');
    write('invalid.json', { ...custom('invalid'), shadow: true });
    write('renamed.json', custom('other-id'));
    write('default.json', custom('default'));
    write('evil.json', custom('evil'));
    write('evil.css', '@import url(https://example.com/x.css);');
    write('huge.json', custom('huge'));
    write('huge.css', `a{}${' '.repeat(70 * 1024)}`);
    write('notes.txt', 'ignored');
    write('.hidden.json', custom('hidden'));
    mkdirSync(join(dir, 'sub.json'));
    // A ConfigMap mounts its files as symbolic links.
    mkdirSync(join(dir, '..data'));
    writeFileSync(join(dir, '..data', 'linked.json'), JSON.stringify(custom('linked')));
    symlinkSync(join(dir, '..data', 'linked.json'), join(dir, 'linked.json'));

    const logger = log();
    const themes = loadThemeFolder(dir, logger);
    expect([...themes.keys()].sort()).toEqual(['linked', 'ocean', 'plain']);
    expect(themes.get('ocean')!.css).toContain('/uploads/');
    expect(themes.get('ocean')!.source).toBe('folder');
    expect(themes.get('plain')!.css).toBeNull();
    const skipped = logger.warn.mock.calls.map(([obj, msg]) => `${(obj as { file: string }).file.split('/').pop()}: ${msg}`);
    expect(skipped).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^broken\.json: .*not valid JSON/),
        expect.stringMatching(/^invalid\.json: .*not a valid theme/),
        expect.stringMatching(/^renamed\.json: .*differs from the file name/),
        expect.stringMatching(/^default\.json: .*built-in/),
        expect.stringMatching(/^evil\.json: .*extra CSS is not allowed/),
        expect.stringMatching(/^huge\.json: .*larger than/),
      ]),
    );
    expect(skipped).toHaveLength(6);
  });

  it('accepts the example theme of contrib/themes (valid, passes AA)', async () => {
    const { themeContrastFailures } = await import('@openstatuspage/shared');
    const logger = log();
    const themes = loadThemeFolder(new URL('../../../contrib/themes', import.meta.url).pathname, logger);
    expect(logger.warn).not.toHaveBeenCalled();
    const ocean = themes.get('ocean')!;
    expect(ocean.css).toContain('var(--accent)');
    expect(themeContrastFailures(ocean.theme)).toEqual([]);
  });

  it('is optional', () => {
    const logger = log();
    expect(loadThemeFolder(join(dir, 'missing'), logger).size).toBe(0);
    expect(loadThemeFolder(null, logger).size).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('defaults to themes next to the SQLite database', () => {
    const base = { NODE_ENV: 'test', SECRET_KEY: 'x'.repeat(40), BASE_URL: 'https://status.example.com' };
    expect(themesDir(loadConfig({ ...base, DATABASE_URL: 'sqlite:/var/lib/openstatuspage/osp.db' }))).toBe('/var/lib/openstatuspage/themes');
    expect(themesDir(loadConfig({ ...base, DATABASE_URL: 'sqlite::memory:' }))).toBeNull();
    expect(themesDir(loadConfig({ ...base, DATABASE_URL: 'sqlite::memory:', THEMES_DIR: '/etc/openstatuspage/themes' }))).toBe('/etc/openstatuspage/themes');
  });
});

describe('theme management API', () => {
  let t: TestApp;
  let admin: Client;
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'osp-themes-'));
    writeFileSync(join(dir, 'folder-theme.json'), JSON.stringify(custom('folder-theme')));
    t = await createTestApp({ THEMES_DIR: dir });
    admin = client(t.app, { cookie: await (async () => {
      await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
      return login(t.app, 'admin@example.com');
    })() });
  });
  afterEach(async () => {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const themes = async () => page<AdminTheme>(await admin.get('/api/admin/themes')).items;

  it('lists built-in, folder and uploaded themes with their source', async () => {
    const list = await themes();
    expect(list.map((x) => [x.id, x.source, x.readOnly, x.active])).toEqual([
      ['default', 'builtin', true, true],
      ['slate', 'builtin', true, false],
      ['forest', 'builtin', true, false],
      ['high-contrast', 'builtin', true, false],
      ['folder-theme', 'folder', true, false],
    ]);
    expect(list.every((x) => x.contrastFailures.length === 0)).toBe(true);
  });

  it('imports, edits, exports and deletes an uploaded theme', async () => {
    const css = `.osp-group { gap: 1rem; } header { background: url(/uploads/${hash}.png); }`;
    const created = await admin.post('/api/admin/themes', doc('themes', { definition: custom('ocean'), css }));
    expect(created.statusCode).toBe(201);
    expect(data<AdminTheme>(created)).toMatchObject({ id: 'ocean', source: 'database', readOnly: false, css, cssBytes: css.length });

    const changed = custom('ocean', (x) => (x.name = 'Ocean blue'));
    const patched = await admin.patch('/api/admin/themes/ocean', doc('themes', { definition: changed }, { id: 'ocean' }));
    expect(patched.statusCode).toBe(200);
    expect(data<AdminTheme>(patched)).toMatchObject({ name: 'Ocean blue', css });

    const json = await admin.get('/api/admin/themes/ocean/export');
    expect(json.headers['content-disposition']).toBe('attachment; filename="ocean.json"');
    expect(json.headers['content-type']).toMatch(/^application\/json/);
    expect(JSON.parse(json.body)).toMatchObject({ id: 'ocean', name: 'Ocean blue', version: 1 });
    const cssFile = await admin.get('/api/admin/themes/ocean/export-css');
    expect(cssFile.body).toBe(css);
    expect(cssFile.headers['content-type']).toMatch(/^text\/css/);
    // Every theme can be exported, also built-in ones.
    expect(JSON.parse((await admin.get('/api/admin/themes/forest/export')).body).id).toBe('forest');
    expect((await admin.get('/api/admin/themes/forest/export-css')).statusCode).toBe(404);

    expect((await admin.delete('/api/admin/themes/ocean')).statusCode).toBe(204);
    expect((await admin.get('/api/admin/themes/ocean')).statusCode).toBe(404);

    const actions = await t.db.selectFrom('audit_log').select(['action', 'details']).where('entity_type', '=', 'theme').orderBy('id').execute();
    expect(actions.map((a) => a.action).sort()).toEqual(['theme.create', 'theme.delete', 'theme.update']);
    // Never the CSS itself in the audit log.
    expect(actions.every((a) => !String(a.details).includes('osp-group'))).toBe(true);
  });

  it('rejects invalid theme files and extra CSS', async () => {
    const bad = await admin.post('/api/admin/themes', doc('themes', { definition: { ...custom('bad'), extra: 1 } }));
    expect(bad.statusCode).toBe(400);
    expect(errors(bad).some((e) => e.source?.pointer?.startsWith('/data/attributes/definition'))).toBe(true);

    const color = await admin.post('/api/admin/themes', doc('themes', { definition: custom('bad', (x) => (x.light.text = 'red;}')) }));
    expect(color.statusCode).toBe(400);

    for (const css of ['@import "https://example.com/x.css";', 'a{background:url(https://example.com/t.png)}', '</style><script>alert(1)</script>', 'a{width:expression(alert(1))}']) {
      const res = await admin.post('/api/admin/themes', doc('themes', { definition: custom('bad'), css }));
      expect(res.statusCode, css).toBe(400);
      expect(errors(res)[0]!.code).toMatch(/^css_/);
    }
    const big = await admin.post('/api/admin/themes', doc('themes', { definition: custom('bad'), css: `a{}${' '.repeat(65 * 1024)}` }));
    expect(big.statusCode).toBe(400);
    expect(errors(big)[0]!.code).toBe('css_too_large');
    expect((await t.db.selectFrom('themes').select('id').execute()).length).toBe(0);
  });

  it('keeps built-in and folder themes read-only and ids unique', async () => {
    for (const id of ['default', 'folder-theme']) {
      expect((await admin.post('/api/admin/themes', doc('themes', { definition: custom(id) }))).statusCode, id).toBe(409);
      expect((await admin.patch(`/api/admin/themes/${id}`, doc('themes', { css: 'a{}' }, { id }))).statusCode).toBe(409);
      expect((await admin.delete(`/api/admin/themes/${id}`)).statusCode).toBe(409);
    }
    await admin.post('/api/admin/themes', doc('themes', { definition: custom('ocean') }));
    const renamed = await admin.patch('/api/admin/themes/ocean', doc('themes', { definition: custom('sea') }, { id: 'ocean' }));
    expect(renamed.statusCode).toBe(400);
  });

  it('refuses to activate a theme that fails AA unless the admin confirms', async () => {
    await admin.post('/api/admin/themes', doc('themes', { definition: failing('pale') }));
    const listed = (await themes()).find((x) => x.id === 'pale')!;
    expect(listed.contrastFailures.some((f) => f.foreground === 'muted' && f.mode === 'light')).toBe(true);

    const refused = await admin.post('/api/admin/themes/pale/activate', doc('themes', {}));
    expect(refused.statusCode).toBe(409);
    expect(errors(refused)[0]).toMatchObject({ code: 'contrast_failures' });
    expect((errors(refused)[0]!.meta as { failures: unknown[] }).failures.length).toBe(listed.contrastFailures.length);
    expect((await t.app.ctx.themes.selection()).themeId).toBe('default');

    const accepted = await admin.post('/api/admin/themes/pale/activate', doc('themes', { acceptContrastFailures: true }));
    expect(accepted.statusCode).toBe(200);
    expect(await t.app.ctx.themes.selection()).toEqual({ themeId: 'pale', contrastAccepted: true });
    const audit = await t.db.selectFrom('audit_log').select('details').where('action', '=', 'theme.activate').executeTakeFirstOrThrow();
    expect(JSON.parse(audit.details!)).toMatchObject({ previous: 'default', contrastFailuresAccepted: listed.contrastFailures.length });

    // Active: cannot be deleted; an edit that still fails needs the confirmation again.
    expect((await admin.delete('/api/admin/themes/pale')).statusCode).toBe(409);
    expect((await admin.patch('/api/admin/themes/pale', doc('themes', { css: 'a{}' }, { id: 'pale' }))).statusCode).toBe(409);
    const fixed = await admin.patch('/api/admin/themes/pale', doc('themes', { definition: custom('pale') }, { id: 'pale' }));
    expect(fixed.statusCode).toBe(200);
    expect(await t.app.ctx.themes.selection()).toEqual({ themeId: 'pale', contrastAccepted: false });

    // A passing theme is activated at once.
    expect((await admin.post('/api/admin/themes/forest/activate', doc('themes', {}))).statusCode).toBe(200);
    expect((await t.app.ctx.themes.selection()).themeId).toBe('forest');
    expect((await admin.post('/api/admin/themes/missing/activate', doc('themes', {}))).statusCode).toBe(404);
  });

  it('flags and logs an active folder theme whose file was changed to fail AA', async () => {
    expect((await admin.post('/api/admin/themes/folder-theme/activate', doc('themes', {}))).statusCode).toBe(200);
    // The file changes, then the server restarts (the folder is read once).
    writeFileSync(join(dir, 'folder-theme.json'), JSON.stringify(failing('folder-theme')));
    const logger = log();
    const restarted = new ThemeService(t.db, dir, logger);
    const active = await restarted.active();
    expect(active.entry.id).toBe('folder-theme');
    expect(active.contrastAccepted).toBe(false);
    expect(active.unconfirmedContrastFailures).toBeGreaterThan(0);
    const warnings = () => logger.warn.mock.calls.filter(([, msg]) => String(msg).includes('fails WCAG 2.2 AA'));
    expect(warnings()).toHaveLength(1);
    // The count only, never the CSS or the theme file.
    expect(warnings()[0]![0]).toEqual({ theme: 'folder-theme', source: 'folder', contrastFailures: active.unconfirmedContrastFailures });
    // Once per theme and tokens, not on every page render.
    restarted.invalidate();
    await restarted.active();
    expect(warnings()).toHaveLength(1);
  });

  it('flags the active theme when the accent setting makes it fail AA until an admin confirms', async () => {
    expect((await admin.patch('/api/admin/settings', { accentColor: '#ffff00' })).statusCode).toBe(200);
    const flagged = (await themes()).find((x) => x.active)!;
    expect(flagged.id).toBe('default');
    expect(flagged.contrastFailures.length).toBeGreaterThan(0);
    expect(flagged.contrastUnconfirmed).toBe(true);
    expect((await themes()).filter((x) => x.contrastUnconfirmed)).toHaveLength(1);

    // Activating it again with the confirmation records it.
    const confirmed = await admin.post('/api/admin/themes/default/activate', doc('themes', { acceptContrastFailures: true }));
    expect(confirmed.statusCode).toBe(200);
    expect(data<AdminTheme>(confirmed).contrastUnconfirmed).toBe(false);
    expect(await t.app.ctx.themes.selection()).toEqual({ themeId: 'default', contrastAccepted: true });
    expect((await t.app.ctx.themes.active()).unconfirmedContrastFailures).toBe(0);
  });

  it('logs and deletes an uploaded theme that a later folder theme hides', async () => {
    // Uploaded first; then a folder file with the same id appears.
    const now = new Date().toISOString();
    await t.db
      .insertInto('themes')
      .values({ id: 'folder-theme', name: 'Old upload', definition: JSON.stringify(custom('folder-theme')), css: null, created_by: null, created_at: now, updated_at: now })
      .execute();
    expect((await themes()).filter((x) => x.id === 'folder-theme').map((x) => x.source)).toEqual(['folder']);
    expect(await t.app.ctx.themes.shadowedIds()).toEqual(['folder-theme']);
    const logger = log();
    await new ThemeService(t.db, dir, logger).logShadowed();
    expect(logger.warn).toHaveBeenCalledWith({ themes: ['folder-theme'] }, expect.stringContaining('uploadedCopy=true'));

    const refused = await admin.delete('/api/admin/themes/folder-theme');
    expect(refused.statusCode).toBe(409);
    expect(errors(refused)[0]!.detail).toContain('uploadedCopy=true');
    expect((await admin.delete('/api/admin/themes/folder-theme?uploadedCopy=true')).statusCode).toBe(204);
    expect(await t.db.selectFrom('themes').select('id').execute()).toEqual([]);
    expect((await themes()).find((x) => x.id === 'folder-theme')?.source).toBe('folder');
    expect((await admin.delete('/api/admin/themes/folder-theme?uploadedCopy=true')).statusCode).toBe(404);
    expect((await admin.delete('/api/admin/themes/forest?uploadedCopy=true')).statusCode).toBe(404);
    expect((await admin.delete('/api/admin/themes/folder-theme?uploadedCopy=yes')).statusCode).toBe(400);
    const audit = await t.db.selectFrom('audit_log').select('details').where('action', '=', 'theme.delete').executeTakeFirstOrThrow();
    expect(JSON.parse(audit.details!)).toMatchObject({ name: 'Theme folder-theme', uploadedCopy: true });

    // An uploaded theme that is not hidden keeps the usual rules: the active one stays.
    await admin.post('/api/admin/themes', doc('themes', { definition: custom('ocean') }));
    await admin.post('/api/admin/themes/ocean/activate', doc('themes', {}));
    expect((await admin.delete('/api/admin/themes/ocean?uploadedCopy=true')).statusCode).toBe(409);
  });

  it('is for admins only', async () => {
    await createUser(t.db, { email: 'editor@example.com', role: 'editor' });
    const editor = client(t.app, { cookie: await login(t.app, 'editor@example.com') });
    expect((await editor.get('/api/admin/themes')).statusCode).toBe(403);
    expect((await editor.post('/api/admin/themes/forest/activate', doc('themes', {}))).statusCode).toBe(403);
    expect((await editor.get('/api/admin/themes/forest/export')).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/themes' })).statusCode).toBe(401);
  });

  it('reports the uploads a theme uses', async () => {
    await admin.post('/api/admin/themes', doc('themes', { definition: custom('ocean'), css: `header{background:url(/uploads/${hash}.png)}` }));
    const { uploadReferences } = await import('../src/services/uploads.js');
    expect(await uploadReferences(t.db, `/uploads/${hash}.png`, {})).toEqual(['theme ocean']);
  });

  it('keeps an upload that the CSS of a folder theme uses', async () => {
    const url = `/uploads/${hash}.png`;
    writeFileSync(join(dir, 'pictured.json'), JSON.stringify(custom('pictured')));
    writeFileSync(join(dir, 'pictured.css'), `header{background:url(${url})}`);
    const { uploadReferences } = await import('../src/services/uploads.js');
    const folder = loadThemeFolder(dir, log());
    expect(await uploadReferences(t.db, url, {}, folder.values())).toEqual(['theme pictured (themes folder)']);
    expect(await uploadReferences(t.db, `/uploads/${'d'.repeat(64)}.png`, {}, folder.values())).toEqual([]);
  });
});

describe('theme stylesheets and server-rendered pages', () => {
  let web: ReturnType<typeof createWebDir>;
  beforeAll(() => {
    web = createWebDir();
  });
  afterAll(() => web.remove());

  let t: TestApp;
  let cookie: string;
  let admin: Client;
  beforeEach(async () => {
    t = await createTestApp({}, { web: { dir: web.dir, ssrModule: renderFromSource } });
    await createUser(t.db, { email: 'admin@example.com', role: 'admin' });
    cookie = await login(t.app, 'admin@example.com');
    admin = client(t.app, { cookie });
  });
  afterEach(() => t.close());

  const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers });
  const links = (body: string) => [...body.matchAll(/<link rel="stylesheet" href="(\/theme\/[0-9a-f]{20}\.css)" data-osp-theme>/g)].map((m) => m[1]!);

  it('links the active theme as hashed, immutable, same-origin stylesheets and never inlines it', async () => {
    const res = await get('/');
    expect(res.statusCode).toBe(200);
    const [tokens] = links(res.body);
    expect(tokens).toBeTruthy();
    // After the app's stylesheet, inside <head>, and no <style> element at all (CSP).
    expect(res.body.indexOf(tokens!)).toBeGreaterThan(res.body.indexOf('/assets/shared.css'));
    expect(res.body.indexOf(tokens!)).toBeLessThan(res.body.indexOf('</head>'));
    expect(res.body).not.toContain('<style');

    const css = await get(tokens!);
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(css.headers['x-content-type-options']).toBe('nosniff');
    expect(css.body).toBe(themeTokensCss(BUILTIN_THEMES[0]!));
    expect((await get(tokens!, { 'if-none-match': css.headers.etag as string })).statusCode).toBe(304);
    expect((await get('/theme/0123456789abcdef0123.css')).statusCode).toBe(404);
    expect((await get('/theme/x.css')).statusCode).toBe(404);

    // The public settings tell a page rendered in the browser the same stylesheets and the accent in effect.
    const settings = (await get('/api/public/settings')).json().data.attributes;
    expect(settings.theme).toEqual({ id: 'default', stylesheets: [tokens] });
    expect(settings.accentColor).toBe('#7c6cf2');
  });

  it('switches to the activated theme with its extra CSS as a second stylesheet', async () => {
    const css = '.osp-group { letter-spacing: 0.01em; }';
    await admin.post('/api/admin/themes', doc('themes', { definition: custom('ocean'), css }));
    await admin.post('/api/admin/themes/ocean/activate', doc('themes', {}));
    const sheets = links((await get('/services')).body);
    expect(sheets).toHaveLength(2);
    expect((await get(sheets[0]!)).body).toContain('--bg:#f8fafc');
    expect((await get(sheets[1]!)).body).toBe(css);
    const settings = (await get('/api/public/settings')).json().data.attributes;
    expect(settings).toMatchObject({ theme: { id: 'ocean', stylesheets: sheets }, accentColor: '#2563eb' });
  });

  it('keeps an accent override of the settings in the theme stylesheet', async () => {
    await admin.patch('/api/admin/settings', { accentColor: '#0f766e' });
    const [tokens] = links((await get('/')).body);
    expect((await get(tokens!)).body).toBe(themeTokensCss(BUILTIN_THEMES[0]!, '#0f766e'));
    expect((await get('/api/public/settings')).json().data.attributes.accentColor).toBe('#0f766e');
    // Removing it brings the theme's accent back.
    await admin.patch('/api/admin/settings', { accentColor: null });
    expect((await get('/api/public/settings')).json().data.attributes.accentColor).toBe('#7c6cf2');
  });

  it('previews a theme only for signed-in admins, never cached and never for anonymous visitors', async () => {
    const active = links((await get('/')).body);

    const anonymous = await get('/?theme=forest');
    expect(links(anonymous.body)).toEqual(active);
    expect(anonymous.headers['cache-control']).toMatch(/^public/);

    const preview = await get('/?theme=forest', { cookie });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['cache-control']).toBe('private, no-store');
    const sheets = links(preview.body);
    expect(sheets).not.toEqual(active);
    const sheet = await get(sheets[0]!, { cookie });
    expect(sheet.statusCode).toBe(200);
    expect(sheet.headers['cache-control']).toBe('private, no-store');
    expect(sheet.body).toBe(themeTokensCss(BUILTIN_THEMES.find((x) => x.id === 'forest')!));
    // The preview stylesheet is not public.
    expect((await get(sheets[0]!)).statusCode).toBe(404);

    // Editors, unknown themes and malformed ids get the usual page.
    await createUser(t.db, { email: 'editor@example.com', role: 'editor' });
    const editorCookie = await login(t.app, 'editor@example.com');
    expect(links((await get('/?theme=forest', { cookie: editorCookie })).body)).toEqual(active);
    expect(links((await get('/?theme=missing', { cookie })).body)).toEqual(active);
    expect(links((await get('/?theme=..%2Fx', { cookie })).body)).toEqual(active);
  });

  it('falls back to the default theme when the active one is gone', async () => {
    await t.db.updateTable('active_theme').set({ theme_id: 'vanished' }).execute();
    t.app.ctx.themes.invalidate();
    const [tokens] = links((await get('/')).body);
    expect((await get(tokens!)).body).toBe(themeTokensCss(BUILTIN_THEMES[0]!));
  });
});

describe('theme stylesheets on a public instance', () => {
  let web: ReturnType<typeof createWebDir>;
  beforeAll(() => {
    web = createWebDir();
  });
  afterAll(() => web.remove());

  it('serves the active theme and ignores ?theme=', async () => {
    const t = await createTestApp({ APP_ROLE: 'public' }, { web: { dir: web.dir, ssrModule: renderFromSource } });
    try {
      const res = await t.app.inject({ method: 'GET', url: '/?theme=forest', headers: { cookie: 'osp_session=whatever' } });
      expect(res.statusCode).toBe(200);
      const [tokens] = links(res.body);
      expect((await t.app.inject({ method: 'GET', url: tokens! })).body).toBe(themeTokensCss(BUILTIN_THEMES[0]!));
    } finally {
      await t.close();
    }
  });

  const links = (body: string) => [...body.matchAll(/<link rel="stylesheet" href="(\/theme\/[0-9a-f]{20}\.css)" data-osp-theme>/g)].map((m) => m[1]!);
});

describe('migration 0017', () => {
  it('drops the old default accent, keeps a chosen one and starts with the default theme', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', SECRET_KEY: 'x'.repeat(40), BASE_URL: 'https://status.example.com' });
    for (const [accent, expected] of [
      ['#7c6cf2', undefined],
      ['#0F766E', '#0F766E'],
    ] as const) {
      const db = await createDb(config);
      try {
        const { Migrator } = await import('kysely/migration');
        const { migrations } = await import('../src/db/migrations/index.js');
        const before = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < '0017'));
        await new Migrator({ db, provider: { getMigrations: async () => before } }).migrateToLatest();
        await db.insertInto('settings').values({ key: 'page', value: JSON.stringify({ siteName: 'Example', accentColor: accent }), updated_at: '2026-01-01T00:00:00.000Z' }).execute();
        await migrateToLatest(db);
        const value = JSON.parse((await db.selectFrom('settings').select('value').where('key', '=', 'page').executeTakeFirstOrThrow()).value);
        expect(value.accentColor).toBe(expected);
        expect(value.siteName).toBe('Example');
        const active = await sql<{ theme_id: string }>`select theme_id from active_theme where slot = 'active'`.execute(db);
        expect(active.rows).toEqual([{ theme_id: 'default' }]);
      } finally {
        await db.destroy();
      }
    }
  });
});

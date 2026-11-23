/**
 * Content pages, uploaded images and the instance facts of the management API
 * (migration 0014_site_pages_uploads, routes/admin/content.ts, routes/uploads.ts).
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UPLOAD_CSP } from '../src/routes/uploads.js';
import { appVersion } from '../src/lib/version.js';
import { adminClient, client, createTestApp, createUser, data, errors, login, type Client, type TestApp } from './helpers.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let t: TestApp;
let admin: Client;

/** A small PNG header (signature + IHDR) of the given size. */
export function pngBytes(width: number, height: number, extra = 0): Buffer {
  const b = Buffer.alloc(45 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const upload = (bytes: Buffer, contentType = 'application/octet-stream', url = '/api/admin/uploads?fileName=logo.png', cookie?: string) =>
  t.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': contentType, ...(cookie ? { cookie, 'x-requested-with': 'openstatuspage' } : {}) },
    payload: bytes,
  });

let cookie: string;

beforeEach(async () => {
  t = await createTestApp();
  admin = await adminClient(t);
  cookie = await login(t.app, 'admin@example.com');
});
afterEach(async () => {
  await t.close();
});

describe('content pages (admin)', () => {
  it('has the four system pages, unpublished', async () => {
    const res = await admin.get('/api/admin/pages');
    expect(res.statusCode).toBe(200);
    const pages = data<Any[]>(res);
    expect(pages.map((p) => [p.systemKey, p.path, p.published])).toEqual([
      ['about', '/about', false],
      ['legal-notice', '/legal-notice', false],
      ['privacy', '/privacy', false],
      ['accessibility', '/accessibility', false],
    ]);
    expect(pages[1].title).toEqual({ en: 'Legal notice', de: 'Impressum' });
  });

  it('creates, updates and deletes a custom page; slugs are unique, system pages stay', async () => {
    const res = await admin.post('/api/admin/pages', { slug: 'faq', title: { en: 'FAQ', de: 'Häufige Fragen' }, body: { en: '# Hi', de: '' } });
    expect(res.statusCode, res.body).toBe(201);
    const page = data<Any>(res);
    expect(page).toMatchObject({ slug: 'faq', path: '/pages/faq', systemKey: null, published: false, showInFooter: true });

    expect((await admin.post('/api/admin/pages', { slug: 'faq', title: { en: 'Again', de: '' } })).statusCode).toBe(409);
    // The slugs of the system pages are taken too.
    expect((await admin.post('/api/admin/pages', { slug: 'privacy', title: { en: 'x', de: '' } })).statusCode).toBe(409);
    expect((await admin.post('/api/admin/pages', { slug: 'Bad Slug', title: { en: 'x', de: '' } })).statusCode).toBe(400);

    const patched = await admin.patch(`/api/admin/pages/${page.id}`, { published: true, showInNav: true });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(data<Any>(patched)).toMatchObject({ published: true, showInNav: true, title: { en: 'FAQ' } });
    // Localized fields merge per language.
    const oneLanguage = await admin.patch(`/api/admin/pages/${page.id}`, { title: { en: 'Questions' }, body: { de: '# Hallo' } });
    expect(oneLanguage.statusCode, oneLanguage.body).toBe(200);
    expect(data<Any>(oneLanguage)).toMatchObject({ title: { en: 'Questions', de: 'Häufige Fragen' }, body: { en: '# Hi', de: '# Hallo' } });
    expect((await admin.patch(`/api/admin/pages/${page.id}`, { title: 'plain' })).statusCode).toBe(400);

    expect((await admin.delete(`/api/admin/pages/${page.id}`)).statusCode).toBe(204);
    const system = data<Any[]>(await admin.get('/api/admin/pages'))[0];
    expect((await admin.delete(`/api/admin/pages/${system.id}`)).statusCode).toBe(409);
    // A system page keeps its slug and place.
    const sys = await admin.patch(`/api/admin/pages/${system.id}`, { slug: 'elsewhere', showInFooter: true, published: true, body: { en: 'Hello', de: 'Hallo' } });
    expect(sys.statusCode, sys.body).toBe(200);
    expect(data<Any>(sys)).toMatchObject({ slug: 'about', path: '/about', published: true, body: { en: 'Hello', de: 'Hallo' } });
  });

  it('is for admins only', async () => {
    await createUser(t.db, { email: 'editor@example.com', role: 'editor' });
    const editor = client(t.app, { cookie: await login(t.app, 'editor@example.com') });
    expect((await editor.get('/api/admin/pages')).statusCode).toBe(403);
    expect((await editor.post('/api/admin/pages', { slug: 'x', title: { en: 'x', de: '' } })).statusCode).toBe(403);
    expect((await editor.get('/api/admin/uploads')).statusCode).toBe(403);
  });
});

describe('content pages (public)', () => {
  it('serves only published pages, with their links in the settings document', async () => {
    const pages = data<Any[]>(await admin.get('/api/admin/pages'));
    const legal = pages.find((p) => p.systemKey === 'legal-notice');
    expect((await t.app.inject('/api/public/pages/legal-notice')).statusCode).toBe(404);
    let settings = data<Any>(await t.app.inject('/api/public/settings'));
    expect(settings.pages).toEqual([]);

    await admin.patch(`/api/admin/pages/${legal.id}`, { published: true, body: { en: 'Example Ltd.', de: 'Beispiel GmbH' } });
    const res = await t.app.inject('/api/public/pages/legal-notice');
    expect(res.statusCode).toBe(200);
    const page = data<Any>(res);
    expect(page).toMatchObject({ systemKey: 'legal-notice', path: '/legal-notice', body: { en: 'Example Ltd.', de: 'Beispiel GmbH' } });
    expect(res.body).not.toContain('created_by');
    settings = data<Any>(await t.app.inject('/api/public/settings'));
    expect(settings.pages).toEqual([
      expect.objectContaining({ systemKey: 'legal-notice', path: '/legal-notice', title: { en: 'Legal notice', de: 'Impressum' } }),
    ]);
    expect(settings.pages[0]).not.toHaveProperty('body');
  });

  it('are in the sitemap and in llms.txt once published', async () => {
    const created = data<Any>(await admin.post('/api/admin/pages', { slug: 'faq', title: { en: 'FAQ', de: '' }, published: true }));
    const sitemap = (await t.app.inject('/sitemap-pages.xml')).body;
    expect(sitemap).toContain('<loc>https://status.example.com/pages/faq</loc>');
    expect(sitemap).not.toContain('/legal-notice');
    expect((await t.app.inject('/llms.txt')).body).toContain('[FAQ](https://status.example.com/pages/faq)');
    await admin.patch(`/api/admin/pages/${created.id}`, { published: false });
    expect((await t.app.inject('/sitemap-pages.xml')).body).not.toContain('/pages/faq');
  });
});

describe('uploads', () => {
  it('stores an image by its magic bytes and serves it immutable, with nosniff and a restrictive CSP', async () => {
    const bytes = pngBytes(120, 40);
    const res = await upload(bytes, 'application/octet-stream', '/api/admin/uploads?fileName=../../logo%0a.png', cookie);
    expect(res.statusCode, res.body).toBe(201);
    const stored = data<Any>(res);
    const hash = createHash('sha256').update(bytes).digest('hex');
    expect(stored).toMatchObject({ url: `/uploads/${hash}.png`, contentType: 'image/png', width: 120, height: 40, size: bytes.length, filename: 'logo.png' });

    // The same bytes again: the same upload.
    const again = await upload(bytes, 'application/octet-stream', '/api/admin/uploads', cookie);
    expect(again.statusCode).toBe(200);
    expect(data<Any>(again).id).toBe(stored.id);

    const file = await t.app.inject(stored.url);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-disposition']).toBe(`inline; filename="${hash}.png"`);
    expect(file.headers['content-security-policy']).toBe(UPLOAD_CSP);
    expect(file.rawPayload.equals(bytes)).toBe(true);
    const cached = await t.app.inject({ url: stored.url, headers: { 'if-none-match': `"${hash}"` } });
    expect(cached.statusCode).toBe(304);
    expect(cached.rawPayload.length).toBe(0);
    expect(cached.headers.etag).toBe(`"${hash}"`);
    const stale = await t.app.inject({ url: stored.url, headers: { 'if-none-match': `"${'0'.repeat(64)}"` } });
    expect(stale.statusCode).toBe(200);
    expect(stale.rawPayload.equals(bytes)).toBe(true);

    // Wrong extension, unknown hash, other spellings: 404.
    for (const url of [`/uploads/${hash}.jpg`, `/uploads/${'0'.repeat(64)}.png`, `/uploads/${hash.toUpperCase()}.png`, `/uploads/${hash}.svg`]) {
      expect((await t.app.inject(url)).statusCode, url).toBe(404);
    }
  });

  it('rejects SVG, HTML, empty and oversized files whatever their declared type or name', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
    expect((await upload(svg, 'application/octet-stream', '/api/admin/uploads?fileName=logo.png', cookie)).statusCode).toBe(415);
    expect((await upload(Buffer.from('<html><script>x</script>'), 'application/octet-stream', '/api/admin/uploads', cookie)).statusCode).toBe(415);
    expect((await upload(Buffer.alloc(0), 'application/octet-stream', '/api/admin/uploads', cookie)).statusCode).toBe(400);
    expect((await upload(pngBytes(10, 10, 1024 * 1024), 'application/octet-stream', '/api/admin/uploads', cookie)).statusCode).toBe(413);
    // Other request types are not accepted at all (no form posts).
    expect((await upload(pngBytes(10, 10), 'image/png', '/api/admin/uploads', cookie)).statusCode).toBe(415);
    expect((await upload(pngBytes(10, 10), 'text/plain', '/api/admin/uploads', cookie)).statusCode).toBe(415);
    expect(await t.db.selectFrom('uploads').select('id').execute()).toEqual([]);
  });

  it('needs a session with the CSRF header', async () => {
    expect((await upload(pngBytes(10, 10))).statusCode).toBe(401);
    const noCsrf = await t.app.inject({
      method: 'POST',
      url: '/api/admin/uploads',
      headers: { 'content-type': 'application/octet-stream', cookie },
      payload: pngBytes(10, 10),
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('gives an uploaded logo its size in the public settings', async () => {
    const stored = data<Any>(await upload(pngBytes(200, 50), 'application/octet-stream', '/api/admin/uploads', cookie));
    await admin.patch('/api/admin/settings', { logoUrl: stored.url, faviconUrl: stored.url });
    const settings = data<Any>(await t.app.inject('/api/public/settings'));
    expect(settings.logoUrl).toBe(stored.url);
    expect(settings.logoSize).toEqual({ width: 200, height: 50 });

    // A page that shows the image gets its size.
    const pages = data<Any[]>(await admin.get('/api/admin/pages'));
    await admin.patch(`/api/admin/pages/${pages[0].id}`, { published: true, body: { en: `![Logo](${stored.url})`, de: '' } });
    expect(data<Any>(await t.app.inject('/api/public/pages/about')).images).toEqual({ [stored.url]: { width: 200, height: 50 } });

    // In use by the logo, the favicon and the about page: not deleted.
    const inUse = await admin.delete(`/api/admin/uploads/${stored.id}`);
    expect(inUse.statusCode).toBe(409);
    expect(errors(inUse)[0]?.detail).toContain('logo, favicon, page about');
    await admin.patch('/api/admin/settings', { logoUrl: null, faviconUrl: `https://status.example.com${stored.url}` });
    expect(errors(await admin.delete(`/api/admin/uploads/${stored.id}`))[0]?.detail).toContain('(favicon, page about)');
    await admin.patch('/api/admin/settings', { faviconUrl: null });
    expect((await admin.delete(`/api/admin/uploads/${stored.id}`)).statusCode).toBe(409);
    await admin.patch(`/api/admin/pages/${pages[0].id}`, { body: { en: 'No image', de: '' } });

    expect((await admin.delete(`/api/admin/uploads/${stored.id}`)).statusCode).toBe(204);
    expect((await t.app.inject(stored.url)).statusCode).toBe(404);
  });
});

describe('instance', () => {
  it('shows the version to signed-in users only', async () => {
    const res = await admin.get('/api/admin/instance');
    expect(res.statusCode).toBe(200);
    expect(data<Any>(res).version).toBe(appVersion());
    expect(appVersion()).toMatch(/^\d+\.\d+\.\d+/);
    const anonymous = await t.app.inject('/api/admin/instance');
    expect(anonymous.statusCode).toBe(401);
    expect(errors(anonymous)[0]?.status).toBe('401');
    // Never in the public documents.
    expect((await t.app.inject('/api/public/settings')).body).not.toContain(appVersion());
  });
});

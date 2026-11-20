/**
 * Visitor preferences without JavaScript: the theme form and the language links
 * set their cookie and send the visitor back (Post/Redirect/Get); other sites
 * cannot set them, and the way back never leaves the site.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localPath } from '../src/forms/http.js';
import { createTestApp, type TestApp } from './helpers.js';
import { createWebDir, renderFromSource } from './web-fixture.js';

let web: ReturnType<typeof createWebDir>;
beforeAll(() => {
  web = createWebDir();
});
afterAll(() => web.remove());

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp({}, { web: { dir: web.dir, ssrModule: renderFromSource } });
});
afterEach(() => t.close());

const FORM = 'application/x-www-form-urlencoded';
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

const postTheme = (body: string, headers: Record<string, string> = SAME_ORIGIN) =>
  t.app.inject({ method: 'POST', url: '/preferences/theme', headers: { 'content-type': FORM, ...headers }, payload: body });

describe('POST /preferences/theme', () => {
  it('sets the theme cookie and redirects back (303)', async () => {
    const res = await postTheme('theme=dark&return=%2Fhistory%3Ftype%3Dincident');
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/history?type=incident');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(String(res.headers['set-cookie'])).toMatch(/^osp-theme=dark; Path=\/; Max-Age=\d+; SameSite=Lax$/);
  });

  it('marks the cookie Secure behind HTTPS', async () => {
    const res = await postTheme('theme=light&return=/', { ...SAME_ORIGIN, 'x-forwarded-proto': 'https' });
    // TRUST_PROXY is off in tests: the connection itself decides.
    expect(String(res.headers['set-cookie'])).not.toContain('Secure');
  });

  it('ignores unknown themes but still redirects', async () => {
    const res = await postTheme('theme=neon&return=/services');
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/services');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('never redirects to another site', async () => {
    for (const back of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      const res = await postTheme(`theme=dark&return=${encodeURIComponent(back)}`);
      expect(res.headers.location, back).toBe('/');
    }
  });

  it('rejects posts from other sites', async () => {
    for (const headers of <Record<string, string>[]>[
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { origin: 'https://evil.example' },
      { origin: 'null' },
    ]) {
      const res = await postTheme('theme=dark&return=/', headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['content-type']).toContain('text/html');
    }
  });

  it('accepts the own origin and the origin of PUBLIC_BASE_URL', async () => {
    expect((await postTheme('theme=dark&return=/', { origin: 'http://localhost:80' })).statusCode).toBe(303);
    expect((await postTheme('theme=dark&return=/', { origin: 'https://status.example.com' })).statusCode).toBe(303);
    // No browser metadata at all (curl, scripts): nothing a page could forge.
    expect((await postTheme('theme=dark&return=/', {})).statusCode).toBe(303);
  });
});

describe('GET /preferences/language', () => {
  const get = (url: string, headers: Record<string, string> = SAME_ORIGIN) => t.app.inject({ method: 'GET', url, headers });

  it('sets the language cookie and redirects back, marked noindex', async () => {
    const res = await get('/preferences/language?lang=de&return=%2Fservices');
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/services');
    expect(String(res.headers['set-cookie'])).toMatch(/^osp-lang=de; Path=\/;/);
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('ignores unknown languages and links from other sites', async () => {
    expect((await get('/preferences/language?lang=xx&return=/')).headers['set-cookie']).toBeUndefined();
    const cross = await get('/preferences/language?lang=de&return=/', { 'sec-fetch-site': 'cross-site' });
    expect(cross.statusCode).toBe(303);
    expect(cross.headers['set-cookie']).toBeUndefined();
  });

  it('the next page is rendered in the chosen language', async () => {
    const res = await get('/preferences/language?lang=de&return=/');
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    const page = await get('/', { cookie });
    expect(page.body).toContain('<html lang="de"');
  });
});

describe('localPath', () => {
  it('keeps paths of this site only', () => {
    expect(localPath('/history?type=incident#x')).toBe('/history?type=incident#x');
    expect(localPath(undefined)).toBe('/');
    expect(localPath('relative')).toBe('/');
    expect(localPath('/ok\nSet-Cookie: x')).toBe('/');
    expect(localPath(`/${'a'.repeat(3000)}`)).toBe('/');
  });
});

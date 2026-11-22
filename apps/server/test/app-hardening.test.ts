import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, redactUrlTokens } from '../src/app.js';
import { configWarnings, loadConfig } from '../src/config.js';
import { createDb, migrateToLatest } from '../src/db/index.js';
import { RATE_LIMIT_KEYS } from '../src/routes/index.js';
import { createTestApp } from './helpers.js';

describe('rate limits', () => {
  it('bound the clients every rate-limited route remembers', async () => {
    const limits: { url: string; config: Record<string, unknown> }[] = [];
    const t = await createTestApp(
      {},
      {
        onRoute: (route) => {
          const limit = (route.config as { rateLimit?: Record<string, unknown> } | undefined)?.rateLimit;
          if (limit) limits.push({ url: route.url, config: limit });
        },
      },
    );
    try {
      expect(limits.length).toBeGreaterThan(3);
      for (const { url, config } of limits) expect(config.cache, url).toBe(RATE_LIMIT_KEYS);
    } finally {
      await t.close();
    }
  });
});

describe('loadConfig', () => {
  it('requires SECRET_KEY in production but not for development', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/SECRET_KEY/);
    expect(() => loadConfig({})).toThrow(/SECRET_KEY/);
    expect(loadConfig({ NODE_ENV: 'development' }).insecureSecret).toBe(true);
    expect(loadConfig({}, { allowMissingSecret: true }).insecureSecret).toBe(true);
    expect(loadConfig({ SECRET_KEY: 'x'.repeat(32) }).insecureSecret).toBe(false);
  });

  it('refuses published example secrets in production', () => {
    for (const value of ['change-me-to-a-long-random-value', 'insecure-development-secret-change-me-please']) {
      expect(() => loadConfig({ NODE_ENV: 'production', SECRET_KEY: value })).toThrow(/SECRET_KEY: is a published example value/);
      expect(() => loadConfig({ NODE_ENV: 'production', SECRET_KEY: 'x'.repeat(32), SUBSCRIPTION_TOKEN_KEY: value })).toThrow(
        /SUBSCRIPTION_TOKEN_KEY: is a published example value/,
      );
      // Development and test setups, and CLI commands that never use the secret, still accept them.
      expect(loadConfig({ NODE_ENV: 'development', SECRET_KEY: value }).SECRET_KEY).toBe(value);
      expect(loadConfig({ NODE_ENV: 'production', SECRET_KEY: value }, { allowMissingSecret: true }).SECRET_KEY).toBe(value);
    }
    expect(loadConfig({ NODE_ENV: 'production', SECRET_KEY: 'x'.repeat(32) }).insecureSecret).toBe(false);
  });

  it('warns in production when BASE_URL is plain http for a public host', () => {
    const warnings = (env: Record<string, string>) =>
      configWarnings(loadConfig({ NODE_ENV: 'production', SECRET_KEY: 'x'.repeat(32), ...env }));
    expect(warnings({ BASE_URL: 'http://status.example.com' })).toEqual([expect.stringMatching(/without the Secure flag/)]);
    expect(warnings({ BASE_URL: 'https://status.example.com' })).toEqual([]);
    expect(warnings({ BASE_URL: 'http://localhost:3000' })).toEqual([]);
    expect(warnings({})).toEqual([]);
    expect(configWarnings(loadConfig({ NODE_ENV: 'test', BASE_URL: 'http://status.example.com' }))).toEqual([]);
  });

  it('warns when TRUST_PROXY trusts hops by position only', () => {
    const warnings = (env: Record<string, string>) => configWarnings(loadConfig({ NODE_ENV: 'test', ...env }));
    expect(warnings({ TRUST_PROXY: 'true' })).toEqual([expect.stringMatching(/TRUST_PROXY=1 trusts the nearest hop/)]);
    expect(warnings({ TRUST_PROXY: '2' })).toHaveLength(1);
    expect(warnings({ TRUST_PROXY: '10.0.0.0/8' })).toEqual([]);
    expect(warnings({})).toEqual([]);
  });

  it('treats empty values as unset', () => {
    expect(loadConfig({ NODE_ENV: 'test', SECRET_KEY: '' }).insecureSecret).toBe(true);
  });

  it('parses TRUST_PROXY as boolean, hop count or address list', () => {
    const parse = (v: string) => loadConfig({ NODE_ENV: 'test', TRUST_PROXY: v }).TRUST_PROXY;
    expect(parse('false')).toBe(false);
    expect(parse('true')).toBe(1);
    expect(parse('2')).toBe(2);
    expect(parse('10.0.0.0/8, 127.0.0.1')).toEqual(['10.0.0.0/8', '127.0.0.1']);
    expect(() => parse('everything')).toThrow(/TRUST_PROXY/);
  });

  it('does not auto-create OIDC users by default', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).OIDC_AUTO_CREATE_USERS).toBe(false);
  });
});

describe('http hardening', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'osp-web-'));
    mkdirSync(join(webDir, 'assets'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>t</title>');
    writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)');
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', WEB_DIST_DIR: webDir, TRUST_PROXY: '1' });
    const db = await createDb(config);
    await migrateToLatest(db);
    app = await buildApp({ config, db });
    app.get('/__ip', async (req) => ({ ip: req.ip }));
  });
  afterAll(async () => {
    await app?.close();
  });

  it('serves the SPA for client routes on GET and HEAD', async () => {
    for (const method of ['GET', 'HEAD'] as const) {
      const res = await app.inject({ method, url: '/services/foo' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    }
  });

  it('returns 404 for missing assets and API paths', async () => {
    expect((await app.inject({ url: '/assets/missing.js' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/assets/app.js' })).statusCode).toBe(200);
    for (const url of ['/api', '/api?x=1', '/api/nope']) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toBe('application/vnd.api+json');
      expect(res.json().errors[0]).toMatchObject({ status: '404', code: 'not_found' });
    }
  });

  it('sets security headers and denies framing of the admin UI only', async () => {
    const admin = await app.inject({ url: '/admin/login' });
    expect(admin.headers['x-content-type-options']).toBe('nosniff');
    expect(admin.headers['x-frame-options']).toBe('DENY');
    const pub = await app.inject({ url: '/' });
    expect(pub.headers['x-content-type-options']).toBe('nosniff');
    expect(pub.headers['x-frame-options']).toBeUndefined();
  });

  it('sends a strict content security policy with every page', async () => {
    const pub = await app.inject({ url: '/' });
    const csp = String(pub.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
    // The public page may be embedded by other sites.
    expect(csp).not.toContain('frame-ancestors');
    expect(pub.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(pub.headers['permissions-policy']).toContain('camera=()');

    const admin = await app.inject({ url: '/admin/login' });
    expect(admin.headers['content-security-policy']).toBe(`${csp}; frame-ancestors 'none'`);

    // Other responses only deny framing where it applies.
    const api = await app.inject({ url: '/api/public/settings' });
    expect(api.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(api.headers['cross-origin-opener-policy']).toBeUndefined();
  });

  it('denies framing of case-variant and percent-encoded admin paths', async () => {
    // The SPA fallback serves these, and the client router would match /admin.
    for (const url of ['/ADMIN/x', '/Admin', '/%61dmin/x', '/%41DMIN/x?a=1', '//admin/x']) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['x-frame-options'], url).toBe('DENY');
      expect(res.headers['content-security-policy'], url).toContain("frame-ancestors 'none'");
    }
    // Public client routes stay embeddable.
    for (const url of ['/services/admin', '/%73ervices/foo']) {
      expect((await app.inject({ url })).headers['x-frame-options'], url).toBeUndefined();
    }
  });

  it('trusts only the configured number of proxy hops', async () => {
    const res = await app.inject({
      url: '/__ip',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' },
    });
    // TRUST_PROXY=1: the spoofable left-most entry is ignored.
    expect(res.json()).toEqual({ ip: '198.51.100.7' });
  });
});

describe('request logging', () => {
  it('redacts token query parameters', () => {
    expect(redactUrlTokens('/api/public/subscriptions/1/unsubscribe?token=abc-123_x')).toBe(
      '/api/public/subscriptions/1/unsubscribe?token=[REDACTED]',
    );
    expect(redactUrlTokens('/x?a=1&token=abc&b=2&TOKEN=def')).toBe('/x?a=1&token=[REDACTED]&b=2&TOKEN=[REDACTED]');
    expect(redactUrlTokens('/x?mytoken=keep&token_type=keep')).toBe('/x?mytoken=keep&token_type=keep');
    expect(redactUrlTokens('/token=abc')).toBe('/token=abc');
  });

  it('redacts tokens nested in encoded parameter values (return paths)', () => {
    expect(redactUrlTokens('/preferences/language?lang=de&return=%2Fsubscription%2Fmanage%3Fid%3D1%26token%3Dabc-123%26saved%3D1')).toBe(
      '/preferences/language?lang=de&return=%2Fsubscription%2Fmanage%3Fid%3D1%26token%3D[REDACTED]%26saved%3D1',
    );
    expect(redactUrlTokens('/x?return=%2Fy%3Ftoken%3Dabc')).toBe('/x?return=%2Fy%3Ftoken%3D[REDACTED]');
    expect(redactUrlTokens('/x?r=%252Fy%253Ftoken%253Dabc%2526a%253D1')).toBe('/x?r=%252Fy%253Ftoken%253D[REDACTED]%2526a%253D1');
    expect(redactUrlTokens('/x?return=%2Fy%3Fmytoken%3Dkeep')).toBe('/x?return=%2Fy%3Fmytoken%3Dkeep');
  });

  it('never writes tokens from the query string to the log', async () => {
    const lines: string[] = [];
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', LOG_LEVEL: 'info' });
    const db = await createDb(config);
    await migrateToLatest(db);
    const app = await buildApp({ config, db, serveWeb: false, logStream: { write: (line) => lines.push(line) } });
    try {
      await app.inject({ url: '/api/public/summary?token=very-secret-token&lang=en' });
      await app.inject({ url: '/api/nope?token=other-secret-token' });
      const logged = lines.map((l) => JSON.parse(l) as { req?: { url: string; method: string } });
      const urls = logged.flatMap((l) => (l.req ? [l.req.url] : []));
      expect(urls).toEqual(['/api/public/summary?token=[REDACTED]&lang=en', '/api/nope?token=[REDACTED]']);
      expect(logged.find((l) => l.req)?.req?.method).toBe('GET');
      expect(lines.join('\n')).not.toContain('secret-token');
    } finally {
      await app.close();
      await db.destroy();
    }
  });
});

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, migrateToLatest } from '../src/db/index.js';

describe('loadConfig', () => {
  it('requires SECRET_KEY in production but not for development', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/SECRET_KEY/);
    expect(() => loadConfig({})).toThrow(/SECRET_KEY/);
    expect(loadConfig({ NODE_ENV: 'development' }).insecureSecret).toBe(true);
    expect(loadConfig({}, { allowMissingSecret: true }).insecureSecret).toBe(true);
    expect(loadConfig({ SECRET_KEY: 'x'.repeat(32) }).insecureSecret).toBe(false);
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
      expect(res.headers['content-type']).toContain('application/json');
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

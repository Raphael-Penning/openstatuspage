import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const PG = 'postgres://osp:secret@db.invalid:5432/osp';

describe('APP_ROLE configuration', () => {
  it('defaults to all with the worker enabled', () => {
    const c = loadConfig({ NODE_ENV: 'test' });
    expect(c.APP_ROLE).toBe('all');
    expect(c.WORKER_ENABLED).toBe(true);
  });

  it('rejects unknown roles', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', APP_ROLE: 'backend' })).toThrow(/APP_ROLE/);
  });

  it('refuses every role except all on SQLite', () => {
    for (const role of ['public', 'admin', 'worker']) {
      expect(() => loadConfig({ NODE_ENV: 'test', APP_ROLE: role })).toThrow(/APP_ROLE: .*needs PostgreSQL/);
    }
    expect(loadConfig({ NODE_ENV: 'test', APP_ROLE: 'all' }).APP_ROLE).toBe('all');
  });

  it('derives WORKER_ENABLED from the role', () => {
    const worker = (role: string, extra: Record<string, string> = {}) =>
      loadConfig({ NODE_ENV: 'test', DATABASE_URL: PG, APP_ROLE: role, ...extra }).WORKER_ENABLED;
    expect(worker('all')).toBe(true);
    expect(worker('worker')).toBe(true);
    expect(worker('admin')).toBe(false);
    expect(worker('admin', { WORKER_ENABLED: 'true' })).toBe(true);
    expect(worker('public')).toBe(false);
    expect(worker('all', { WORKER_ENABLED: 'false' })).toBe(false);
  });

  it('refuses contradicting worker settings', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_URL: PG, APP_ROLE: 'public', WORKER_ENABLED: 'true' })).toThrow(
      /WORKER_ENABLED/,
    );
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_URL: PG, APP_ROLE: 'worker', WORKER_ENABLED: 'false' })).toThrow(
      /WORKER_ENABLED/,
    );
  });

  it('lets a public instance queue mails without an SMTP server', () => {
    const env = { NODE_ENV: 'test', DATABASE_URL: PG, MAIL_TRANSPORT: 'smtp', SMTP_FROM: 'Status <status@example.com>' };
    expect(loadConfig({ ...env, APP_ROLE: 'public' }).MAIL_TRANSPORT).toBe('smtp');
    expect(() => loadConfig({ ...env, APP_ROLE: 'admin' })).toThrow(/SMTP_HOST/);
  });

  it('only enables OIDC where the login is served', () => {
    const env = { NODE_ENV: 'test', DATABASE_URL: PG, OIDC_ISSUER_URL: 'https://idp.example.com', OIDC_CLIENT_ID: 'osp' };
    expect(loadConfig({ ...env, APP_ROLE: 'admin' }).oidcEnabled).toBe(true);
    expect(loadConfig({ ...env, APP_ROLE: 'public' }).oidcEnabled).toBe(false);
    expect(loadConfig({ ...env, APP_ROLE: 'worker' }).oidcEnabled).toBe(false);
  });
});

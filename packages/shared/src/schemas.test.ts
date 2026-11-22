import { describe, expect, it } from 'vitest';
import { Icinga2Config, zHttpUrl, zHttpUrlOrPath } from './schemas.js';

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: string) => schema.safeParse(value).success;

describe('zHttpUrl', () => {
  it('accepts http(s) URLs', () => {
    expect(ok(zHttpUrl, 'https://mon.example.com:8443/api?x=1#y')).toBe(true);
    expect(ok(zHttpUrl, 'http://192.0.2.10/')).toBe(true);
  });

  it('rejects other schemes and credentials in the URL', () => {
    expect(ok(zHttpUrl, 'ftp://example.com/')).toBe(false);
    expect(ok(zHttpUrl, 'https://user:secret@mon.example.com/')).toBe(false);
    expect(ok(zHttpUrl, 'https://user@mon.example.com/')).toBe(false);
    expect(ok(zHttpUrl, 'https://:secret@mon.example.com/')).toBe(false);
    expect(zHttpUrl.safeParse('https://a:b@mon.example.com/').error?.issues[0]?.message).toBe('must not contain a user name or password');
    // Also for the base URL of monitoring sources, which have their own credential fields.
    expect(Icinga2Config.safeParse({ baseUrl: 'https://osp:pw@icinga.example.com:5665', username: 'osp', password: 'pw' }).success).toBe(false);
  });
});

describe('zHttpUrlOrPath', () => {
  it('accepts http(s) URLs and paths on this site', () => {
    expect(ok(zHttpUrlOrPath, 'https://cdn.example.com/logo.svg')).toBe(true);
    expect(ok(zHttpUrlOrPath, '/logo.svg')).toBe(true);
    expect(ok(zHttpUrlOrPath, '/brand/favicon.ico?v=2')).toBe(true);
  });

  it('rejects paths that a browser reads as another host or that carry hidden characters', () => {
    for (const value of ['//evil.example.com/x.svg', '/\\evil.example.com/x.svg', '/a\\b.svg', '/logo .svg', '/logo\t.svg', '/a\n.svg', '/a\u0000']) {
      expect(ok(zHttpUrlOrPath, value)).toBe(false);
    }
    expect(ok(zHttpUrlOrPath, 'javascript:alert(1)')).toBe(false);
    expect(ok(zHttpUrlOrPath, 'logo.svg')).toBe(false);
  });
});

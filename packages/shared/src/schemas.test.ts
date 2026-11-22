import { describe, expect, it } from 'vitest';
import { Icinga2Config, SECRET_MASK, zDatabaseUrl, zHttpUrl, zHttpUrlOrPath } from './schemas.js';

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

describe('zDatabaseUrl', () => {
  it('accepts connection strings with credentials and the TLS parameter of each driver', () => {
    for (const value of [
      'mysql://reader:p%40ss@db.example.com:3306/icingadb',
      'mariadb://reader:secret@db.example.com/icingadb',
      'mysql://reader:secret@db.example.com/icingadb?ssl={"rejectUnauthorized":true}',
      'postgres://reader:secret@db.example.com:5432/icingadb',
      'postgresql://reader:secret@db.example.com/icingadb?sslmode=require',
      'postgres://reader:secret@[2001:db8::1]/icingadb?sslmode=verify-full',
      SECRET_MASK,
    ]) {
      expect(ok(zDatabaseUrl, value), value).toBe(true);
    }
  });

  it('rejects parameters that make the driver read files or use local sockets', () => {
    for (const value of [
      'postgres://reader:secret@db.example.com/icingadb?sslrootcert=/etc/passwd',
      'postgres://reader:secret@db.example.com/icingadb?sslmode=require&sslkey=/etc/ssl/private/key.pem',
      'postgres://reader:secret@db.example.com/icingadb?sslcert=/tmp/x',
      'postgres://reader:secret@db.example.com/icingadb?host=/var/run/postgresql',
      'postgres://reader:secret@%2Fvar%2Frun%2Fpostgresql/icingadb',
      'postgres://reader:secret@db.example.com/icingadb?sslmode=bogus',
      'postgres://reader:secret@db.example.com/icingadb?sslmode=require&sslmode=disable',
      'postgres://reader:secret@db.example.com/icingadb?ssl=true',
      'mysql://reader:secret@db.example.com/icingadb?socketPath=/var/run/mysqld/mysqld.sock',
      'mysql://reader:secret@db.example.com/icingadb?sslmode=require',
      'mysql://reader:secret@db.example.com/icingadb?flags=LOCAL_FILES',
      'mysql://reader:secret@db.example.com/icingadb#x',
      'postgres:///icingadb',
    ]) {
      expect(ok(zDatabaseUrl, value), value).toBe(false);
    }
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

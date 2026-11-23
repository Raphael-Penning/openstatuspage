/**
 * SSO providers on PostgreSQL (migration 0016_oidc_providers): the restricted
 * public role holds no privilege on the provider and identity tables, sees no
 * row through row level security and gets nothing in osp_public. The admin
 * connection stores and reads them normally.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/index.js';
import { SecretBox } from '../src/lib/crypto.js';
import { prepareDatabase } from '../src/startup.js';
import { createTestDatabase, SECRET_KEY, type PgTestDatabase } from './setup.js';

const NOW = new Date().toISOString();
const TABLES = ['oidc_providers', 'user_oidc_identities'];

let pgdb: PgTestDatabase;
let owner: DB;
let pub: DB;
const log = { info: () => undefined, warn: () => undefined };

async function attempt(query: string): Promise<string> {
  try {
    await sql.raw(query).execute(pub);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

beforeAll(async () => {
  pgdb = await createTestDatabase();
  owner = await pgdb.connect('admin');
  await prepareDatabase(owner, pgdb.config('admin'), log);
  await owner
    .insertInto('users')
    .values({ id: 'u1', email: 'jane@example.com', name: 'Jane', role: 'admin', password_hash: null, oidc_subject: null, created_at: NOW, updated_at: NOW, last_login_at: null })
    .execute();
  await owner
    .insertInto('oidc_providers')
    .values({
      id: 'p1',
      name: 'Example IdP',
      sort_order: 0,
      enabled: 1,
      issuer_url: 'https://idp.example.com',
      client_id: 'openstatuspage',
      client_secret: new SecretBox(SECRET_KEY).encrypt('client-secret'),
      scopes: 'openid email profile',
      auto_create_users: 0,
      allowed_domains: '[]',
      role_claim: 'groups',
      role_mappings: '[]',
      default_role: 'editor',
      role_sync: 'login',
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
  await owner
    .insertInto('user_oidc_identities')
    .values({ provider_id: 'p1', subject: 'jane', user_id: 'u1', created_at: NOW, last_login_at: null })
    .execute();
  pub = await pgdb.connect('public');
}, 60_000);

afterAll(async () => {
  await pub?.destroy();
  await owner?.destroy();
  await pgdb?.drop();
});

describe('OIDC provider tables', () => {
  it('are not readable or writable by the public role', async () => {
    for (const table of TABLES) {
      expect(await attempt(`select * from public.${table}`), table).toBe('42501');
      expect(await attempt(`select count(*) from public.${table}`), table).toBe('42501');
      expect(await attempt(`delete from public.${table}`), table).toBe('42501');
      expect(await attempt(`select * from osp_public.${table}`), table).toBe('42P01');
    }
    expect(await attempt(`insert into public.user_oidc_identities values ('p1', 'x', 'u1', 'now', null)`)).toBe('42501');
  });

  it('have row level security with the policy of the public role', async () => {
    const { rows } = await sql<{ name: string; rls: boolean; policy: boolean }>`
      select c.relname as name, c.relrowsecurity as rls,
        exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'osp_public_role') as policy
      from pg_class c where c.relnamespace = current_schema()::regnamespace and c.relname in ('oidc_providers', 'user_oidc_identities')
      order by 1`.execute(owner);
    expect(rows).toEqual([
      { name: 'oidc_providers', rls: true, policy: true },
      { name: 'user_oidc_identities', rls: true, policy: true },
    ]);
  });

  it('keep working for the admin instance', async () => {
    const row = await owner.selectFrom('oidc_providers').selectAll().executeTakeFirstOrThrow();
    expect(new SecretBox(SECRET_KEY).decrypt(row.client_secret!)).toBe('client-secret');
    await owner.deleteFrom('users').where('id', '=', 'u1').execute();
    expect(await owner.selectFrom('user_oidc_identities').selectAll().execute()).toEqual([]);
  });
});

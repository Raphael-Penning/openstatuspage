import { Migrator } from 'kysely/migration';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { migrations } from '../src/db/migrations/index.js';

describe('0016_oidc_providers', () => {
  it('moves the 0.3.x SSO links to the environment provider and back', async () => {
    const db = await createDb({ database: { dialect: 'sqlite', filename: ':memory:' } });
    try {
      const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
      expect((await migrator.migrateTo('0013_schema_create_hardening')).error).toBeUndefined();
      const user = (id: string, oidc_subject: string | null) => ({
        id,
        email: `${id}@example.com`,
        name: id,
        role: 'editor',
        password_hash: null,
        oidc_subject,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        last_login_at: '2026-01-03T00:00:00.000Z',
      });
      await db.insertInto('users').values([user('jane', 'jane-sub'), user('local', null)] as never).execute();

      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      expect(await db.selectFrom('user_oidc_identities').selectAll().execute()).toEqual([
        {
          provider_id: 'env',
          subject: 'jane-sub',
          user_id: 'jane',
          created_at: '2026-01-02T00:00:00.000Z',
          last_login_at: '2026-01-03T00:00:00.000Z',
        },
      ]);
      expect(await db.selectFrom('users').select('oidc_subject').where('oidc_subject', 'is not', null).execute()).toEqual([]);

      // Deleting a user deletes its identities.
      await db.deleteFrom('users').where('id', '=', 'jane').execute();
      expect(await db.selectFrom('user_oidc_identities').selectAll().execute()).toEqual([]);
      await db.insertInto('users').values(user('jane', null) as never).execute();
      await db
        .insertInto('user_oidc_identities')
        .values({ provider_id: 'env', subject: 'jane-sub', user_id: 'jane', created_at: 'x', last_login_at: null })
        .execute();

      expect((await migrator.migrateTo('0013_schema_create_hardening')).error).toBeUndefined();
      const rows = await db.selectFrom('users').select(['id', 'oidc_subject']).orderBy('id').execute();
      expect(rows).toEqual([
        { id: 'jane', oidc_subject: 'jane-sub' },
        { id: 'local', oidc_subject: null },
      ]);
    } finally {
      await db.destroy();
    }
  });
});

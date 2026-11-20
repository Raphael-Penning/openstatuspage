import { Migrator } from 'kysely/migration';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { migrations } from '../src/db/migrations/index.js';

describe('0008_task_leases', () => {
  it('fails older duplicates of an active import before it adds the unique index', async () => {
    const db = await createDb({ database: { dialect: 'sqlite', filename: ':memory:' } });
    const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
    expect((await migrator.migrateTo('0007_public_role')).error).toBeUndefined();
    const ts = '2026-01-01T00:00:00.000Z';
    await db
      .insertInto('monitor_sources')
      .values({
        id: 'src',
        name: 'Kuma',
        type: 'webhook',
        enabled: 1,
        config_encrypted: 'x',
        poll_interval_seconds: 60,
        ingest_token_hash: 'hash',
        last_poll_at: null,
        last_poll_ok: null,
        last_error: null,
        created_at: ts,
        updated_at: ts,
      } as never)
      .execute();
    const job = (id: string, status: string, createdAt: string) => ({
      id,
      source_id: 'src',
      status,
      range_from: ts,
      range_to: ts,
      only_linked: 1,
      credentials_encrypted: 'secret',
      created_at: createdAt,
      updated_at: createdAt,
    });
    await db
      .insertInto('history_imports')
      .values([
        job('old', 'fetching', '2026-01-01T00:00:00.000Z'),
        job('new', 'ready', '2026-01-02T00:00:00.000Z'),
        job('done', 'completed', '2026-01-03T00:00:00.000Z'),
      ] as never)
      .execute();
    const { error } = await migrator.migrateToLatest();
    expect(error).toBeUndefined();
    const rows = await db
      .selectFrom('history_imports')
      .select(['id', 'status', 'credentials_encrypted'])
      .orderBy('id')
      .execute();
    expect(rows).toEqual([
      { id: 'done', status: 'completed', credentials_encrypted: 'secret' },
      { id: 'new', status: 'ready', credentials_encrypted: 'secret' },
      { id: 'old', status: 'failed', credentials_encrypted: null },
    ]);
    await db.destroy();
  });
});

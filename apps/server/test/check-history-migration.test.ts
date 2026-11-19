import { Migrator } from 'kysely/migration';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { migrations } from '../src/db/migrations/index.js';

describe('0005_check_history migration', () => {
  it('seeds the current state of existing checks as open live history and migrates down', async () => {
    const db = await createDb(loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:' }));
    const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
    expect((await migrator.migrateTo('0003_check_bundles')).error).toBeUndefined();

    const ts = '2026-01-01T00:00:00.000Z';
    await db
      .insertInto('monitor_sources')
      .values({
        id: 's1',
        name: 'Source',
        type: 'webhook',
        enabled: 1,
        config_encrypted: 'x',
        poll_interval_seconds: 60,
        ingest_token_hash: 'h',
        last_poll_at: null,
        last_poll_ok: null,
        last_error: null,
        created_at: ts,
        updated_at: ts,
      })
      .execute();
    for (const [id, state, changed] of [
      ['c1', 'critical', '2026-02-01T00:00:00.000Z'],
      ['c2', 'ok', null],
    ] as const) {
      await db
        .insertInto('monitor_checks')
        .values({
          id,
          source_id: 's1',
          external_id: id,
          name: id,
          host: null,
          state,
          output: null,
          last_check_at: null,
          last_state_change_at: changed,
          created_at: ts,
          updated_at: ts,
        })
        .execute();
    }
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    const rows = await db
      .selectFrom('monitor_check_history')
      .select(['check_id', 'state', 'started_at', 'ended_at', 'source'])
      .orderBy('check_id')
      .execute();
    expect(rows).toEqual([
      { check_id: 'c1', state: 'critical', started_at: '2026-02-01T00:00:00.000Z', ended_at: null, source: 'live' },
      { check_id: 'c2', state: 'ok', started_at: ts, ended_at: null, source: 'live' },
    ]);

    expect((await migrator.migrateTo('0003_check_bundles')).error).toBeUndefined();
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    await db.destroy();
  });
});

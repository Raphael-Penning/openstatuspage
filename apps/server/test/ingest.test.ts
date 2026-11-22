import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDb, migrateToLatest, type DB } from '../src/db/index.js';
import { IngestService } from '../src/services/ingest.js';
import { StatusEngine } from '../src/services/status-engine.js';

describe('IngestService', () => {
  let db: DB;
  let ingest: IngestService;

  beforeEach(async () => {
    db = await createDb(loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:' }));
    await migrateToLatest(db);
    const ts = new Date().toISOString();
    await db
      .insertInto('monitor_sources')
      .values({
        id: 'src',
        name: 'Source',
        type: 'webhook',
        enabled: 1,
        config_encrypted: '',
        poll_interval_seconds: 60,
        ingest_token_hash: 'x',
        last_poll_at: null,
        last_poll_ok: null,
        last_error: null,
        created_at: ts,
        updated_at: ts,
      })
      .execute();
    ingest = new IngestService(db, new StatusEngine(db));
  });

  const stored = () => db.selectFrom('monitor_checks').select(['name', 'host', 'output', 'state']).executeTakeFirstOrThrow();

  it('keeps stored metadata on partial updates', async () => {
    await ingest.ingest('src', [{ externalId: 'a', name: 'Nice name', host: 'h1', state: 'ok', output: 'fine' }], { full: false });
    await ingest.ingest('src', [{ externalId: 'a', state: 'ok' }], { full: false });
    expect(await stored()).toEqual({ name: 'Nice name', host: 'h1', output: 'fine', state: 'ok' });

    // A state change without output clears the now outdated output.
    await ingest.ingest('src', [{ externalId: 'a', state: 'critical' }], { full: false });
    expect(await stored()).toEqual({ name: 'Nice name', host: 'h1', output: null, state: 'critical' });

    // Explicit values still overwrite, null clears.
    await ingest.ingest('src', [{ externalId: 'a', name: 'Renamed', host: null, state: 'ok', output: 'back' }], { full: false });
    expect(await stored()).toEqual({ name: 'Renamed', host: null, output: 'back', state: 'ok' });
  });

  it('names new checks after their external id when no name is given', async () => {
    await ingest.ingest('src', [{ externalId: 'web01!http', state: 'warning' }], { full: false });
    expect((await stored()).name).toBe('web01!http');
  });

  it('caps result times in the future at the server clock', async () => {
    const before = Date.now();
    await ingest.ingest(
      'src',
      [
        { externalId: 'future', state: 'ok', checkedAt: '2099-01-01T00:00:00.000Z' },
        { externalId: 'skew', state: 'ok', checkedAt: new Date(before + 60_000).toISOString() },
        { externalId: 'past', state: 'ok', checkedAt: '2026-01-01T00:00:00.000Z' },
      ],
      { full: false },
    );
    const rows = await db.selectFrom('monitor_checks').select(['external_id', 'last_check_at']).execute();
    const at = Object.fromEntries(rows.map((r) => [r.external_id, r.last_check_at!]));
    expect(Date.parse(at.future!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(at.future!)).toBeLessThanOrEqual(Date.now());
    // Small clock skew is kept as reported.
    expect(at.skew).toBe(new Date(before + 60_000).toISOString());
    expect(at.past).toBe('2026-01-01T00:00:00.000Z');
  });
});

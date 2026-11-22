/**
 * The last-admin guard under concurrency (PostgreSQL, READ COMMITTED).
 *
 * Two admins demoting or deleting each other at the same moment must not leave
 * the instance without an admin. A third connection holds the admin rows so
 * both requests are in flight together before either can finish; the guard
 * then has to serialise them instead of letting both pass a stale count.
 */
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateToLatest, type DB } from '../src/db/index.js';
import { newId } from '../src/lib/ids.js';
import { nowIso } from '../src/lib/time.js';
import { changeUserRole, deleteUser, insertApiToken } from '../src/services/users.js';
import { createTestDatabase, type PgTestDatabase } from './setup.js';

let pgdb: PgTestDatabase;
let db: DB;
let dbName: string;

beforeAll(async () => {
  pgdb = await createTestDatabase();
  db = await pgdb.connect('all');
  await migrateToLatest(db);
  // Open pool connections up front, so the concurrent requests do not wait for a connect.
  await Promise.all([1, 2, 3].map(() => sql`select pg_sleep(0.05)`.execute(db)));
  dbName = new URL(pgdb.ownerUrl).pathname.slice(1);
});
afterAll(async () => {
  await db?.destroy();
  await pgdb?.drop();
});
beforeEach(async () => {
  await db.deleteFrom('api_tokens').execute();
  await db.deleteFrom('users').execute();
});

async function addAdmin(email: string): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db
    .insertInto('users')
    .values({ id, email, name: email, role: 'admin', password_hash: null, oidc_subject: null, created_at: now, updated_at: now, last_login_at: null })
    .execute();
  return id;
}

/** Runs `work` while another connection holds the admin rows, released once `waiting` backends wait for it. */
async function whileAdminsLocked(waiting: number, work: () => Promise<unknown>[]): Promise<PromiseSettledResult<unknown>[]> {
  const holder = new pg.Client({ connectionString: pgdb.ownerUrl });
  await holder.connect();
  try {
    await holder.query('begin');
    await holder.query("select id from users where role = 'admin' for update");
    const results = Promise.allSettled(work());
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await holder.query<{ n: string }>(
        "select count(*) as n from pg_stat_activity where datname = $1 and wait_event_type = 'Lock'",
        [dbName],
      );
      if (Number(rows[0]!.n) >= waiting) break;
      if (Date.now() > deadline) {
        const { rows: activity } = await holder.query(
          'select state, wait_event_type, wait_event, query from pg_stat_activity where datname = $1',
          [dbName],
        );
        throw new Error(`the concurrent requests never waited for the lock: ${JSON.stringify(activity)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await holder.query('commit');
    return await results;
  } finally {
    await holder.end();
  }
}

const values = (results: PromiseSettledResult<unknown>[]) =>
  results.map((r) => (r.status === 'fulfilled' ? r.value : `error: ${String(r.reason)}`));

describe('last admin guard', () => {
  it('lets only one of two admins demote the other at the same time', async () => {
    const a = await addAdmin('a@example.com');
    const b = await addAdmin('b@example.com');
    const results = await whileAdminsLocked(2, () => [changeUserRole(db, a, 'editor'), changeUserRole(db, b, 'editor')]);
    expect(values(results).map(String).sort()).toEqual(['changed', 'last_admin']);
    const admins = await db.selectFrom('users').select('id').where('role', '=', 'admin').execute();
    expect(admins).toHaveLength(1);
  });

  it('lets only one of two admins delete the other at the same time', async () => {
    const a = await addAdmin('a@example.com');
    const b = await addAdmin('b@example.com');
    const results = await whileAdminsLocked(2, () => [deleteUser(db, a), deleteUser(db, b)]);
    expect(values(results).map(String).sort()).toEqual(['deleted', 'last_admin']);
    const admins = await db.selectFrom('users').select('id').where('role', '=', 'admin').execute();
    expect(admins).toHaveLength(1);
  });

  it('never keeps an admin token of an owner demoted while it was created', async () => {
    const a = await addAdmin('a@example.com');
    await addAdmin('b@example.com');
    const token = { id: newId(), name: 'ops', role: 'admin' as const, tokenHash: newId(), createdBy: a, createdAt: nowIso() };
    const results = await whileAdminsLocked(2, () => [changeUserRole(db, a, 'editor'), insertApiToken(db, token)]);
    expect(values(results)[0]).toBe('changed');
    // Either the insert saw the demotion (false) or the demotion revoked the new token.
    const tokens = await db.selectFrom('api_tokens').select('id').where('created_by', '=', a).where('role', '=', 'admin').execute();
    expect(tokens).toEqual([]);
  });
});

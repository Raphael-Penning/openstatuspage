import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createDb, migrateToLatest } from '../src/db/index.js';
import { usesDatabaseFunctions } from '../src/services/subscription-flow.js';

// The PostgreSQL side is covered by test-pg/public-role.test.ts (pnpm test:pg).
describe('0007_public_role on SQLite', () => {
  it('is a no-op', async () => {
    const db = await createDb({ database: { dialect: 'sqlite', filename: ':memory:' } });
    await migrateToLatest(db);
    const { rows } = await sql<{ name: string; type: string }>`
      select name, type from sqlite_master where name like 'osp%' or type = 'view'`.execute(db);
    expect(rows).toEqual([]);
    const applied = await sql<{ name: string }>`select name from kysely_migration where name = '0007_public_role'`.execute(db);
    expect(applied.rows).toHaveLength(1);
    await db.destroy();
  });

  it('keeps the direct subscription queries everywhere except a public PostgreSQL instance', () => {
    const sqlite = { dialect: 'sqlite', filename: ':memory:' } as const;
    const postgres = { dialect: 'postgres', connectionString: 'postgres://db.invalid/osp' } as const;
    expect(usesDatabaseFunctions({ APP_ROLE: 'public', database: postgres })).toBe(true);
    expect(usesDatabaseFunctions({ APP_ROLE: 'public', database: sqlite })).toBe(false);
    for (const role of ['all', 'admin', 'worker'] as const) {
      expect(usesDatabaseFunctions({ APP_ROLE: role, database: postgres })).toBe(false);
    }
  });
});

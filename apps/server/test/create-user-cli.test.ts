import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseCreateUserArgs, PASSWORD_ENV, readPassword } from '../src/cli/create-user-input.js';
import { createDb } from '../src/db/index.js';
import { verifyPassword } from '../src/lib/password.js';

const io = (stdin: string, env: NodeJS.ProcessEnv = {}) => ({ env, input: Readable.from([stdin]), output: new PassThrough() });

describe('create-user arguments', () => {
  it('takes email, role and name but never a password', () => {
    expect(parseCreateUserArgs(['Admin@Example.com'])).toEqual({
      ok: true,
      args: { email: 'admin@example.com', role: 'admin', name: 'Administrator', unlinkOidc: false },
    });
    expect(parseCreateUserArgs(['jane@example.com', 'editor', 'Jane Doe', '--unlink-oidc'])).toEqual({
      ok: true,
      args: { email: 'jane@example.com', role: 'editor', name: 'Jane Doe', unlinkOidc: true },
    });
    // The former form with the password as second argument is refused.
    const legacy = parseCreateUserArgs(['admin@example.com', 'a-long-password', 'admin']);
    expect(legacy.ok).toBe(false);
    expect(!legacy.ok && legacy.error).toMatch(/no longer accepted/);
    expect(parseCreateUserArgs([]).ok).toBe(false);
    expect(parseCreateUserArgs(['admin@example.com', 'admin', 'A', 'B']).ok).toBe(false);
    expect(parseCreateUserArgs(['admin@example.com', '--force']).ok).toBe(false);
  });

  it('reads the password from the environment or the first line of stdin', async () => {
    expect(await readPassword(io('', { [PASSWORD_ENV]: 'from-the-environment' }))).toEqual({
      ok: true,
      password: 'from-the-environment',
    });
    expect(await readPassword(io('from-stdin-1234\r\nignored\n'))).toEqual({ ok: true, password: 'from-stdin-1234' });
    expect((await readPassword(io('short\n'))).ok).toBe(false);
    expect((await readPassword(io(''))).ok).toBe(false);
  });
});

describe('create-user command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osp-create-user-'));
  const file = join(dir, 'test.db');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../src/cli/create-user.ts', import.meta.url));
  const run = (args: string[], stdin: string) =>
    spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
      input: stdin,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: `sqlite:${file}` },
      timeout: 60_000,
    });

  it('creates a user with the password from stdin and refuses it as an argument', async () => {
    const legacy = run(['admin@example.com', 'a-long-password-on-argv', 'admin'], '');
    expect(legacy.status).toBe(1);
    expect(legacy.stderr).toMatch(/no longer accepted/);

    const created = run(['admin@example.com', 'admin', 'Jane Doe'], 'a-long-password-on-stdin\n');
    expect(created.stderr).toBe('');
    expect(created.status).toBe(0);
    const db = await createDb({ database: { dialect: 'sqlite', filename: file } });
    try {
      const users = await db.selectFrom('users').selectAll().execute();
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ email: 'admin@example.com', role: 'admin', name: 'Jane Doe' });
      expect(await verifyPassword(users[0]!.password_hash!, 'a-long-password-on-stdin')).toBe(true);
    } finally {
      await db.destroy();
    }
  }, 60_000);
});

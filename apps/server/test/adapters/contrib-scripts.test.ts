/**
 * Runs the shell integration scripts from contrib/ and feeds their payloads
 * through the matching push parsers (and, when curl is available, through
 * the real ingest endpoint on a unix socket).
 */
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { icinga2PushParser } from '../../src/adapters/icinga2.js';
import { openItCockpitPushParser } from '../../src/adapters/openitcockpit.js';
import { createTestApp, type TestApp } from './helpers.js';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const icingaScript = join(root, 'contrib/icinga2/openstatuspage-notify.sh');
const oitcScript = join(root, 'contrib/openitcockpit/openstatuspage-notify.sh');

const hasSh = process.platform !== 'win32' && spawnSync('sh', ['-c', 'true']).status === 0;
const hasCurl = hasSh && spawnSync('curl', ['--version']).status === 0;

const trickyOutput = 'CRITICAL - "quoted" \\ backslash\ttab\nsecond line ÄÖÜ ß € $HOME `id`';

function run(script: string, args: string[], env: Record<string, string>) {
  const res = spawnSync('sh', [script, ...args], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe.skipIf(!hasSh)('contrib/icinga2/openstatuspage-notify.sh', () => {
  it('builds a valid payload that the icinga2 parser accepts', () => {
    const res = run(icingaScript, [], {
      OSP_DRY_RUN: '1',
      OSP_TYPE: 'service',
      OSP_HOST: 'web01.example.com',
      OSP_SERVICE: 'https',
      OSP_SERVICE_DISPLAY_NAME: 'HTTPS',
      OSP_STATE: 'CRITICAL',
      OSP_STATE_ID: '2',
      OSP_OUTPUT: trickyOutput,
      OSP_TIMESTAMP: '1763380800',
      OSP_NOTIFICATION_TYPE: 'PROBLEM',
    });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload).toEqual({
      type: 'service',
      host: 'web01.example.com',
      service: 'https',
      displayName: 'HTTPS',
      state: 'CRITICAL',
      stateId: '2',
      output: trickyOutput,
      timestamp: '1763380800',
      notificationType: 'PROBLEM',
    });
    expect(icinga2PushParser.parse(payload, {}).checks[0]).toMatchObject({
      externalId: 'web01.example.com!https',
      state: 'critical',
      output: trickyOutput,
    });
  });

  it('handles host notifications and rejects incomplete input', () => {
    const host = run(icingaScript, [], { OSP_DRY_RUN: '1', OSP_HOST: 'db01', OSP_STATE: 'DOWN' });
    expect(JSON.parse(host.stdout)).toEqual({ type: 'host', host: 'db01', state: 'DOWN' });
    expect(run(icingaScript, [], { OSP_DRY_RUN: '1', OSP_STATE: 'DOWN' }).status).toBe(3);
    expect(run(icingaScript, [], { OSP_DRY_RUN: '1', OSP_TYPE: 'service', OSP_HOST: 'x', OSP_STATE: 'OK' }).status).toBe(3);
    expect(run(icingaScript, [], { OSP_HOST: 'x', OSP_STATE: 'OK' }).stderr).toContain('OSP_URL is required');
  });

  it('rejects tokens outside the base64url alphabet before calling curl', () => {
    for (const token of ['a"b', 'a\\b', 'a\nurl = "http://example.com"', 'a b']) {
      const res = run(icingaScript, [], { OSP_URL: 'http://127.0.0.1:9/x', OSP_TOKEN: token, OSP_HOST: 'x', OSP_STATE: 'OK' });
      expect(res.status).toBe(3);
      expect(res.stderr).toContain('OSP_TOKEN contains characters');
    }
  });
});

describe.skipIf(!hasSh)('contrib/openitcockpit/openstatuspage-notify.sh', () => {
  it('builds a valid payload that the openitcockpit parser accepts', () => {
    const res = run(
      oitcScript,
      ['-n', '-t', 'service', '-H', 'host-uuid', '-N', 'web01', '-S', 'service-uuid', '-D', 'HTTPS', '-s', '2', '-o', trickyOutput, '-T', '1763380800'],
      {},
    );
    expect(res.stderr).toBe('');
    const payload = JSON.parse(res.stdout);
    expect(payload).toEqual({
      type: 'service',
      host: 'host-uuid',
      hostDisplayName: 'web01',
      service: 'service-uuid',
      serviceDisplayName: 'HTTPS',
      stateId: '2',
      output: trickyOutput,
      timestamp: '1763380800',
    });
    expect(openItCockpitPushParser.parse(payload, {}).checks[0]).toMatchObject({
      externalId: 'host-uuid!service-uuid',
      name: 'HTTPS',
      host: 'web01',
      state: 'critical',
    });
  });

  it('rejects missing state', () => {
    expect(run(oitcScript, ['-n', '-H', 'h'], {}).status).toBe(3);
  });

  it('rejects tokens outside the base64url alphabet before calling curl', () => {
    const res = run(oitcScript, ['-H', 'h', '-s', '0'], { OSP_URL: 'http://127.0.0.1:9/x', OSP_TOKEN: 'a"\nheader = "X: y' });
    expect(res.status).toBe(3);
    expect(res.stderr).toContain('OSP_TOKEN contains characters');
  });
});

describe.skipIf(!hasCurl)('scripts against the real ingest endpoint', () => {
  let t: TestApp;
  let dir: string;
  let socket: string;

  beforeAll(async () => {
    t = await createTestApp();
    dir = mkdtempSync(join(tmpdir(), 'osp-contrib-'));
    socket = join(dir, 'api.sock');
    await t.app.listen({ path: socket });
  });

  afterAll(async () => {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('delivers Icinga 2 notifications (token from a config file)', async () => {
    const { id, token } = await t.insertSource({ type: 'webhook' });
    const configFile = join(dir, 'icinga.env');
    writeFileSync(configFile, `OSP_URL=http://localhost/api/ingest/${id}/icinga2\nOSP_TOKEN="${token}"\n`);
    await execFileAsync('sh', [icingaScript], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        OSP_CONFIG: configFile,
        OSP_CURL_OPTS: `--unix-socket ${socket}`,
        OSP_HOST: 'web01.example.com',
        OSP_SERVICE: 'https',
        OSP_STATE: 'WARNING',
        OSP_OUTPUT: trickyOutput,
      },
    });
    const check = await t.ctx.db.selectFrom('monitor_checks').selectAll().where('source_id', '=', id).executeTakeFirstOrThrow();
    expect(check).toMatchObject({ external_id: 'web01.example.com!https', state: 'warning', output: trickyOutput });
  });

  it('delivers openITCockpit notifications and fails on a wrong token', async () => {
    const { id, token } = await t.insertSource({ type: 'webhook' });
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      OSP_URL: `http://localhost/api/ingest/${id}/openitcockpit`,
      OSP_TOKEN: token,
      OSP_CURL_OPTS: `--unix-socket ${socket}`,
    };
    await execFileAsync('sh', [oitcScript, '-t', 'host', '-H', 'host-uuid', '-N', 'db01', '-s', '1'], { env });
    const check = await t.ctx.db.selectFrom('monitor_checks').selectAll().where('source_id', '=', id).executeTakeFirstOrThrow();
    expect(check).toMatchObject({ external_id: 'host-uuid', name: 'db01', state: 'critical' });

    const failed = await execFileAsync('sh', [oitcScript, '-H', 'h', '-s', '0'], { env: { ...env, OSP_TOKEN: 'wrong' } }).catch(
      (e: { code: number; stderr: string }) => e,
    );
    expect(failed).toMatchObject({ code: 1 });
    expect((failed as { stderr: string }).stderr).toContain('HTTP 401');
  });
});

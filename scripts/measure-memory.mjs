#!/usr/bin/env node
/**
 * Measures the resident memory (RSS) of the production build per APP_ROLE.
 *
 * For every role it starts `node apps/server/dist/index.js` on its own (one
 * instance at a time), samples the RSS of the process and reports:
 *
 *   startup  RSS a few seconds after /api/health answered
 *   peak     highest RSS seen during the light load below
 *   after    RSS once the load is over and the process settled
 *
 * Light load: the demo seed, a few hundred requests to the public pages, API and
 * feeds (public, admin, all), a login and the main admin lists plus a monitoring
 * source that is polled from a local fake Uptime Kuma (admin, all), and at least
 * one polling cycle of that source (worker, all).
 *
 * Usage (build first: pnpm -r build):
 *
 *   DATABASE_URL=postgres://owner:pw@127.0.0.1:5432/osp \
 *   PUBLIC_DATABASE_URL=postgres://osp_public:pw@127.0.0.1:5432/osp \
 *   node scripts/measure-memory.mjs [--roles public,admin,worker,all] [--requests 400]
 *
 * Use a fresh, empty database: the script migrates it, fills it with the demo
 * seed and creates an admin user (MEASURE_ADMIN_EMAIL / MEASURE_ADMIN_PASSWORD).
 * With `DATABASE_URL=sqlite:...` only the role `all` can run.
 *
 * Options:
 *   --server <path>     server entry (default apps/server/dist/index.js)
 *   --roles <list>      roles in this order (default admin,public,worker,all;
 *                       admin or all comes first so the polled source exists)
 *   --requests <n>      public requests per role (default 400)
 *   --poll-seconds <n>  how long worker and all keep running for polls (default 40)
 *   --settle-seconds <n> idle time before "after" is read (default 15; V8 shrinks
 *                       the heap of an idle process after a few seconds)
 *   --node-args <args>  extra node flags, e.g. "--max-old-space-size=64"
 *   --json              print the results as JSON instead of a table
 *   --verbose           pass the server's stderr through
 *
 * Every other setting comes from the environment as usual (e.g. NODE_OPTIONS,
 * WEB_DIST_DIR). Nothing here is meant for production databases.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({
  options: {
    server: { type: 'string', default: join(root, 'apps/server/dist/index.js') },
    roles: { type: 'string', default: 'admin,public,worker,all' },
    requests: { type: 'string', default: '400' },
    'poll-seconds': { type: 'string', default: '40' },
    'settle-seconds': { type: 'string', default: '15' },
    'node-args': { type: 'string', default: '' },
    json: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
  },
});

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) fail('DATABASE_URL is required (a fresh PostgreSQL database, or sqlite:<file> for the role all).');
const PUBLIC_DATABASE_URL = process.env.PUBLIC_DATABASE_URL || DATABASE_URL;
const ADMIN_EMAIL = process.env.MEASURE_ADMIN_EMAIL || 'memory-check@example.com';
const ADMIN_PASSWORD = process.env.MEASURE_ADMIN_PASSWORD || 'memory-check-only-password';
// A throwaway key for a throwaway database; set SECRET_KEY to use your own.
const SECRET_KEY = process.env.SECRET_KEY || 'measure-memory-throwaway-key-0123456789abcdef';
const SOURCE_NAME = 'Memory check (fake Uptime Kuma)';
const serverEntry = resolve(opts.server);
const cliDir = join(dirname(serverEntry), 'cli');
const roles = opts.roles.split(',').map((r) => r.trim()).filter(Boolean);
const requests = Number(opts.requests);
const pollSeconds = Number(opts['poll-seconds']);
const settleSeconds = Number(opts['settle-seconds']);
const nodeArgs = opts['node-args'].split(/\s+/).filter(Boolean);
const JSONAPI = 'application/vnd.api+json';

function fail(message) {
  console.error(message);
  process.exit(1);
}
const log = (msg) => process.stderr.write(`${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * RSS of a process in KiB. On Linux also the kernel's peak (VmHWM) and the
 * anonymous part (RssAnon: JavaScript heap, malloc) next to the file-backed part
 * (mostly the pages of the node binary, shared and reclaimable).
 */
function memoryOf(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kib = (key) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(status)?.[1] ?? NaN);
    return { rss: kib('VmRSS'), hwm: kib('VmHWM'), anon: kib('RssAnon') };
  } catch {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
    return { rss: Number(out.trim()), hwm: NaN, anon: NaN };
  }
}

/** Fake Uptime Kuma: /metrics in the Prometheus format with a few monitors that change state. */
function startFakeKuma() {
  let round = 0;
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/metrics')) {
      res.writeHead(404).end();
      return;
    }
    round++;
    const lines = ['# HELP monitor_status Monitor Status (1 = UP, 0= DOWN, 2= PENDING, 3= MAINTENANCE)', '# TYPE monitor_status gauge'];
    for (let i = 1; i <= 25; i++) {
      const labels = `monitor_name="check-${i}",monitor_type="http",monitor_url="https://service-${i}.example.com",monitor_hostname="null",monitor_port="null"`;
      const up = (i + round) % 7 === 0 ? 0 : 1;
      lines.push(`monitor_status{${labels}} ${up}`, `monitor_response_time{${labels}} ${20 + i}`);
    }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(`${lines.join('\n')}\n`);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

function freePort() {
  return new Promise((ok, err) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
    s.on('error', err);
  });
}

function baseEnv(role) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    APP_ROLE: role,
    DATABASE_URL: role === 'public' ? PUBLIC_DATABASE_URL : DATABASE_URL,
    // Like a split deployment: the public instance gets only the token key.
    ...(role === 'public' ? {} : { SECRET_KEY }),
    SUBSCRIPTION_TOKEN_KEY: SECRET_KEY,
    // Without PUBLIC_DATABASE_URL the public instance measures with the owner login.
    ...(role === 'public' && !process.env.PUBLIC_DATABASE_URL ? { ALLOW_UNRESTRICTED_PUBLIC_DB: 'true' } : {}),
    LOG_LEVEL: process.env.LOG_LEVEL || 'warn',
    MAIL_TRANSPORT: 'log',
    SMTP_FROM: 'Status <status@example.com>',
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    HOST: '127.0.0.1',
  };
}

function runCli(name, { allowFailure = false } = {}) {
  const file = join(cliDir, `${name}.js`);
  if (!existsSync(file)) fail(`${file} not found: build the server first (pnpm -r build).`);
  try {
    execFileSync(process.execPath, [file], { env: { ...baseEnv('all'), APP_ROLE: 'all' }, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    if (!allowFailure) throw err;
  }
}

async function request(base, path, init = {}) {
  const res = await fetch(base + path, { redirect: 'manual', ...init });
  const body = await res.arrayBuffer();
  return { status: res.status, headers: res.headers, body: Buffer.from(body) };
}

async function waitForHealth(base, child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`exited with ${child.exitCode}`);
    try {
      const res = await request(base, '/api/health');
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error('no /api/health within 120 s');
}

/** Public pages, API and feeds, `count` requests with 8 in parallel. */
async function publicLoad(base, count) {
  const paths = ['/', '/api/public/status', '/api/public/summary', '/api/public/services', '/api/public/locations',
    '/api/public/history', '/api/public/settings', '/feed.rss', '/feed.atom'];
  const services = await request(base, '/api/public/services');
  if (services.status === 200) {
    for (const s of JSON.parse(services.body.toString()).data.slice(0, 5)) paths.push(`/api/public/services/${s.id}`);
  }
  const index = await request(base, '/');
  for (const m of index.body.toString().matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) paths.push(m[1]);
  const statuses = {};
  let next = 0;
  const workerFn = async () => {
    while (next < count) {
      const path = paths[next++ % paths.length];
      const res = await request(base, path);
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: 8 }, workerFn));
  // A few subscriptions: the public instance writes them through the database functions.
  for (let i = 0; i < 3; i++) {
    const body = { data: { type: 'subscriptions', attributes: { email: `reader-${Date.now()}-${i}@example.com` } } };
    const res = await request(base, '/api/public/subscriptions', {
      method: 'POST',
      headers: { 'content-type': JSONAPI },
      body: JSON.stringify(body),
    });
    statuses[`subscribe ${res.status}`] = (statuses[`subscribe ${res.status}`] ?? 0) + 1;
  }
  return statuses;
}

/** Login, the main admin lists, and the polled source (created once). */
async function adminLoad(base, kumaUrl) {
  const login = await request(base, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': JSONAPI },
    body: JSON.stringify({ data: { type: 'sessions', attributes: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } } }),
  });
  if (login.status !== 200) throw new Error(`admin login failed with ${login.status}`);
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const headers = { cookie, 'x-requested-with': 'openstatuspage', 'content-type': JSONAPI };
  for (const path of ['/api/admin/overview', '/api/admin/services', '/api/admin/incidents', '/api/admin/maintenances',
    '/api/admin/monitor-sources', '/api/admin/checks', '/api/admin/locations', '/api/admin/audit-log', '/api/admin/settings']) {
    for (let i = 0; i < 5; i++) await request(base, path, { headers });
  }
  // Subscriptions on, so the public load also queues confirmation mails (MAIL_TRANSPORT=log).
  const settings = await request(base, '/api/admin/settings', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ data: { type: 'settings', attributes: { emailSubscriptionsEnabled: true } } }),
  });
  if (settings.status !== 200) log(`enabling subscriptions failed with ${settings.status}: ${settings.body}`);
  const sources = JSON.parse((await request(base, '/api/admin/monitor-sources', { headers })).body.toString());
  if (!sources.data.some((s) => s.attributes.name === SOURCE_NAME)) {
    const res = await request(base, '/api/admin/monitor-sources', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        data: {
          type: 'monitor-sources',
          attributes: {
            name: SOURCE_NAME,
            sourceType: 'uptimekuma',
            pollIntervalSeconds: 10,
            config: { baseUrl: kumaUrl, apiKey: 'fake-api-key', verifyTls: true },
          },
        },
      }),
    });
    if (res.status !== 201) throw new Error(`creating the polled source failed with ${res.status}: ${res.body}`);
  }
}

async function measureRole(role, kumaUrl) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [...nodeArgs, serverEntry], {
    env: { ...baseEnv(role), PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-4000);
    if (opts.verbose) process.stderr.write(d);
  });
  let peak = 0;
  const sampler = setInterval(() => {
    try {
      peak = Math.max(peak, memoryOf(child.pid).rss);
    } catch {
      // process gone
    }
  }, 100);
  try {
    await waitForHealth(base, child);
    await sleep(3000);
    const started = memoryOf(child.pid);
    const startup = started.rss;
    peak = startup;
    const load = {};
    const features = { public: ['public'], admin: ['admin', 'public'], worker: ['poll'], all: ['admin', 'public', 'poll'] }[role];
    if (features.includes('admin')) await adminLoad(base, kumaUrl);
    if (features.includes('public')) load.public = await publicLoad(base, requests);
    if (features.includes('poll')) await sleep(pollSeconds * 1000);
    await sleep(settleSeconds * 1000);
    const mem = memoryOf(child.pid);
    return { role, startup, peak: Math.max(peak, mem.rss), after: mem.rss, hwm: mem.hwm, startupAnon: started.anon, anon: mem.anon, load };
  } catch (err) {
    throw new Error(`${role}: ${err.message}\n${stderr}`);
  } finally {
    clearInterval(sampler);
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  }
}

const mb = (kib) => (Number.isFinite(kib) ? `${(kib / 1024).toFixed(1)} MB` : 'n/a');

log(`node ${process.version}, ${serverEntry}`);
log('migrating and seeding the database ...');
runCli('migrate');
runCli('seed', { allowFailure: true }); // refuses an already seeded database
const kuma = await startFakeKuma();
const kumaUrl = `http://127.0.0.1:${kuma.address().port}`;
const results = [];
for (const role of roles) {
  log(`measuring ${role} ...`);
  results.push(await measureRole(role, kumaUrl));
}
kuma.close();

if (opts.json) {
  console.log(JSON.stringify({ node: process.version, nodeArgs, results }, null, 2));
} else {
  console.log(`Node ${process.version}${nodeArgs.length ? ` ${nodeArgs.join(' ')}` : ''}`);
  console.log('| Role | After start | Peak under load | After load | Kernel peak (VmHWM) | Anonymous after start / load |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    const anon = `${mb(r.startupAnon)} / ${mb(r.anon)}`;
    console.log(`| ${r.role} | ${mb(r.startup)} | ${mb(r.peak)} | ${mb(r.after)} | ${mb(r.hwm)} | ${anon} |`);
  }
  for (const r of results) if (r.load.public) log(`${r.role} responses: ${JSON.stringify(r.load.public)}`);
}

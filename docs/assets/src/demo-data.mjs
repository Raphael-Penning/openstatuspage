// Adds a "live" state on top of the seeded demo data (pnpm db:seed) so the
// README media show mixed states and an ongoing incident:
//   - two monitoring checks report problems through the demo webhook source
//   - an incident with two updates affects the Public API
//
// Usage (server running on BASE_URL, seeded database, first admin from
// ADMIN_EMAIL / ADMIN_PASSWORD):
//   BASE_URL=http://localhost:3123 ADMIN_EMAIL=… ADMIN_PASSWORD=… \
//   SOURCE_ID=<demo webhook source id> INGEST_TOKEN=<demo ingest token> \
//   node docs/assets/src/demo-data.mjs
// SOURCE_ID and INGEST_TOKEN are printed once by pnpm db:seed.

const base = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};
const JSONAPI = 'application/vnd.api+json';

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'X-Requested-With': 'openstatuspage', ...headers, ...(body ? { 'Content-Type': JSONAPI } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return { res, json: res.status === 204 ? null : await res.json() };
}

// 1. Monitoring results through the demo webhook source.
const ingest = await fetch(`${base}/api/ingest/${need('SOURCE_ID')}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${need('INGEST_TOKEN')}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    checks: [
      { id: 'api-fra!http', name: 'API health', host: 'api-fra', state: 'warning', output: 'p95 latency 2.4 s (threshold 1 s)' },
      { id: 'docs!https', name: 'HTTPS', host: 'docs', state: 'critical', output: 'HTTP 502 from upstream' },
    ],
  }),
});
if (!ingest.ok) throw new Error(`ingest: ${ingest.status} ${await ingest.text()}`);

// 2. Sign in as the first admin.
const { res: login } = await call('/api/auth/login', {
  method: 'POST',
  body: { data: { type: 'sessions', attributes: { email: need('ADMIN_EMAIL'), password: need('ADMIN_PASSWORD') } } },
});
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const auth = { Cookie: cookie };

// 3. An ongoing incident with an update.
const { json: services } = await call('/api/public/services');
const api = services.data.find((s) => s.attributes.slug === 'public-api');
if (!api) throw new Error('service public-api not found: seed the database first');
const startedAt = new Date(Date.now() - 42 * 60_000).toISOString();
const { json: created } = await call('/api/admin/incidents', {
  method: 'POST',
  headers: auth,
  body: {
    data: {
      type: 'incidents',
      attributes: {
        title: 'Slow responses from the Public API',
        impact: 'minor',
        startedAt,
        message: 'Some API requests take several seconds to complete. We are investigating.',
        affectedServices: [{ serviceId: api.id, status: 'degraded' }],
      },
    },
  },
});
await call(`/api/admin/incidents/${created.data.id}/updates`, {
  method: 'POST',
  headers: auth,
  body: {
    data: {
      type: 'incident-updates',
      attributes: {
        status: 'identified',
        message: 'An overloaded database replica in Frankfurt is the cause. We are adding capacity and moving traffic to healthy replicas.',
        notify: false,
      },
    },
  },
});

console.log(`Live demo state added (incident ${created.data.id}).`);

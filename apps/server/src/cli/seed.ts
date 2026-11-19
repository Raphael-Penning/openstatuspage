/**
 * Fills an EMPTY database with fictional demo data (locations, services,
 * checks, incidents, maintenance, status history). Refuses to run when
 * services already exist.
 */
import type { CheckState, ImpactStatus, ServiceStatus } from '@openstatuspage/shared';
import { loadConfig } from '../config.js';
import { createDb, migrateToLatest } from '../db/index.js';
import { SecretBox, sha256 } from '../lib/crypto.js';
import { newId, newToken } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { StatusEngine } from '../services/status-engine.js';
import { saveSettings, DEFAULT_SETTINGS } from '../services/settings.js';
import { recordCheckState } from '../services/check-history.js';

// Demo data is meant for development; a real SECRET_KEY is still used when set.
process.env.NODE_ENV ??= 'development';
const config = loadConfig();
const db = await createDb(config);
await migrateToLatest(db);

const existing = await db.selectFrom('services').select('id').limit(1).executeTakeFirst();
if (existing) {
  console.error('Database already contains services, refusing to seed.');
  process.exit(1);
}

const now = new Date();
const iso = (d: Date) => d.toISOString();
const daysAgo = (n: number, h = 0) => new Date(now.getTime() - n * 86400000 - h * 3600000);
const ts = nowIso();

await saveSettings(db, {
  ...DEFAULT_SETTINGS,
  siteName: 'Example Corp',
  description: 'Current status of Example Corp services.',
  footerLinks: [{ label: 'Website', url: 'https://example.com' }],
});

// Locations ---------------------------------------------------------------
const locations = [
  { code: 'FRA-1', name: 'Frankfurt', city: 'Frankfurt am Main', country: 'DE', region: 'europe', lat: 50.11, lon: 8.68 },
  { code: 'AMS-1', name: 'Amsterdam', city: 'Amsterdam', country: 'NL', region: 'europe', lat: 52.37, lon: 4.9 },
  { code: 'LHR-1', name: 'London', city: 'London', country: 'GB', region: 'europe', lat: 51.51, lon: -0.13 },
  { code: 'NYC-1', name: 'New York', city: 'New York', country: 'US', region: 'north_america', lat: 40.71, lon: -74.0 },
  { code: 'SIN-1', name: 'Singapore', city: 'Singapore', country: 'SG', region: 'asia', lat: 1.35, lon: 103.82 },
  { code: 'SYD-1', name: 'Sydney', city: 'Sydney', country: 'AU', region: 'oceania', lat: -33.87, lon: 151.21 },
] as const;
const locationIds: Record<string, string> = {};
for (const [i, l] of locations.entries()) {
  const id = newId();
  locationIds[l.code] = id;
  await db
    .insertInto('locations')
    .values({
      id,
      slug: l.code.toLowerCase(),
      name: l.name,
      code: l.code,
      city: l.city,
      country: l.country,
      region: l.region,
      latitude: l.lat,
      longitude: l.lon,
      description: null,
      sort_order: i,
      is_public: 1,
      status_override: null,
      created_at: ts,
      updated_at: ts,
    })
    .execute();
}

// Groups & services ---------------------------------------------------------
const groups = [
  { slug: 'platform', name: 'Platform', services: ['Web Application', 'Public API', 'Authentication'] },
  { slug: 'network', name: 'Network', services: ['CDN', 'DNS'] },
  { slug: 'sites', name: 'Websites', services: ['Marketing Website', 'Documentation'] },
];
const serviceIds: Record<string, string> = {};
for (const [gi, g] of groups.entries()) {
  const groupId = newId();
  await db
    .insertInto('service_groups')
    .values({
      id: groupId,
      slug: g.slug,
      name: g.name,
      description: null,
      sort_order: gi,
      is_public: 1,
      collapsed_by_default: 0,
      created_at: ts,
      updated_at: ts,
    })
    .execute();
  for (const [si, name] of g.services.entries()) {
    const id = newId();
    serviceIds[name] = id;
    const isSite = g.slug === 'sites';
    await db
      .insertInto('services')
      .values({
        id,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name,
        description: null,
        kind: isSite ? 'site' : 'service',
        url: isSite ? `https://${name === 'Documentation' ? 'docs.' : 'www.'}example.com` : null,
        group_id: groupId,
        sort_order: si,
        is_public: 1,
        status_mode: 'auto',
        manual_status: 'operational',
        aggregation: name === 'CDN' ? 'quorum' : 'worst',
        current_status: 'operational',
        monitor_status: 'operational',
        status_changed_at: null,
        created_at: iso(daysAgo(120)),
        updated_at: ts,
      })
      .execute();
    for (const code of name === 'CDN' || name === 'DNS'
      ? Object.keys(locationIds)
      : ['FRA-1', 'AMS-1', 'NYC-1']) {
      await db.insertInto('service_locations').values({ service_id: id, location_id: locationIds[code]! }).execute();
    }
  }
}

// Monitoring source with demo checks ------------------------------------------
const sourceId = newId();
const ingestToken = newToken();
await db
  .insertInto('monitor_sources')
  .values({
    id: sourceId,
    name: 'Demo webhook',
    type: 'webhook',
    enabled: 1,
    config_encrypted: new SecretBox(config.SECRET_KEY).encryptJson({}),
    poll_interval_seconds: 60,
    ingest_token_hash: sha256(ingestToken),
    last_poll_at: null,
    last_poll_ok: null,
    last_error: null,
    created_at: ts,
    updated_at: ts,
  })
  .execute();

const checks: { ext: string; host: string; name: string; state: CheckState; services: [string, ImpactStatus][] }[] = [
  { ext: 'web-fra!https', host: 'web-fra', name: 'HTTPS', state: 'ok', services: [['Web Application', 'major_outage']] },
  { ext: 'web-ams!https', host: 'web-ams', name: 'HTTPS', state: 'ok', services: [['Web Application', 'major_outage']] },
  { ext: 'api-fra!http', host: 'api-fra', name: 'API health', state: 'ok', services: [['Public API', 'major_outage']] },
  { ext: 'auth!login', host: 'auth-1', name: 'Login flow', state: 'ok', services: [['Authentication', 'major_outage']] },
  ...Object.keys(locationIds).map((code) => ({
    ext: `edge-${code}!http`,
    host: `edge-${code.toLowerCase()}`,
    name: 'Edge HTTP',
    state: 'ok' as CheckState,
    services: [['CDN', 'major_outage']] as [string, ImpactStatus][],
  })),
  { ext: 'ns1!dns', host: 'ns1', name: 'DNS', state: 'ok', services: [['DNS', 'major_outage']] },
  { ext: 'ns2!dns', host: 'ns2', name: 'DNS', state: 'ok', services: [['DNS', 'major_outage']] },
  { ext: 'www!https', host: 'www', name: 'HTTPS', state: 'ok', services: [['Marketing Website', 'major_outage']] },
  { ext: 'docs!https', host: 'docs', name: 'HTTPS', state: 'ok', services: [['Documentation', 'partial_outage']] },
];
for (const c of checks) {
  const id = newId();
  await db
    .insertInto('monitor_checks')
    .values({
      id,
      source_id: sourceId,
      external_id: c.ext,
      name: c.name,
      host: c.host,
      state: c.state,
      output: 'OK',
      last_check_at: ts,
      last_state_change_at: ts,
      created_at: ts,
      updated_at: ts,
    })
    .execute();
  await recordCheckState(db, id, c.state, ts);
  for (const [service, critical] of c.services) {
    await db
      .insertInto('service_checks')
      .values({
        service_id: serviceIds[service]!,
        check_id: id,
        warning_status: 'degraded',
        critical_status: critical,
        unknown_status: null,
      })
      .execute();
  }
}

// Historical status segments for nicer uptime bars ---------------------------
const history: [string, ServiceStatus, number, number][] = [
  // service, status, start days ago, duration hours
  ['Public API', 'degraded', 23, 3],
  ['Public API', 'partial_outage', 9, 1],
  ['CDN', 'partial_outage', 41, 2],
  ['Authentication', 'major_outage', 15, 0.75],
  ['Documentation', 'maintenance', 30, 4],
];
for (const name of Object.keys(serviceIds)) {
  const sid = serviceIds[name]!;
  const events = history.filter((h) => h[0] === name).sort((a, b) => b[2] - a[2]);
  let cursor = daysAgo(120);
  for (const [, status, ago, hours] of events) {
    const start = daysAgo(ago);
    const end = new Date(start.getTime() + hours * 3600000);
    await db.insertInto('service_status_history').values({ id: newId(), service_id: sid, status: 'operational', started_at: iso(cursor), ended_at: iso(start) }).execute();
    await db.insertInto('service_status_history').values({ id: newId(), service_id: sid, status, started_at: iso(start), ended_at: iso(end) }).execute();
    cursor = end;
  }
  await db.insertInto('service_status_history').values({ id: newId(), service_id: sid, status: 'operational', started_at: iso(cursor), ended_at: null }).execute();
}

// Incidents ----------------------------------------------------------------
async function incident(title: string, started: Date, resolved: Date | null, service: string, impact: ImpactStatus, updates: [string, string, Date][]) {
  const id = newId();
  await db
    .insertInto('incidents')
    .values({
      id,
      title,
      status: resolved ? 'resolved' : (updates.at(-1)![0] as 'investigating'),
      impact: impact === 'major_outage' ? 'major' : 'minor',
      is_public: 1,
      source: 'manual',
      started_at: iso(started),
      resolved_at: resolved ? iso(resolved) : null,
      created_by: null,
      created_at: iso(started),
      updated_at: iso(updates.at(-1)![2]),
    })
    .execute();
  await db.insertInto('incident_services').values({ incident_id: id, service_id: serviceIds[service]!, status: impact }).execute();
  await db.insertInto('incident_locations').values({ incident_id: id, location_id: locationIds['FRA-1']! }).execute();
  for (const [status, message, at] of updates) {
    await db
      .insertInto('incident_updates')
      .values({ id: newId(), incident_id: id, status: status as 'investigating', message, created_by: null, created_at: iso(at) })
      .execute();
  }
}
await incident('Elevated API error rates', daysAgo(9), daysAgo(9, -1), 'Public API', 'partial_outage', [
  ['investigating', 'We are investigating elevated error rates on the public API.', daysAgo(9)],
  ['identified', 'A faulty configuration change was identified and is being rolled back.', daysAgo(9, -0.5)],
  ['resolved', 'The rollback is complete and error rates are back to normal.', daysAgo(9, -1)],
]);
await incident('Login failures for some users', daysAgo(15), daysAgo(15, -0.75), 'Authentication', 'major_outage', [
  ['investigating', 'Some users are unable to log in. We are looking into it.', daysAgo(15)],
  ['resolved', 'Logins are working again.', daysAgo(15, -0.75)],
]);

// Maintenance ---------------------------------------------------------------
async function maintenance(title: string, start: Date, hours: number, services: string[], status: 'scheduled' | 'completed') {
  const id = newId();
  const end = new Date(start.getTime() + hours * 3600000);
  await db
    .insertInto('maintenances')
    .values({
      id,
      title,
      description: 'Planned infrastructure work. Short interruptions may occur.',
      status,
      scheduled_start: iso(start),
      scheduled_end: iso(end),
      actual_start: status === 'completed' ? iso(start) : null,
      actual_end: status === 'completed' ? iso(end) : null,
      auto_start: 1,
      auto_complete: 1,
      is_public: 1,
      notify_subscribers: 1,
      reminder_sent_at: null,
      created_by: null,
      created_at: ts,
      updated_at: ts,
    })
    .execute();
  for (const s of services) {
    await db.insertInto('maintenance_services').values({ maintenance_id: id, service_id: serviceIds[s]! }).execute();
  }
  await db.insertInto('maintenance_locations').values({ maintenance_id: id, location_id: locationIds['AMS-1']! }).execute();
}
await maintenance('Database upgrade', daysAgo(-3), 2, ['Web Application', 'Public API'], 'scheduled');
await maintenance('Documentation platform migration', daysAgo(30), 4, ['Documentation'], 'completed');

await new StatusEngine(db).recomputeAll();
await db.destroy();

console.log('Demo data created.');
console.log(`Demo webhook source id: ${sourceId}`);
console.log(`Demo webhook ingest token (shown once): ${ingestToken}`);

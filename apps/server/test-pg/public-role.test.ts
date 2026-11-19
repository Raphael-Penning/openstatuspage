/**
 * The restricted PostgreSQL role of APP_ROLE=public (migration 0007_public_role,
 * docs/security-model.md). Every query of the "public" connection runs AS that role,
 * with search_path=osp_public like a public instance.
 */
import { JSONAPI_MEDIA_TYPE, toRequestDocument } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { DB } from '../src/db/index.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import { prepareDatabase } from '../src/startup.js';
import {
  subscriptionToken,
  subscriptionTokenHashes,
  tokenHash,
} from '../src/services/subscriptions.js';
import { BASE_URL, createTestDatabase, SECRET_KEY, type PgTestDatabase } from './setup.js';

const NOW = new Date().toISOString();
const HOUR_AGO = new Date(Date.now() - 3600_000).toISOString();

let pgdb: PgTestDatabase;
/** Owner connection (admin/worker). */
let owner: DB;
/** Public role connection (search_path osp_public). */
let pub: DB;
const logs: { msg: string; obj: object }[] = [];
const log = { info: (obj: object, msg: string) => logs.push({ obj, msg }), warn: (obj: object, msg: string) => logs.push({ obj, msg: `WARN ${msg}` }) };

const ids = {
  group: 'grp-public',
  hiddenGroup: 'grp-hidden',
  service: 'svc-public',
  serviceInHiddenGroup: 'svc-public-hidden-group',
  hiddenService: 'svc-hidden',
  location: 'loc-public',
  hiddenLocation: 'loc-hidden',
  incident: 'inc-public',
  hiddenIncident: 'inc-hidden',
  maintenance: 'mnt-public',
  hiddenMaintenance: 'mnt-hidden',
  correction: 'cor-public',
  hiddenCorrection: 'cor-hidden',
  user: 'usr-1',
  source: 'src-1',
  check: 'chk-1',
  subscriber: 'sub-existing',
};

async function seed(db: DB): Promise<void> {
  const ts = { created_at: NOW, updated_at: NOW };
  await db
    .insertInto('settings')
    .values([
      { key: 'page', value: JSON.stringify({ siteName: 'Example Status', emailSubscriptionsEnabled: true }), updated_at: NOW },
      { key: 'internal', value: JSON.stringify({ secret: 'do-not-leak' }), updated_at: NOW },
    ])
    .execute();
  await db
    .insertInto('service_groups')
    .values([
      { id: ids.group, slug: 'core', name: 'Core', description: null, sort_order: 0, is_public: 1, collapsed_by_default: 0, ...ts },
      { id: ids.hiddenGroup, slug: 'internal', name: 'Internal group', description: null, sort_order: 1, is_public: 0, collapsed_by_default: 0, ...ts },
    ])
    .execute();
  const service = (id: string, name: string, isPublic: number, groupId: string | null) => ({
    id,
    slug: id,
    name,
    description: null,
    kind: 'service' as const,
    url: null,
    group_id: groupId,
    sort_order: 0,
    is_public: isPublic,
    status_mode: 'auto' as const,
    manual_status: 'operational' as const,
    aggregation: 'worst' as const,
    current_status: 'operational' as const,
    monitor_status: 'operational' as const,
    status_changed_at: null,
    ...ts,
  });
  await db
    .insertInto('services')
    .values([
      service(ids.service, 'Public API', 1, ids.group),
      service(ids.serviceInHiddenGroup, 'Website', 1, ids.hiddenGroup),
      service(ids.hiddenService, 'Hidden backend', 0, null),
    ] as never)
    .execute();
  const location = (id: string, isPublic: number) => ({
    id,
    slug: id,
    name: id,
    code: null,
    city: null,
    country: null,
    region: 'europe' as const,
    latitude: null,
    longitude: null,
    description: null,
    sort_order: 0,
    is_public: isPublic,
    status_override: null,
    ...ts,
  });
  await db.insertInto('locations').values([location(ids.location, 1), location(ids.hiddenLocation, 0)] as never).execute();
  await db
    .insertInto('service_locations')
    .values([
      { service_id: ids.service, location_id: ids.location },
      { service_id: ids.service, location_id: ids.hiddenLocation },
      { service_id: ids.hiddenService, location_id: ids.location },
    ])
    .execute();
  await db
    .insertInto('service_status_history')
    .values([
      { id: 'h1', service_id: ids.service, status: 'operational', started_at: HOUR_AGO, ended_at: null, source: 'live' },
      { id: 'h2', service_id: ids.hiddenService, status: 'major_outage', started_at: HOUR_AGO, ended_at: null, source: 'live' },
    ])
    .execute();

  await db
    .insertInto('users')
    .values({
      id: ids.user,
      email: 'admin@example.com',
      name: 'Admin',
      role: 'admin',
      password_hash: 'argon2-hash',
      oidc_subject: null,
      created_at: NOW,
      updated_at: NOW,
      last_login_at: null,
    })
    .execute();
  await db
    .insertInto('sessions')
    .values({ id: 'session-hash', user_id: ids.user, created_at: NOW, expires_at: NOW, ip: '192.0.2.1', user_agent: null })
    .execute();
  await db
    .insertInto('api_tokens')
    .values({ id: 'tok-1', name: 'ci', role: 'admin', token_hash: 'token-hash', created_by: ids.user, created_at: NOW, last_used_at: null })
    .execute();
  await db
    .insertInto('audit_log')
    .values({ id: 'aud-1', user_id: ids.user, action: 'login', entity_type: 'user', entity_id: ids.user, details: null, created_at: NOW })
    .execute();
  await db
    .insertInto('monitor_sources')
    .values({
      id: ids.source,
      name: 'Icinga',
      type: 'webhook',
      enabled: 1,
      config_encrypted: 'encrypted-config',
      poll_interval_seconds: 60,
      ingest_token_hash: 'ingest-hash',
      last_poll_at: null,
      last_poll_ok: null,
      last_error: null,
      ...ts,
    })
    .execute();
  await db
    .insertInto('monitor_checks')
    .values({
      id: ids.check,
      source_id: ids.source,
      external_id: 'db01!postgres',
      name: 'postgres',
      host: 'db01.internal',
      state: 'ok',
      output: 'internal output',
      last_check_at: null,
      last_state_change_at: null,
      ...ts,
    })
    .execute();

  const incident = (id: string, isPublic: number) => ({
    id,
    title: `Incident ${id}`,
    status: 'investigating' as const,
    impact: 'minor' as const,
    is_public: isPublic,
    source: 'manual' as const,
    started_at: HOUR_AGO,
    resolved_at: null,
    created_by: ids.user,
    ...ts,
  });
  await db.insertInto('incidents').values([incident(ids.incident, 1), incident(ids.hiddenIncident, 0)]).execute();
  await db
    .insertInto('incident_updates')
    .values([
      { id: 'iu1', incident_id: ids.incident, status: 'investigating', message: 'Public message', created_by: ids.user, created_at: NOW },
      { id: 'iu2', incident_id: ids.hiddenIncident, status: 'investigating', message: 'Secret message', created_by: ids.user, created_at: NOW },
    ])
    .execute();
  await db
    .insertInto('incident_services')
    .values([
      { incident_id: ids.incident, service_id: ids.service, status: 'degraded_performance' },
      { incident_id: ids.incident, service_id: ids.hiddenService, status: 'major_outage' },
      { incident_id: ids.hiddenIncident, service_id: ids.service, status: 'major_outage' },
    ] as never)
    .execute();
  await db
    .insertInto('incident_locations')
    .values([
      { incident_id: ids.incident, location_id: ids.location },
      { incident_id: ids.incident, location_id: ids.hiddenLocation },
    ])
    .execute();

  const maintenance = (id: string, isPublic: number) => ({
    id,
    title: `Maintenance ${id}`,
    description: 'Planned work',
    status: 'scheduled' as const,
    scheduled_start: NOW,
    scheduled_end: NOW,
    actual_start: null,
    actual_end: null,
    auto_start: 1,
    auto_complete: 1,
    is_public: isPublic,
    notify_subscribers: 1,
    reminder_sent_at: null,
    retroactive: 0,
    created_by: ids.user,
    ...ts,
  });
  await db.insertInto('maintenances').values([maintenance(ids.maintenance, 1), maintenance(ids.hiddenMaintenance, 0)]).execute();
  await db
    .insertInto('maintenance_updates')
    .values([
      { id: 'mu1', maintenance_id: ids.maintenance, status: 'scheduled', message: 'Public', created_by: ids.user, created_at: NOW },
      { id: 'mu2', maintenance_id: ids.hiddenMaintenance, status: 'scheduled', message: 'Secret', created_by: ids.user, created_at: NOW },
    ])
    .execute();
  await db
    .insertInto('maintenance_services')
    .values([
      { maintenance_id: ids.maintenance, service_id: ids.service },
      { maintenance_id: ids.maintenance, service_id: ids.hiddenService },
      { maintenance_id: ids.hiddenMaintenance, service_id: ids.service },
    ])
    .execute();

  await db
    .insertInto('status_corrections')
    .values([
      {
        id: ids.correction,
        starts_at: HOUR_AGO,
        ends_at: NOW,
        status: 'operational',
        reason: 'Internal reason: monitoring broke',
        show_public: 0,
        public_note: 'Not meant to be shown',
        created_by: ids.user,
        ...ts,
      },
      {
        id: ids.hiddenCorrection,
        starts_at: HOUR_AGO,
        ends_at: NOW,
        status: 'operational',
        reason: 'Hidden service only',
        show_public: 1,
        public_note: 'Hidden note',
        created_by: ids.user,
        ...ts,
      },
    ])
    .execute();
  await db
    .insertInto('status_correction_services')
    .values([
      { correction_id: ids.correction, service_id: ids.service },
      { correction_id: ids.hiddenCorrection, service_id: ids.hiddenService },
    ])
    .execute();

  const salt = 'existing-subscriber-salt';
  await db
    .insertInto('subscribers')
    .values({
      id: ids.subscriber,
      email: 'existing@example.com',
      locale: 'en',
      all_services: 1,
      token_salt: salt,
      confirmed_at: NOW,
      confirmation_sent_at: null,
      ...ts,
      ...subscriptionTokenHashes(SECRET_KEY, { id: ids.subscriber, token_salt: salt }),
    })
    .execute();
}

/** Runs `query` as the public role and returns the PostgreSQL error code (or 'ok'). */
async function attempt(query: string): Promise<string> {
  try {
    await sql.raw(query).execute(pub);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

const rows = async <T = Record<string, unknown>>(query: string) => (await sql.raw<T>(query).execute(pub)).rows;
const ownerRows = async <T = Record<string, unknown>>(query: string) => (await sql.raw<T>(query).execute(owner)).rows;

beforeAll(async () => {
  pgdb = await createTestDatabase();
  owner = await pgdb.connect('admin');
  // Like the start of an admin instance: migrate, then grant the public role.
  await prepareDatabase(owner, pgdb.config('admin'), log);
  await seed(owner);
  pub = await pgdb.connect('public');
}, 60_000);

afterAll(async () => {
  await pub?.destroy();
  await owner?.destroy();
  await pgdb?.drop();
});

describe('start-up', () => {
  it('grants the public role when an admin instance starts', () => {
    expect(logs).toContainEqual({ msg: 'public database role granted', obj: { role: pgdb.publicRole, granted: true } });
  });

  it('lets a public instance see the expected schema through its views and confirms it is restricted', async () => {
    logs.length = 0;
    await prepareDatabase(pub, pgdb.config('public'), log);
    expect(logs.filter((l) => l.msg.startsWith('WARN'))).toEqual([]);
    const { restricted } = (await rows<{ restricted: boolean }>('select osp_public.connection_restricted() as restricted'))[0]!;
    expect(restricted).toBe(true);
    const { user, path } = (await rows<{ user: string; path: string }>('select current_user as user, current_setting(\'search_path\') as path'))[0]!;
    expect(user).toBe(pgdb.publicRole);
    expect(path).toBe('osp_public');
  });

  it('grants idempotently and refuses roles that would not be restricted', async () => {
    await sql`select osp_grant_public_role(${pgdb.publicRole})`.execute(owner);
    const { granted } = (await sql<{ granted: boolean }>`select osp_grant_public_role('osp_no_such_role') as granted`.execute(owner)).rows[0]!;
    expect(granted).toBe(false);
    await expect(sql`select osp_grant_public_role(current_user::text)`.execute(owner)).rejects.toThrow(/must be a separate login/);
  });
});

describe('views of the public role', () => {
  it('return only public services, groups and locations', async () => {
    const services = await rows<{ id: string; group_id: string | null }>('select id, group_id from services order by id');
    expect(services).toEqual([
      { id: ids.service, group_id: ids.group },
      // A hidden group is not revealed.
      { id: ids.serviceInHiddenGroup, group_id: null },
    ]);
    expect((await rows('select id from service_groups')).map((r) => r.id)).toEqual([ids.group]);
    expect((await rows('select id from locations')).map((r) => r.id)).toEqual([ids.location]);
    expect(await rows('select service_id, location_id from service_locations')).toEqual([
      { service_id: ids.service, location_id: ids.location },
    ]);
    expect((await rows('select service_id from service_status_history')).map((r) => r.service_id)).toEqual([ids.service]);
  });

  it('expose only public columns', async () => {
    const columns = async (table: string) =>
      (
        await ownerRows<{ column_name: string }>(
          `select column_name from information_schema.columns where table_schema = 'osp_public' and table_name = '${table}'`,
        )
      ).map((r) => r.column_name);
    expect(await columns('services')).not.toEqual(expect.arrayContaining(['status_mode']));
    for (const hidden of ['status_mode', 'manual_status', 'aggregation', 'monitor_status']) {
      expect(await columns('services')).not.toContain(hidden);
    }
    expect(await columns('incidents')).not.toContain('created_by');
    expect(await columns('incident_updates')).not.toContain('created_by');
    for (const hidden of ['created_by', 'notify_subscribers', 'reminder_sent_at', 'auto_start']) {
      expect(await columns('maintenances')).not.toContain(hidden);
    }
    expect(await columns('status_corrections')).not.toContain('reason');
    expect(await columns('status_corrections')).not.toContain('created_by');
    // Nothing else exists in the schema of the public role.
    const tables = (
      await ownerRows<{ table_name: string; table_type: string }>(
        `select table_name, table_type from information_schema.tables where table_schema = 'osp_public'`,
      )
    ).map((r) => r.table_type);
    expect(new Set(tables)).toEqual(new Set(['VIEW']));
  });

  it('return only public incidents, maintenance and their public relations', async () => {
    expect((await rows('select id from incidents')).map((r) => r.id)).toEqual([ids.incident]);
    expect((await rows('select message from incident_updates')).map((r) => r.message)).toEqual(['Public message']);
    expect(await rows('select incident_id, service_id from incident_services')).toEqual([
      { incident_id: ids.incident, service_id: ids.service },
    ]);
    expect(await rows('select incident_id, location_id from incident_locations')).toEqual([
      { incident_id: ids.incident, location_id: ids.location },
    ]);
    expect((await rows('select id from maintenances')).map((r) => r.id)).toEqual([ids.maintenance]);
    expect((await rows('select message from maintenance_updates')).map((r) => r.message)).toEqual(['Public']);
    expect(await rows('select maintenance_id, service_id from maintenance_services')).toEqual([
      { maintenance_id: ids.maintenance, service_id: ids.service },
    ]);
  });

  it('return corrections of public services without internal reason and unpublished notes', async () => {
    expect(await rows('select id, public_note from status_corrections')).toEqual([{ id: ids.correction, public_note: null }]);
    expect((await rows('select correction_id from status_correction_services')).map((r) => r.correction_id)).toEqual([
      ids.correction,
    ]);
  });

  it('return only the page settings', async () => {
    expect((await rows('select key from settings')).map((r) => r.key)).toEqual(['page']);
  });
});

describe('tables', () => {
  const PRIVATE = [
    'users',
    'sessions',
    'api_tokens',
    'audit_log',
    'subscribers',
    'subscriber_services',
    'email_outbox',
    'monitor_sources',
    'monitor_checks',
    'monitor_check_history',
    'service_checks',
    'check_bundles',
    'check_bundle_members',
    'history_imports',
    'history_import_intervals',
    'osp_public_roles',
  ];

  it('without public data are not readable at all', async () => {
    for (const table of PRIVATE) {
      expect(await attempt(`select * from public.${table}`), table).toBe('42501');
      expect(await attempt(`select count(*) from public.${table}`), table).toBe('42501');
    }
  });

  it('with public data are not readable as a whole, nor their internal columns', async () => {
    for (const table of ['services', 'incidents', 'maintenances', 'status_corrections', 'settings', 'service_groups']) {
      // settings and service_groups have no internal column, but are still limited to public rows below.
      const expected = ['settings', 'service_groups'].includes(table) ? 'ok' : '42501';
      expect(await attempt(`select * from public.${table}`), table).toBe(expected);
    }
    expect(await attempt('select reason from public.status_corrections')).toBe('42501');
    expect(await attempt('select status_mode from public.services')).toBe('42501');
    expect(await attempt('select created_by from public.incidents')).toBe('42501');
    expect(await attempt('select notify_subscribers from public.maintenances')).toBe('42501');
  });

  it('limit the public role to public rows by row level security (defense in depth)', async () => {
    expect((await rows('select id from public.services order by id')).map((r) => r.id)).toEqual([
      ids.service,
      ids.serviceInHiddenGroup,
    ]);
    expect((await rows('select id from public.incidents')).map((r) => r.id)).toEqual([ids.incident]);
    expect((await rows('select message from public.incident_updates')).map((r) => r.message)).toEqual(['Public message']);
    expect((await rows('select key from public.settings')).map((r) => r.key)).toEqual(['page']);
    expect((await rows('select id from public.service_groups')).map((r) => r.id)).toEqual([ids.group]);
    // The owner still sees everything.
    expect(await ownerRows('select id from services')).toHaveLength(3);
  });

  it('reject every direct write', async () => {
    const writes = [
      `insert into services (id, slug, name, kind, is_public, current_status, sort_order, created_at, updated_at) values ('x', 'x', 'x', 'service', 1, 'operational', 0, '', '')`,
      `update services set name = 'pwned'`,
      `delete from incidents`,
      `insert into public.subscribers (id, email, locale, all_services, token_salt, created_at, updated_at) values ('x', 'x@example.com', 'en', 1, 's', '', '')`,
      `update public.subscribers set email = 'x@example.com'`,
      `delete from public.subscribers`,
      `insert into public.email_outbox (id, recipient, kind, subject, text_body, html_body, status, attempts, next_attempt_at, created_at) values ('x', 'x@example.com', 'confirm', 's', 't', 'h', 'pending', 0, '', '')`,
      `update public.services set name = 'pwned'`,
      `delete from public.incidents`,
      `insert into public.users (id, email, name, role, created_at, updated_at) values ('x', 'x@example.com', 'x', 'admin', '', '')`,
      `update public.settings set value = '{}'`,
      `truncate public.audit_log`,
      `insert into public.osp_public_roles values ('other')`,
      `create table osp_public.exfil (x text)`,
      `create table public.exfil (x text)`,
      `create view osp_public.exfil as select 1`,
      `create function osp_public.exfil() returns int language sql as 'select 1'`,
    ];
    for (const statement of writes) {
      expect(await attempt(statement), statement).toBe('42501');
    }
    expect(await ownerRows("select id from services where name = 'pwned'")).toEqual([]);
    expect(await ownerRows('select id from incidents')).toHaveLength(2);
  });

  it('do not let the public role call internal functions', async () => {
    for (const call of [
      `select public.osp_grant_public_role('x')`,
      `select * from public.osp_subscription_row('${ids.subscriber}')`,
      `select public.osp_queue_account_mail('${ids.subscriber}', 'attacker@example.com', 'confirm', '')`,
      `select public.osp_subscriptions_enabled()`,
    ]) {
      expect(await attempt(call), call).toBe('42501');
    }
  });
});

describe('subscription functions', () => {
  const salt = 'fresh-subscriber-salt-123';
  const id = 'sub-new';
  const hashes = subscriptionTokenHashes(SECRET_KEY, { id, token_salt: salt });
  const confirmToken = subscriptionToken(SECRET_KEY, 'confirm', id, salt);
  const manageToken = subscriptionToken(SECRET_KEY, 'manage', id, salt);

  const subscribe = (email: string, overrides: Partial<Record<string, unknown>> = {}) => {
    const p = {
      id,
      email,
      locale: 'de',
      all: false,
      services: [ids.service],
      salt,
      confirmHash: hashes.confirm_token_hash,
      manageHash: hashes.manage_token_hash,
      key: hashes.token_key,
      ...overrides,
    };
    return sql`select osp_public.subscribe(${p.id}, ${p.email}, ${p.locale}, ${p.all}, ${p.services}::text[], ${p.salt},
      ${p.confirmHash}, ${p.manageHash}, ${p.key})`.execute(pub);
  };
  const errorOf = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return 'ok';
    } catch (err) {
      return `${(err as { code?: string }).code} ${(err as Error).message}`;
    }
  };

  it('validate their input', async () => {
    expect(await errorOf(() => subscribe('not-an-email'))).toBe('22023 Invalid email');
    expect(await errorOf(() => subscribe('x'.repeat(250) + '@example.com'))).toBe('22023 Invalid email');
    expect(await errorOf(() => subscribe('jane@example.com', { locale: 'fr' }))).toBe('22023 Invalid locale');
    expect(await errorOf(() => subscribe('jane@example.com', { services: [] }))).toBe('22023 Select at least one service');
    expect(await errorOf(() => subscribe('jane@example.com', { services: [ids.hiddenService] }))).toBe('22023 Unknown service');
    expect(await errorOf(() => subscribe('jane@example.com', { services: ['no-such-service'] }))).toBe('22023 Unknown service');
    expect(await errorOf(() => subscribe('jane@example.com', { id: 'x'.repeat(65) }))).toBe('22023 Invalid id');
    expect(await errorOf(() => subscribe('jane@example.com', { id: "x'; drop table users; --" }))).toBe('22023 Invalid id');
    expect(await errorOf(() => subscribe('jane@example.com', { confirmHash: 'nope' }))).toBe('22023 Invalid token hash');
    expect(await errorOf(() => subscribe('jane@example.com', { manageHash: hashes.confirm_token_hash }))).toBe(
      '22023 Invalid token hash',
    );
    expect(await errorOf(() => subscribe('jane@example.com', { salt: 'short' }))).toBe('22023 Invalid token salt');
    expect(await ownerRows("select id from subscribers where email = 'jane@example.com'")).toEqual([]);
  });

  it('subscribe a new address and queue a confirmation mail without content', async () => {
    await subscribe('  Jane@Example.com ');
    const [sub] = await ownerRows<Record<string, unknown>>(`select * from subscribers where id = '${id}'`);
    expect(sub).toMatchObject({
      email: 'jane@example.com',
      locale: 'de',
      all_services: 0,
      token_salt: salt,
      confirmed_at: null,
      confirm_token_hash: tokenHash(confirmToken),
    });
    expect(await ownerRows(`select service_id from subscriber_services where subscriber_id = '${id}'`)).toEqual([
      { service_id: ids.service },
    ]);
    const mails = await ownerRows(`select recipient, kind, subject, text_body, html_body, status from email_outbox where subscriber_id = '${id}'`);
    expect(mails).toEqual([
      { recipient: 'jane@example.com', kind: 'confirm', subject: '', text_body: '', html_body: '', status: 'pending' },
    ]);
  });

  it('never change an existing address and throttle its mails', async () => {
    // Another id, salt and services for a known address: ignored.
    await subscribe('jane@example.com', { id: 'sub-other', all: true, services: [] });
    expect(await ownerRows(`select id, all_services from subscribers where email = 'jane@example.com'`)).toEqual([
      { id, all_services: 0 },
    ]);
    // The confirmation was just queued: no second mail.
    expect(await ownerRows(`select id from email_outbox where subscriber_id = '${id}'`)).toHaveLength(1);
    // A confirmed address gets the manage mail once the throttle has passed.
    await subscribe('existing@example.com', { id: 'sub-other-2' });
    expect(await ownerRows(`select kind from email_outbox where subscriber_id = '${ids.subscriber}'`)).toEqual([{ kind: 'manage' }]);
  });

  it('confirm only with the confirm token', async () => {
    const confirm = (token: string) => rows(`select * from osp_public.subscription_confirm('${id}', '${token}')`);
    expect(await confirm(manageToken)).toEqual([]);
    expect(await confirm('wrong')).toEqual([]);
    expect(await rows(`select * from osp_public.subscription_confirm('no-such-id', '${confirmToken}')`)).toEqual([]);
    expect(await confirm(confirmToken)).toEqual([
      {
        id,
        email: 'jane@example.com',
        locale: 'de',
        all_services: 0,
        confirmed: true,
        service_ids: [ids.service],
        token_salt: salt,
      },
    ]);
    // Idempotent.
    expect(await confirm(confirmToken)).toHaveLength(1);
    const { confirmed_at } = (await ownerRows<{ confirmed_at: string }>(`select confirmed_at from subscribers where id = '${id}'`))[0]!;
    expect(confirmed_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('read and update preferences only with the manage token and validate them', async () => {
    expect(await rows(`select * from osp_public.subscription_get('${id}', '${confirmToken}')`)).toEqual([]);
    expect(await rows(`select * from osp_public.subscription_get('${id}', '')`)).toEqual([]);
    expect(await rows(`select id from osp_public.subscription_get('${id}', '${manageToken}')`)).toEqual([{ id }]);

    const update = (token: string, locale: string, all: boolean, services: string[]) =>
      sql<Record<string, unknown>>`select * from osp_public.subscription_update(${id}, ${token}, ${locale}, ${all}, ${services}::text[])`.execute(
        pub,
      );
    expect((await update(confirmToken, 'en', true, [])).rows).toEqual([]);
    expect(await errorOf(() => update(manageToken, 'en', false, [ids.hiddenService]))).toBe('22023 Unknown service');
    expect(await errorOf(() => update(manageToken, 'xx', true, []))).toBe('22023 Invalid locale');
    expect((await update(manageToken, 'en', false, [ids.service, ids.serviceInHiddenGroup, ids.service])).rows).toEqual([
      {
        id,
        email: 'jane@example.com',
        locale: 'en',
        all_services: 0,
        confirmed: true,
        service_ids: expect.arrayContaining([ids.service, ids.serviceInHiddenGroup]),
      },
    ]);
    expect(await ownerRows(`select count(*)::int as n from subscriber_services where subscriber_id = '${id}'`)).toEqual([{ n: 2 }]);
  });

  it('unsubscribe only with the manage token', async () => {
    const del = (token: string) => rows<{ deleted: boolean }>(`select osp_public.subscription_delete('${id}', '${token}') as deleted`);
    expect(await del(confirmToken)).toEqual([{ deleted: false }]);
    expect(await del('x'.repeat(300))).toEqual([{ deleted: false }]);
    expect(await del(manageToken)).toEqual([{ deleted: true }]);
    expect(await ownerRows(`select id from subscribers where id = '${id}'`)).toEqual([]);
    expect(await del(manageToken)).toEqual([{ deleted: false }]);
  });

  it('refuse subscribing while subscriptions are disabled', async () => {
    await owner
      .updateTable('settings')
      .set({ value: JSON.stringify({ siteName: 'Example Status', emailSubscriptionsEnabled: false }) })
      .where('key', '=', 'page')
      .execute();
    expect(await errorOf(() => subscribe('late@example.com', { id: 'sub-late' }))).toBe('55000 Subscriptions are disabled');
    await owner
      .updateTable('settings')
      .set({ value: JSON.stringify({ siteName: 'Example Status', emailSubscriptionsEnabled: true }) })
      .where('key', '=', 'page')
      .execute();
  });
});

describe('a public instance', () => {
  let publicApp: FastifyInstance;
  let workerApp: FastifyInstance;
  const mailer = new MemoryMailer();
  const headers = { 'content-type': JSONAPI_MEDIA_TYPE };

  beforeAll(async () => {
    publicApp = await buildApp({ config: pgdb.config('public'), db: pub, serveWeb: false });
    // Delivers the queued mails, like a worker instance.
    workerApp = await buildApp({ config: pgdb.config('worker'), db: owner, serveWeb: false, mailer });
    await publicApp.ready();
    await workerApp.ready();
  });
  afterAll(async () => {
    await publicApp?.close();
    await workerApp?.close();
  });

  it('serves the public API from the views', async () => {
    const health = await publicApp.inject('/api/health');
    expect(health.json()).toMatchObject({ status: 'ok', role: 'public' });
    const res = await publicApp.inject('/api/public/services');
    expect(res.statusCode).toBe(200);
    const names = (res.json() as { data: { attributes: { name: string } }[] }).data.map((s) => s.attributes.name);
    expect(names.sort()).toEqual(['Public API', 'Website']);
    for (const url of ['/api/public/status', '/api/public/summary', '/api/public/history', '/api/public/locations']) {
      const r = await publicApp.inject(url);
      expect(r.statusCode, url).toBe(200);
      for (const secret of ['Secret message', ids.hiddenService, ids.hiddenIncident, ids.hiddenLocation, 'Internal reason']) {
        expect(r.body, `${url} ${secret}`).not.toContain(secret);
      }
    }
    expect((await publicApp.inject(`/api/public/incidents/${ids.incident}`)).statusCode).toBe(200);
    expect((await publicApp.inject(`/api/public/incidents/${ids.hiddenIncident}`)).statusCode).toBe(404);
    expect((await publicApp.inject(`/api/public/services/${ids.hiddenService}`)).statusCode).toBe(404);
    expect((await publicApp.inject(`/api/public/services/${ids.service}`)).statusCode).toBe(200);
  });

  it('runs the whole subscription flow through the database functions', async () => {
    const subscribe = await publicApp.inject({
      method: 'POST',
      url: '/api/public/subscriptions',
      headers,
      payload: JSON.stringify(toRequestDocument('subscriptions', { email: 'flow@example.com', locale: 'en' })),
    });
    expect(subscribe.statusCode).toBe(202);
    await publicApp.ctx.worker.idle();

    await workerApp.ctx.notifications.deliverDue();
    const mail = mailer.sent.find((m) => m.to === 'flow@example.com');
    expect(mail?.subject).toBe('[Example Status] Confirm your subscription');
    const match = new RegExp(`${BASE_URL}/subscription/confirm\\?id=([^&#\\s]+)#token=([A-Za-z0-9_-]+)`).exec(mail!.text)!;
    const [, subId, token] = match;

    const wrong = await publicApp.inject({
      method: 'POST',
      url: `/api/public/subscriptions/${subId}/confirm`,
      headers,
      payload: JSON.stringify(toRequestDocument('subscriptions', { token: 'x'.repeat(43) })),
    });
    expect(wrong.statusCode).toBe(404);
    const confirmed = await publicApp.inject({
      method: 'POST',
      url: `/api/public/subscriptions/${subId}/confirm`,
      headers,
      payload: JSON.stringify(toRequestDocument('subscriptions', { token })),
    });
    expect(confirmed.statusCode).toBe(200);
    const manageToken = (confirmed.json() as { data: { attributes: { manageToken: string; confirmed: boolean } } }).data.attributes
      .manageToken;
    expect(manageToken).toBe(subscriptionToken(SECRET_KEY, 'manage', subId!, (await ownerRows<{ token_salt: string }>(`select token_salt from subscribers where id = '${subId}'`))[0]!.token_salt));

    const manageHeaders = { 'x-subscription-token': manageToken };
    const got = await publicApp.inject({ url: `/api/public/subscriptions/${subId}`, headers: manageHeaders });
    expect(got.statusCode).toBe(200);
    expect(got.json().data.attributes).toMatchObject({ email: 'flow@example.com', confirmed: true, allServices: true });

    const patched = await publicApp.inject({
      method: 'PATCH',
      url: `/api/public/subscriptions/${subId}`,
      headers: { ...headers, ...manageHeaders },
      payload: JSON.stringify(
        toRequestDocument('subscriptions', { allServices: false, serviceIds: [ids.service] }, { id: subId, relationships: { serviceIds: 'services' } }),
      ),
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data.relationships.services.data).toEqual([{ type: 'services', id: ids.service }]);

    const hidden = await publicApp.inject({
      method: 'PATCH',
      url: `/api/public/subscriptions/${subId}`,
      headers: { ...headers, ...manageHeaders },
      payload: JSON.stringify(
        toRequestDocument('subscriptions', { allServices: false, serviceIds: [ids.hiddenService] }, { id: subId, relationships: { serviceIds: 'services' } }),
      ),
    });
    expect(hidden.statusCode).toBe(400);

    const redirect = await publicApp.inject({ url: `/api/public/subscriptions/${subId}/unsubscribe?token=${manageToken}` });
    expect(redirect.statusCode).toBe(303);
    expect(redirect.headers.location).toBe(`${BASE_URL}/subscription/manage?id=${subId}&unsubscribe=1#token=${manageToken}`);

    const deleted = await publicApp.inject({ method: 'DELETE', url: `/api/public/subscriptions/${subId}`, headers: manageHeaders });
    expect(deleted.statusCode).toBe(204);
    const again = await publicApp.inject({ method: 'DELETE', url: `/api/public/subscriptions/${subId}`, headers: manageHeaders });
    expect(again.statusCode).toBe(404);
    expect(await ownerRows(`select id from subscribers where id = '${subId}'`)).toEqual([]);
  });
});

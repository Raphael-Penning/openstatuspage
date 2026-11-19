/**
 * Loaders and serializers for the admin API (services, groups, locations,
 * monitoring sources and checks).
 */
import {
  SECRET_MASK,
  locationStatus,
  type AdminLocation,
  type AdminMonitorCheck,
  type AdminMonitorSource,
  type AdminService,
  type AdminServiceGroup,
  type CheckState,
} from '@openstatuspage/shared';
import { sql } from 'kysely';
import type { DB } from '../db/index.js';
import type { MonitorSource, ServiceGroup } from '../db/types.js';
import type { SecretBox } from '../lib/crypto.js';

/** Config keys holding credentials. They are masked in responses and never logged. */
export const SECRET_FIELDS = ['password', 'apiKey', 'historyPassword', 'icingaDbUrl'] as const;
/** Secrets that carry their own target (a connection string) and may be kept when the base URL changes. */
export const SELF_CONTAINED_SECRETS: readonly string[] = ['icingaDbUrl'];

export function toAdminGroup(g: ServiceGroup): AdminServiceGroup {
  return {
    id: g.id,
    slug: g.slug,
    name: g.name,
    description: g.description,
    sortOrder: g.sort_order,
    isPublic: g.is_public === 1,
    collapsedByDefault: g.collapsed_by_default === 1,
    createdAt: g.created_at,
    updatedAt: g.updated_at,
  };
}

// --- Checks -------------------------------------------------------------------

export interface CheckFilter {
  ids?: string[];
  sourceId?: string;
  q?: string;
  state?: CheckState;
  unlinked?: boolean;
}

export async function loadAdminChecks(db: DB, filter: CheckFilter = {}): Promise<AdminMonitorCheck[]> {
  if (filter.ids && filter.ids.length === 0) return [];
  let query = db
    .selectFrom('monitor_checks')
    .innerJoin('monitor_sources', 'monitor_sources.id', 'monitor_checks.source_id')
    .select((eb) => [
      'monitor_checks.id',
      'monitor_checks.source_id',
      'monitor_sources.name as source_name',
      'monitor_sources.type as source_type',
      'monitor_checks.external_id',
      'monitor_checks.name',
      'monitor_checks.host',
      'monitor_checks.state',
      'monitor_checks.output',
      'monitor_checks.last_check_at',
      'monitor_checks.last_state_change_at',
      eb
        .selectFrom('service_checks')
        .select((e) => e.fn.countAll<number>().as('n'))
        .whereRef('service_checks.check_id', '=', 'monitor_checks.id')
        .as('service_count'),
    ]);
  if (filter.ids) query = query.where('monitor_checks.id', 'in', filter.ids);
  if (filter.sourceId) query = query.where('monitor_checks.source_id', '=', filter.sourceId);
  if (filter.state) query = query.where('monitor_checks.state', '=', filter.state);
  if (filter.unlinked) {
    query = query.where((eb) =>
      eb.not(eb.exists(eb.selectFrom('service_checks').select('check_id').whereRef('service_checks.check_id', '=', 'monitor_checks.id'))),
    );
  }
  if (filter.q) {
    const pattern = `%${filter.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    query = query.where((eb) =>
      eb.or(
        (['monitor_checks.name', 'monitor_checks.host', 'monitor_checks.external_id'] as const).map((col) =>
          sql<boolean>`lower(${sql.ref(col)}) like ${pattern} escape '\\'`,
        ),
      ),
    );
  }
  const rows = await query
    .orderBy('monitor_sources.name')
    .orderBy('monitor_checks.host')
    .orderBy('monitor_checks.name')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    sourceName: r.source_name,
    sourceType: r.source_type,
    externalId: r.external_id,
    name: r.name,
    host: r.host,
    state: r.state,
    output: r.output,
    lastCheckAt: r.last_check_at,
    lastStateChangeAt: r.last_state_change_at,
    serviceCount: Number(r.service_count ?? 0),
  }));
}

// --- Services -----------------------------------------------------------------

/** Loads services (all, or the given ids) with locations and check links, ordered for display. */
export async function loadAdminServices(db: DB, ids?: string[]): Promise<AdminService[]> {
  if (ids && ids.length === 0) return [];
  let q = db
    .selectFrom('services')
    .leftJoin('service_groups', 'service_groups.id', 'services.group_id')
    .selectAll('services')
    .orderBy('service_groups.sort_order')
    .orderBy('service_groups.name')
    .orderBy('services.sort_order')
    .orderBy('services.name');
  if (ids) q = q.where('services.id', 'in', ids);
  const rows = await q.execute();
  if (rows.length === 0) return [];
  const serviceIds = rows.map((r) => r.id);

  const [locations, links] = await Promise.all([
    db
      .selectFrom('service_locations')
      .innerJoin('locations', 'locations.id', 'service_locations.location_id')
      .select(['service_locations.service_id', 'service_locations.location_id'])
      .where('service_locations.service_id', 'in', serviceIds)
      .orderBy('locations.sort_order')
      .orderBy('locations.name')
      .execute(),
    db.selectFrom('service_checks').selectAll().where('service_id', 'in', serviceIds).execute(),
  ]);
  const checks = await loadAdminChecks(db, { ids: [...new Set(links.map((l) => l.check_id))] });
  const checkById = new Map(checks.map((c) => [c.id, c]));

  return rows.map((s) => ({
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
    kind: s.kind,
    url: s.url,
    groupId: s.group_id,
    sortOrder: s.sort_order,
    isPublic: s.is_public === 1,
    statusMode: s.status_mode,
    manualStatus: s.manual_status,
    aggregation: s.aggregation,
    status: s.current_status,
    monitorStatus: s.monitor_status,
    statusChangedAt: s.status_changed_at,
    locationIds: locations.filter((l) => l.service_id === s.id).map((l) => l.location_id),
    checks: links
      .filter((l) => l.service_id === s.id)
      .flatMap((l) => {
        const check = checkById.get(l.check_id);
        return check
          ? [
              {
                checkId: l.check_id,
                warningStatus: l.warning_status,
                criticalStatus: l.critical_status,
                unknownStatus: l.unknown_status,
                check,
              },
            ]
          : [];
      }),
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  }));
}

// --- Locations ----------------------------------------------------------------

export async function loadAdminLocations(db: DB, ids?: string[]): Promise<AdminLocation[]> {
  if (ids && ids.length === 0) return [];
  let q = db.selectFrom('locations').selectAll().orderBy('sort_order').orderBy('name');
  if (ids) q = q.where('id', 'in', ids);
  const rows = await q.execute();
  if (rows.length === 0) return [];
  const links = await db
    .selectFrom('service_locations')
    .innerJoin('services', 'services.id', 'service_locations.service_id')
    .select(['service_locations.location_id', 'services.id', 'services.is_public', 'services.current_status'])
    .where(
      'service_locations.location_id',
      'in',
      rows.map((r) => r.id),
    )
    .orderBy('services.sort_order')
    .orderBy('services.name')
    .execute();

  return rows.map((l) => {
    const services = links.filter((x) => x.location_id === l.id);
    return {
      id: l.id,
      slug: l.slug,
      name: l.name,
      code: l.code,
      city: l.city,
      country: l.country,
      region: l.region,
      latitude: l.latitude,
      longitude: l.longitude,
      description: l.description,
      // Same rule as the public page: only public services count.
      status: locationStatus(
        l.status_override,
        services.filter((s) => s.is_public === 1).map((s) => s.current_status),
      ),
      serviceIds: services.map((s) => s.id),
      sortOrder: l.sort_order,
      isPublic: l.is_public === 1,
      statusOverride: l.status_override,
      createdAt: l.created_at,
      updatedAt: l.updated_at,
    };
  });
}

// --- Monitoring sources -------------------------------------------------------

export function maskSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = { ...config };
  for (const key of SECRET_FIELDS) {
    if (typeof masked[key] === 'string' && masked[key] !== '') masked[key] = SECRET_MASK;
  }
  return masked;
}

export function ingestUrl(baseUrl: string, sourceId: string): string {
  return `${baseUrl}/api/ingest/${sourceId}`;
}

export function decryptSourceConfig(secrets: SecretBox, source: Pick<MonitorSource, 'config_encrypted'>): Record<string, unknown> {
  try {
    return secrets.decryptJson<Record<string, unknown>>(source.config_encrypted);
  } catch {
    // Unreadable (e.g. SECRET_KEY changed): show an empty config; the admin has to re-enter it.
    return {};
  }
}

export async function loadAdminSources(
  db: DB,
  secrets: SecretBox,
  baseUrl: string,
  ids?: string[],
): Promise<AdminMonitorSource[]> {
  if (ids && ids.length === 0) return [];
  let q = db
    .selectFrom('monitor_sources')
    .selectAll()
    .select((eb) =>
      eb
        .selectFrom('monitor_checks')
        .select((e) => e.fn.countAll<number>().as('n'))
        .whereRef('monitor_checks.source_id', '=', 'monitor_sources.id')
        .as('check_count'),
    )
    .orderBy('name');
  if (ids) q = q.where('id', 'in', ids);
  const rows = await q.execute();
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    enabled: s.enabled === 1,
    pollIntervalSeconds: s.poll_interval_seconds,
    config: maskSecrets(decryptSourceConfig(secrets, s)),
    ingestUrl: ingestUrl(baseUrl, s.id),
    lastPollAt: s.last_poll_at,
    lastPollOk: s.last_poll_ok === null ? null : s.last_poll_ok === 1,
    lastError: s.last_error,
    checkCount: Number(s.check_count ?? 0),
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  }));
}

/**
 * Public view of services, groups and locations.
 *
 * Every response object is built field by field. Nothing in here may read or
 * return monitoring data (sources, checks, hosts, outputs or counts of them).
 */
import {
  SERVICE_STATUSES,
  locationStatus,
  worstStatus,
  type DailyUptime,
  type PublicLocation,
  type PublicPageSettings,
  type PublicService,
  type PublicServiceGroup,
  type ServiceStatus,
} from '@openstatuspage/shared';
import type { DB } from '../db/index.js';
import type { Service } from '../db/types.js';
import { averageUptime, computeDailyUptime, startOfUtcDay, type StatusSegment } from './uptime.js';

const DAY_MS = 86400_000;

export function emptyCounts(): Record<ServiceStatus, number> {
  return Object.fromEntries(SERVICE_STATUSES.map((s) => [s, 0])) as Record<ServiceStatus, number>;
}

export function countStatuses(statuses: Iterable<ServiceStatus>): Record<ServiceStatus, number> {
  const counts = emptyCounts();
  for (const s of statuses) counts[s]++;
  return counts;
}

export interface PublicCatalog {
  /** All public services in display order. */
  services: PublicService[];
  groups: PublicServiceGroup[];
  ungrouped: PublicService[];
  counts: Record<ServiceStatus, number>;
  /** Public group names by id (for status.json). */
  groupNames: Map<string, string>;
}

export interface UptimeOptions {
  /** Include per-day uptime buckets. */
  days: number | null;
  now: Date;
}

/** Loads status history segments of the given services overlapping [from, now] in one query. */
async function loadSegments(db: DB, serviceIds: string[], from: Date): Promise<Map<string, StatusSegment[]>> {
  const result = new Map<string, StatusSegment[]>();
  if (serviceIds.length === 0) return result;
  const fromIso = from.toISOString();
  const rows = await db
    .selectFrom('service_status_history')
    .select(['service_id', 'status', 'started_at', 'ended_at'])
    .where('service_id', 'in', serviceIds)
    .where((eb) => eb.or([eb('ended_at', 'is', null), eb('ended_at', '>=', fromIso)]))
    .execute();
  for (const r of rows) {
    const list = result.get(r.service_id) ?? [];
    list.push({ status: r.status, started_at: r.started_at, ended_at: r.ended_at });
    result.set(r.service_id, list);
  }
  return result;
}

/** Computes daily uptime buckets and average uptime for each service. */
export async function loadUptime(
  db: DB,
  serviceIds: string[],
  days: number,
  now: Date,
): Promise<Map<string, { uptime: DailyUptime[]; percent: number | null }>> {
  const from = new Date(startOfUtcDay(now).getTime() - (days - 1) * DAY_MS);
  const segments = await loadSegments(db, serviceIds, from);
  const result = new Map<string, { uptime: DailyUptime[]; percent: number | null }>();
  for (const id of serviceIds) {
    const segs = segments.get(id) ?? [];
    result.set(id, { uptime: computeDailyUptime(segs, days, now), percent: averageUptime(segs, from, now) });
  }
  return result;
}

/** Public locations by id (used to filter location references). */
async function publicLocationIds(db: DB): Promise<Set<string>> {
  const rows = await db.selectFrom('locations').select('id').where('is_public', '=', 1).execute();
  return new Set(rows.map((r) => r.id));
}

async function serviceLocationMap(db: DB, serviceIds: string[], allowed: Set<string>): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (serviceIds.length === 0) return map;
  const rows = await db
    .selectFrom('service_locations')
    .innerJoin('locations', 'locations.id', 'service_locations.location_id')
    .select(['service_locations.service_id', 'service_locations.location_id'])
    .where('service_locations.service_id', 'in', serviceIds)
    .orderBy('locations.sort_order')
    .orderBy('locations.name')
    .execute();
  for (const r of rows) {
    if (!allowed.has(r.location_id)) continue;
    const list = map.get(r.service_id) ?? [];
    list.push(r.location_id);
    map.set(r.service_id, list);
  }
  return map;
}

export function toPublicService(
  s: Pick<Service, 'id' | 'slug' | 'name' | 'description' | 'kind' | 'url' | 'current_status'>,
  groupId: string | null,
  locationIds: string[],
  uptime: { uptime: DailyUptime[]; percent: number | null } | undefined,
  includeBars: boolean,
): PublicService {
  const result: PublicService = {
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
    kind: s.kind,
    url: s.url,
    groupId,
    status: s.current_status,
    locationIds,
    uptimePercent: uptime?.percent ?? null,
  };
  if (includeBars && uptime) result.uptime = uptime.uptime;
  return result;
}

const SERVICE_COLUMNS = [
  'services.id',
  'services.slug',
  'services.name',
  'services.description',
  'services.kind',
  'services.url',
  'services.group_id',
  'services.current_status',
] as const;

/** Loads all public services and groups in display order, with uptime according to settings. */
export async function loadPublicCatalog(db: DB, settings: PublicPageSettings, now: Date): Promise<PublicCatalog> {
  const [groupRows, serviceRows, allowedLocations] = await Promise.all([
    db
      .selectFrom('service_groups')
      .select(['id', 'slug', 'name', 'description', 'collapsed_by_default'])
      .where('is_public', '=', 1)
      .orderBy('sort_order')
      .orderBy('name')
      .execute(),
    db
      .selectFrom('services')
      .select([...SERVICE_COLUMNS])
      .where('services.is_public', '=', 1)
      .orderBy('services.sort_order')
      .orderBy('services.name')
      .execute(),
    publicLocationIds(db),
  ]);

  const ids = serviceRows.map((s) => s.id);
  const [locations, uptime] = await Promise.all([
    serviceLocationMap(db, ids, allowedLocations),
    settings.showUptime ? loadUptime(db, ids, settings.uptimeDays, now) : Promise.resolve(new Map()),
  ]);

  const publicGroups = new Set(groupRows.map((g) => g.id));
  const services = serviceRows.map((s) => {
    // A service inside a hidden group is shown as ungrouped; the hidden group stays secret.
    const groupId = s.group_id && publicGroups.has(s.group_id) ? s.group_id : null;
    return toPublicService(s, groupId, locations.get(s.id) ?? [], uptime.get(s.id), settings.showUptime);
  });

  const groups: PublicServiceGroup[] = groupRows
    .map((g) => {
      const members = services.filter((s) => s.groupId === g.id);
      return {
        id: g.id,
        slug: g.slug,
        name: g.name,
        description: g.description,
        collapsedByDefault: g.collapsed_by_default === 1,
        status: worstStatus(members.map((m) => m.status)),
        services: members,
      };
    })
    .filter((g) => g.services.length > 0);

  const ungrouped = services.filter((s) => s.groupId === null);
  return {
    // Display order: grouped services in group order, then ungrouped ones.
    services: [...groups.flatMap((g) => g.services), ...ungrouped],
    groups,
    ungrouped,
    counts: countStatuses(services.map((s) => s.status)),
    groupNames: new Map(groupRows.map((g) => [g.id, g.name])),
  };
}

/** Loads one public service by id or slug, or null. */
export async function loadPublicService(
  db: DB,
  idOrSlug: string,
  settings: PublicPageSettings,
  now: Date,
): Promise<PublicService | null> {
  const row = await db
    .selectFrom('services')
    .leftJoin('service_groups', 'service_groups.id', 'services.group_id')
    .select([...SERVICE_COLUMNS, 'service_groups.is_public as group_public'])
    .where('services.is_public', '=', 1)
    .where((eb) => eb.or([eb('services.id', '=', idOrSlug), eb('services.slug', '=', idOrSlug)]))
    .executeTakeFirst();
  if (!row) return null;
  const allowed = await publicLocationIds(db);
  const locations = await serviceLocationMap(db, [row.id], allowed);
  const uptime = settings.showUptime ? await loadUptime(db, [row.id], settings.uptimeDays, now) : null;
  const groupId = row.group_id && row.group_public === 1 ? row.group_id : null;
  return toPublicService(row, groupId, locations.get(row.id) ?? [], uptime?.get(row.id), settings.showUptime);
}

/** Public locations with status derived from their PUBLIC services only. */
export async function loadPublicLocations(db: DB): Promise<PublicLocation[]> {
  const [rows, links] = await Promise.all([
    db
      .selectFrom('locations')
      .select([
        'id',
        'slug',
        'name',
        'code',
        'city',
        'country',
        'region',
        'latitude',
        'longitude',
        'description',
        'status_override',
      ])
      .where('is_public', '=', 1)
      .orderBy('sort_order')
      .orderBy('name')
      .execute(),
    db
      .selectFrom('service_locations')
      .innerJoin('services', 'services.id', 'service_locations.service_id')
      .select(['service_locations.location_id', 'services.id', 'services.current_status'])
      .where('services.is_public', '=', 1)
      .orderBy('services.sort_order')
      .orderBy('services.name')
      .execute(),
  ]);

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
      status: locationStatus(
        l.status_override,
        services.map((s) => s.current_status),
      ),
      serviceIds: services.map((s) => s.id),
    };
  });
}

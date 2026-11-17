/**
 * Loading and serialization of incidents.
 *
 * Records are loaded in batches (one query per related table) and turned into
 * public or admin responses by explicit serializers. Public serializers drop
 * non-public services and locations.
 */
import type { AdminIncident, ImpactStatus, IncidentStatus, PublicIncident } from '@openstatuspage/shared';
import type { DB } from '../db/index.js';
import type { Incident } from '../db/types.js';

export interface IncidentRecord {
  row: Incident;
  updates: { id: string; status: IncidentStatus; message: string; created_at: string }[];
  services: { id: string; name: string; status: ImpactStatus; isPublic: boolean }[];
  locations: { id: string; isPublic: boolean }[];
}

/** Loads incidents with updates, services and locations, keeping the order of `ids`. */
export async function loadIncidents(db: DB, ids: string[]): Promise<IncidentRecord[]> {
  if (ids.length === 0) return [];
  const [rows, updates, services, locations] = await Promise.all([
    db.selectFrom('incidents').selectAll().where('id', 'in', ids).execute(),
    db
      .selectFrom('incident_updates')
      .select(['id', 'incident_id', 'status', 'message', 'created_at'])
      .where('incident_id', 'in', ids)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute(),
    db
      .selectFrom('incident_services')
      .innerJoin('services', 'services.id', 'incident_services.service_id')
      .select([
        'incident_services.incident_id',
        'services.id',
        'services.name',
        'services.is_public',
        'incident_services.status',
      ])
      .where('incident_services.incident_id', 'in', ids)
      .orderBy('services.sort_order')
      .orderBy('services.name')
      .execute(),
    db
      .selectFrom('incident_locations')
      .innerJoin('locations', 'locations.id', 'incident_locations.location_id')
      .select(['incident_locations.incident_id', 'locations.id', 'locations.is_public'])
      .where('incident_locations.incident_id', 'in', ids)
      .orderBy('locations.sort_order')
      .orderBy('locations.name')
      .execute(),
  ]);

  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    return [
      {
        row,
        updates: updates
          .filter((u) => u.incident_id === id)
          .map((u) => ({ id: u.id, status: u.status, message: u.message, created_at: u.created_at })),
        services: services
          .filter((s) => s.incident_id === id)
          .map((s) => ({ id: s.id, name: s.name, status: s.status, isPublic: s.is_public === 1 })),
        locations: locations
          .filter((l) => l.incident_id === id)
          .map((l) => ({ id: l.id, isPublic: l.is_public === 1 })),
      },
    ];
  });
}

/**
 * Timestamp for a new update entry: now, but strictly after the latest existing
 * entry, so timelines keep their order even for updates posted within the same millisecond.
 */
export async function nextUpdateTimestamp(
  db: DB,
  table: 'incident_updates' | 'maintenance_updates',
  parentId: string,
): Promise<string> {
  const latest =
    table === 'incident_updates'
      ? await db
          .selectFrom('incident_updates')
          .select('created_at')
          .where('incident_id', '=', parentId)
          .orderBy('created_at', 'desc')
          .executeTakeFirst()
      : await db
          .selectFrom('maintenance_updates')
          .select('created_at')
          .where('maintenance_id', '=', parentId)
          .orderBy('created_at', 'desc')
          .executeTakeFirst();
  const last = latest ? new Date(latest.created_at).getTime() : 0;
  return new Date(Math.max(Date.now(), last + 1)).toISOString();
}

export async function loadIncident(db: DB, id: string): Promise<IncidentRecord | null> {
  const [rec] = await loadIncidents(db, [id]);
  return rec ?? null;
}

function base(rec: IncidentRecord, publicOnly: boolean): PublicIncident {
  const { row } = rec;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    impact: row.impact,
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
    updatedAt: row.updated_at,
    affectedServices: rec.services
      .filter((s) => !publicOnly || s.isPublic)
      .map((s) => ({ id: s.id, name: s.name, status: s.status })),
    locationIds: rec.locations.filter((l) => !publicOnly || l.isPublic).map((l) => l.id),
    updates: rec.updates.map((u) => ({ id: u.id, status: u.status, message: u.message, createdAt: u.created_at })),
  };
}

export function toPublicIncident(rec: IncidentRecord): PublicIncident {
  return base(rec, true);
}

export function toAdminIncident(rec: IncidentRecord): AdminIncident {
  return {
    ...base(rec, false),
    isPublic: rec.row.is_public === 1,
    source: rec.row.source,
    createdAt: rec.row.created_at,
    createdBy: rec.row.created_by,
  };
}

/**
 * Loading and serialization of maintenance windows (see incidents.ts for the pattern).
 */
import type { AdminMaintenance, MaintenanceStatus, PublicMaintenance } from '@openstatuspage/shared';
import type { DB } from '../db/index.js';
import type { Maintenance } from '../db/types.js';

export interface MaintenanceRecord {
  row: Maintenance;
  updates: { id: string; status: MaintenanceStatus; message: string; created_at: string }[];
  services: { id: string; name: string; isPublic: boolean }[];
  locations: { id: string; isPublic: boolean }[];
}

export async function loadMaintenances(db: DB, ids: string[]): Promise<MaintenanceRecord[]> {
  if (ids.length === 0) return [];
  const [rows, updates, services, locations] = await Promise.all([
    db.selectFrom('maintenances').selectAll().where('id', 'in', ids).execute(),
    db
      .selectFrom('maintenance_updates')
      .select(['id', 'maintenance_id', 'status', 'message', 'created_at'])
      .where('maintenance_id', 'in', ids)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute(),
    db
      .selectFrom('maintenance_services')
      .innerJoin('services', 'services.id', 'maintenance_services.service_id')
      .select(['maintenance_services.maintenance_id', 'services.id', 'services.name', 'services.is_public'])
      .where('maintenance_services.maintenance_id', 'in', ids)
      .orderBy('services.sort_order')
      .orderBy('services.name')
      .execute(),
    db
      .selectFrom('maintenance_locations')
      .innerJoin('locations', 'locations.id', 'maintenance_locations.location_id')
      .select(['maintenance_locations.maintenance_id', 'locations.id', 'locations.is_public'])
      .where('maintenance_locations.maintenance_id', 'in', ids)
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
          .filter((u) => u.maintenance_id === id)
          .map((u) => ({ id: u.id, status: u.status, message: u.message, created_at: u.created_at })),
        services: services
          .filter((s) => s.maintenance_id === id)
          .map((s) => ({ id: s.id, name: s.name, isPublic: s.is_public === 1 })),
        locations: locations
          .filter((l) => l.maintenance_id === id)
          .map((l) => ({ id: l.id, isPublic: l.is_public === 1 })),
      },
    ];
  });
}

export async function loadMaintenance(db: DB, id: string): Promise<MaintenanceRecord | null> {
  const [rec] = await loadMaintenances(db, [id]);
  return rec ?? null;
}

function base(rec: MaintenanceRecord, publicOnly: boolean): PublicMaintenance {
  const { row } = rec;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    actualStart: row.actual_start,
    actualEnd: row.actual_end,
    affectedServices: rec.services.filter((s) => !publicOnly || s.isPublic).map((s) => ({ id: s.id, name: s.name })),
    locationIds: rec.locations.filter((l) => !publicOnly || l.isPublic).map((l) => l.id),
    updates: rec.updates.map((u) => ({ id: u.id, status: u.status, message: u.message, createdAt: u.created_at })),
  };
}

export function toPublicMaintenance(rec: MaintenanceRecord): PublicMaintenance {
  return base(rec, true);
}

export function toAdminMaintenance(rec: MaintenanceRecord): AdminMaintenance {
  return {
    ...base(rec, false),
    autoStart: rec.row.auto_start === 1,
    autoComplete: rec.row.auto_complete === 1,
    isPublic: rec.row.is_public === 1,
    createdAt: rec.row.created_at,
    updatedAt: rec.row.updated_at,
  };
}

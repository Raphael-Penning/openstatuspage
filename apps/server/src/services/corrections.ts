/**
 * Loading of history corrections (status overrides and retroactive maintenance
 * windows) and their admin serialization. See history-corrections.ts for how
 * they are applied.
 */
import type { AdminCorrection, ServiceStatus } from '@openstatuspage/shared';
import type { DB } from '../db/index.js';
import type { CorrectionLayer } from './history-corrections.js';

export interface ServiceCorrections {
  layers: CorrectionLayer[];
  /** Corrections with show_public (id -> public note), for the public "corrected afterwards" marker. */
  publicNotes: Map<string, string | null>;
}

/**
 * Corrections and retroactive maintenance windows of the given services that
 * overlap [from, to). Services without any get no entry.
 */
export async function loadCorrectionLayers(
  db: DB,
  serviceIds: string[],
  from: string,
  to: string,
): Promise<Map<string, ServiceCorrections>> {
  if (serviceIds.length === 0) return new Map();
  const [corrections, maintenances] = await Promise.all([
    db
      .selectFrom('status_corrections')
      .innerJoin('status_correction_services', 'status_correction_services.correction_id', 'status_corrections.id')
      .select([
        'status_correction_services.service_id',
        'status_corrections.id',
        'status_corrections.starts_at',
        'status_corrections.ends_at',
        'status_corrections.status',
        'status_corrections.show_public',
        'status_corrections.public_note',
        'status_corrections.created_at',
      ])
      .where('status_correction_services.service_id', 'in', serviceIds)
      .where('status_corrections.starts_at', '<', to)
      .where('status_corrections.ends_at', '>', from)
      .execute(),
    db
      .selectFrom('maintenances')
      .innerJoin('maintenance_services', 'maintenance_services.maintenance_id', 'maintenances.id')
      .select([
        'maintenance_services.service_id',
        'maintenances.id',
        'maintenances.status',
        'maintenances.scheduled_start',
        'maintenances.scheduled_end',
        'maintenances.actual_start',
        'maintenances.actual_end',
        'maintenances.created_at',
      ])
      .where('maintenance_services.service_id', 'in', serviceIds)
      .where('maintenances.retroactive', '=', 1)
      // Like the live status engine: only public maintenance changes statuses.
      .where('maintenances.is_public', '=', 1)
      .where('maintenances.status', 'in', ['in_progress', 'completed'])
      .where('maintenances.scheduled_start', '<', to)
      .execute(),
  ]);
  return buildCorrectionLayers(corrections, maintenances, from);
}

/** A correction of one service (a row of status_corrections joined with its services). */
export interface CorrectionRow {
  service_id: string;
  id: string;
  starts_at: string;
  ends_at: string;
  status: ServiceStatus;
  show_public: number;
  public_note: string | null;
  created_at: string;
}

/** A public retroactive maintenance window of one service. */
export interface RetroactiveMaintenanceRow {
  service_id: string;
  id: string;
  status: string;
  scheduled_start: string;
  scheduled_end: string;
  actual_start: string | null;
  actual_end: string | null;
  created_at: string;
}

/**
 * The correction layers per service from already loaded rows (overlapping the
 * range that starts at `from`). Services without any get no entry.
 */
export function buildCorrectionLayers(
  corrections: readonly CorrectionRow[],
  maintenances: readonly RetroactiveMaintenanceRow[],
  from: string,
): Map<string, ServiceCorrections> {
  const result = new Map<string, ServiceCorrections>();
  const entry = (id: string) => {
    let e = result.get(id);
    if (!e) {
      e = { layers: [], publicNotes: new Map() };
      result.set(id, e);
    }
    return e;
  };

  for (const c of corrections) {
    const e = entry(c.service_id);
    e.layers.push({
      kind: 'correction',
      id: c.id,
      status: c.status,
      start: c.starts_at,
      end: c.ends_at,
      order: c.created_at,
    });
    if (c.show_public === 1) e.publicNotes.set(c.id, c.public_note);
  }

  for (const m of maintenances) {
    const window = retroactiveWindow(m);
    if (window.end !== null && window.end <= from) continue;
    entry(m.service_id).layers.push({
      kind: 'maintenance',
      id: m.id,
      status: 'maintenance',
      start: window.start,
      end: window.end,
      order: m.created_at,
    });
  }
  return result;
}

/** The time a retroactive maintenance counts as "maintenance"; end null = still running. */
export function retroactiveWindow(m: {
  status: string;
  scheduled_start: string;
  scheduled_end: string;
  actual_start: string | null;
  actual_end: string | null;
}): { start: string; end: string | null } {
  const start = m.actual_start ?? m.scheduled_start;
  if (m.status === 'in_progress') return { start, end: null };
  return { start, end: m.actual_end ?? m.scheduled_end };
}

/** Loads corrections by id in the given order. */
export async function loadCorrections(db: DB, ids: string[]): Promise<AdminCorrection[]> {
  if (ids.length === 0) return [];
  const [rows, services] = await Promise.all([
    db
      .selectFrom('status_corrections')
      .leftJoin('users', 'users.id', 'status_corrections.created_by')
      .selectAll('status_corrections')
      .select('users.name as user_name')
      .where('status_corrections.id', 'in', ids)
      .execute(),
    db
      .selectFrom('status_correction_services')
      .innerJoin('services', 'services.id', 'status_correction_services.service_id')
      .select(['status_correction_services.correction_id', 'services.id', 'services.name'])
      .where('status_correction_services.correction_id', 'in', ids)
      .orderBy('services.sort_order')
      .orderBy('services.name')
      .execute(),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    return [
      {
        id: r.id,
        services: services.filter((s) => s.correction_id === id).map((s) => ({ id: s.id, name: s.name })),
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        status: r.status,
        reason: r.reason,
        showPublic: r.show_public === 1,
        publicNote: r.public_note,
        createdBy: r.created_by,
        createdByName: r.user_name ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      },
    ];
  });
}

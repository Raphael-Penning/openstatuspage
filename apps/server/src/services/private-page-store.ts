/**
 * Read access to one private page by its token (/p/<token>), in two ways with
 * the same rows:
 *
 * - DirectPrivatePageStore reads the tables (SQLite, and every PostgreSQL
 *   instance except APP_ROLE=public).
 * - FunctionPrivatePageStore calls the SECURITY DEFINER functions in osp_public
 *   (migration 0009_private_pages), the only way the restricted public role of
 *   a public PostgreSQL instance reaches a private page: it holds no privilege
 *   on the private page tables and the views of osp_public never show hidden
 *   services. The functions hash the token themselves and return the rows of
 *   that one page only.
 *
 * Every method answers "nothing" (null, []) for a token that does not belong to
 * an enabled page that has not expired, without telling which of these it was.
 */
import { isPrivatePageToken, type ImpactStatus, type IncidentImpact, type IncidentStatus, type MaintenanceStatus, type ServiceKind, type ServiceStatus } from '@openstatuspage/shared';
import { sql } from 'kysely';
import type { DB } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import type { CorrectionRow, RetroactiveMaintenanceRow } from './corrections.js';

export interface PrivatePageRef {
  id: string;
  name: string;
  description: string | null;
}

export interface PrivateServiceRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: ServiceKind;
  url: string | null;
  current_status: ServiceStatus;
}

export interface PrivateHistoryRow {
  service_id: string;
  status: ServiceStatus;
  started_at: string;
  ended_at: string | null;
}

interface UpdateRow<S> {
  id: string;
  status: S;
  message: string;
  created_at: string;
}

/** A public incident with its updates; `services` lists only services of the page. */
export interface PrivateIncidentRow {
  id: string;
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  started_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  services: { id: string; name: string; status: ImpactStatus }[];
  updates: UpdateRow<IncidentStatus>[];
}

/** A public, not cancelled maintenance window; `services` lists only services of the page. */
export interface PrivateMaintenanceRow {
  id: string;
  title: string;
  description: string;
  status: MaintenanceStatus;
  scheduled_start: string;
  scheduled_end: string;
  actual_start: string | null;
  actual_end: string | null;
  created_at: string;
  updated_at: string;
  services: { id: string; name: string }[];
  updates: UpdateRow<MaintenanceStatus>[];
}

export interface PrivatePageStore {
  /** The page of the token (enabled, not expired), or null. */
  page(token: string): Promise<PrivatePageRef | null>;
  /** Its services in display order (also ones hidden from the main page). */
  services(token: string): Promise<PrivateServiceRow[]>;
  /** History of its services overlapping [from, to) (to null: up to now), ordered by start. */
  history(token: string, from: string, to: string | null): Promise<PrivateHistoryRow[]>;
  /** Corrections of its services overlapping [from, to). */
  corrections(token: string, from: string, to: string): Promise<CorrectionRow[]>;
  /** Public retroactive maintenance windows of its services that started before `to`. */
  retroactiveMaintenances(token: string, to: string): Promise<RetroactiveMaintenanceRow[]>;
  /** Public incidents of its services: unresolved, or started or resolved since `since`; newest first. */
  incidents(token: string, since: string): Promise<PrivateIncidentRow[]>;
  /** Public maintenance windows of its services: scheduled, running, or ended since `since`; oldest first. */
  maintenances(token: string, since: string): Promise<PrivateMaintenanceRow[]>;
}

/** SHA-256 (hex) of a link token: what private_pages.token_hash stores. */
export function privatePageTokenHash(token: string): string {
  return sha256(token);
}

/** Reads the tables directly (everything except a public PostgreSQL instance). */
export class DirectPrivatePageStore implements PrivatePageStore {
  constructor(private readonly db: DB) {}

  private async pageId(token: string): Promise<string | null> {
    return (await this.page(token))?.id ?? null;
  }

  async page(token: string): Promise<PrivatePageRef | null> {
    if (!isPrivatePageToken(token)) return null;
    const now = new Date().toISOString();
    const row = await this.db
      .selectFrom('private_pages')
      .select(['id', 'name', 'description'])
      .where('token_hash', '=', privatePageTokenHash(token))
      .where('enabled', '=', 1)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
      .executeTakeFirst();
    return row ?? null;
  }

  /** Ids of the page's services ([] for a wrong token). */
  private async serviceIds(token: string): Promise<string[]> {
    const id = await this.pageId(token);
    if (!id) return [];
    const rows = await this.db.selectFrom('private_page_services').select('service_id').where('page_id', '=', id).execute();
    return rows.map((r) => r.service_id);
  }

  async services(token: string): Promise<PrivateServiceRow[]> {
    const id = await this.pageId(token);
    if (!id) return [];
    return this.db
      .selectFrom('private_page_services')
      .innerJoin('services', 'services.id', 'private_page_services.service_id')
      .select([
        'services.id',
        'services.slug',
        'services.name',
        'services.description',
        'services.kind',
        'services.url',
        'services.current_status',
      ])
      .where('private_page_services.page_id', '=', id)
      .orderBy('private_page_services.sort_order')
      .orderBy('services.name')
      .execute();
  }

  async history(token: string, from: string, to: string | null): Promise<PrivateHistoryRow[]> {
    const ids = await this.serviceIds(token);
    if (ids.length === 0) return [];
    let query = this.db
      .selectFrom('service_status_history')
      .select(['service_id', 'status', 'started_at', 'ended_at'])
      .where('service_id', 'in', ids)
      .where((eb) => eb.or([eb('ended_at', 'is', null), eb('ended_at', '>=', from)]));
    if (to) query = query.where('started_at', '<', to);
    return query.orderBy('started_at').execute();
  }

  async corrections(token: string, from: string, to: string): Promise<CorrectionRow[]> {
    const ids = await this.serviceIds(token);
    if (ids.length === 0) return [];
    const rows = await this.db
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
      .where('status_correction_services.service_id', 'in', ids)
      .where('status_corrections.starts_at', '<', to)
      .where('status_corrections.ends_at', '>', from)
      .execute();
    // The note only when it is meant to be shown (like the osp_public view and function).
    return rows.map((r) => ({ ...r, public_note: r.show_public === 1 ? r.public_note : null }));
  }

  async retroactiveMaintenances(token: string, to: string): Promise<RetroactiveMaintenanceRow[]> {
    const ids = await this.serviceIds(token);
    if (ids.length === 0) return [];
    return this.db
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
      .where('maintenance_services.service_id', 'in', ids)
      .where('maintenances.retroactive', '=', 1)
      .where('maintenances.is_public', '=', 1)
      .where('maintenances.status', 'in', ['in_progress', 'completed'])
      .where('maintenances.scheduled_start', '<', to)
      .execute();
  }

  async incidents(token: string, since: string): Promise<PrivateIncidentRow[]> {
    const ids = await this.serviceIds(token);
    if (ids.length === 0) return [];
    const rows = await this.db
      .selectFrom('incidents')
      .select(['id', 'title', 'status', 'impact', 'started_at', 'resolved_at', 'created_at', 'updated_at'])
      .where('is_public', '=', 1)
      .where('id', 'in', (eb) => eb.selectFrom('incident_services').select('incident_id').where('service_id', 'in', ids))
      .where((eb) => eb.or([eb('status', '!=', 'resolved'), eb('started_at', '>=', since), eb('resolved_at', '>=', since)]))
      .orderBy('started_at', 'desc')
      .orderBy('id')
      .execute();
    if (rows.length === 0) return [];
    const incidentIds = rows.map((r) => r.id);
    const [links, updates] = await Promise.all([
      this.db
        .selectFrom('incident_services')
        .innerJoin('services', 'services.id', 'incident_services.service_id')
        .select(['incident_services.incident_id', 'services.id', 'services.name', 'incident_services.status'])
        .where('incident_services.incident_id', 'in', incidentIds)
        .where('incident_services.service_id', 'in', ids)
        .orderBy('services.sort_order')
        .orderBy('services.name')
        .execute(),
      this.db
        .selectFrom('incident_updates')
        .select(['id', 'incident_id', 'status', 'message', 'created_at'])
        .where('incident_id', 'in', incidentIds)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute(),
    ]);
    return rows.map((r) => ({
      ...r,
      services: links.filter((l) => l.incident_id === r.id).map((l) => ({ id: l.id, name: l.name, status: l.status })),
      updates: updates
        .filter((u) => u.incident_id === r.id)
        .map((u) => ({ id: u.id, status: u.status, message: u.message, created_at: u.created_at })),
    }));
  }

  async maintenances(token: string, since: string): Promise<PrivateMaintenanceRow[]> {
    const ids = await this.serviceIds(token);
    if (ids.length === 0) return [];
    const rows = await this.db
      .selectFrom('maintenances')
      .select([
        'id',
        'title',
        'description',
        'status',
        'scheduled_start',
        'scheduled_end',
        'actual_start',
        'actual_end',
        'created_at',
        'updated_at',
      ])
      .where('is_public', '=', 1)
      .where('status', '!=', 'cancelled')
      .where('id', 'in', (eb) => eb.selectFrom('maintenance_services').select('maintenance_id').where('service_id', 'in', ids))
      .where((eb) =>
        eb.or([
          eb('status', 'in', ['scheduled', 'in_progress']),
          eb(eb.fn.coalesce('actual_end', 'scheduled_end'), '>=', since),
        ]),
      )
      .orderBy('scheduled_start')
      .orderBy('id')
      .execute();
    if (rows.length === 0) return [];
    const maintenanceIds = rows.map((r) => r.id);
    const [links, updates] = await Promise.all([
      this.db
        .selectFrom('maintenance_services')
        .innerJoin('services', 'services.id', 'maintenance_services.service_id')
        .select(['maintenance_services.maintenance_id', 'services.id', 'services.name'])
        .where('maintenance_services.maintenance_id', 'in', maintenanceIds)
        .where('maintenance_services.service_id', 'in', ids)
        .orderBy('services.sort_order')
        .orderBy('services.name')
        .execute(),
      this.db
        .selectFrom('maintenance_updates')
        .select(['id', 'maintenance_id', 'status', 'message', 'created_at'])
        .where('maintenance_id', 'in', maintenanceIds)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute(),
    ]);
    return rows.map((r) => ({
      ...r,
      services: links.filter((l) => l.maintenance_id === r.id).map((l) => ({ id: l.id, name: l.name })),
      updates: updates
        .filter((u) => u.maintenance_id === r.id)
        .map((u) => ({ id: u.id, status: u.status, message: u.message, created_at: u.created_at })),
    }));
  }
}

/** Calls the token-scoped functions of osp_public (APP_ROLE=public on PostgreSQL). */
export class FunctionPrivatePageStore implements PrivatePageStore {
  constructor(private readonly db: DB) {}

  async page(token: string): Promise<PrivatePageRef | null> {
    if (!isPrivatePageToken(token)) return null;
    const { rows } = await sql<PrivatePageRef>`select * from osp_public.private_page(${token})`.execute(this.db);
    return rows[0] ?? null;
  }

  async services(token: string): Promise<PrivateServiceRow[]> {
    if (!isPrivatePageToken(token)) return [];
    const { rows } = await sql<PrivateServiceRow>`
      select id, slug, name, description, kind, url, current_status from osp_public.private_page_services(${token})`.execute(this.db);
    return rows;
  }

  async history(token: string, from: string, to: string | null): Promise<PrivateHistoryRow[]> {
    if (!isPrivatePageToken(token)) return [];
    const { rows } = await sql<PrivateHistoryRow>`select * from osp_public.private_page_history(${token}, ${from}, ${to})`.execute(this.db);
    return rows;
  }

  async corrections(token: string, from: string, to: string): Promise<CorrectionRow[]> {
    if (!isPrivatePageToken(token)) return [];
    const { rows } = await sql<CorrectionRow>`select * from osp_public.private_page_corrections(${token}, ${from}, ${to})`.execute(this.db);
    return rows;
  }

  async retroactiveMaintenances(token: string, to: string): Promise<RetroactiveMaintenanceRow[]> {
    if (!isPrivatePageToken(token)) return [];
    const { rows } = await sql<RetroactiveMaintenanceRow>`
      select * from osp_public.private_page_retroactive_maintenances(${token}, ${to})`.execute(this.db);
    return rows;
  }

  async incidents(token: string, since: string): Promise<PrivateIncidentRow[]> {
    if (!isPrivatePageToken(token)) return [];
    const { rows } = await sql<PrivateIncidentRow>`select * from osp_public.private_page_incidents(${token}, ${since})`.execute(this.db);
    return rows;
  }

  async maintenances(token: string, since: string): Promise<PrivateMaintenanceRow[]> {
    if (!isPrivatePageToken(token)) return [];
    const { rows } = await sql<PrivateMaintenanceRow>`select * from osp_public.private_page_maintenances(${token}, ${since})`.execute(this.db);
    return rows;
  }
}

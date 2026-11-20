/**
 * Keeps `services.current_status` / `monitor_status` and the status history in
 * sync with checks, incidents, maintenance and manual overrides.
 *
 * Call `recompute(serviceIds)` after anything that can influence a service:
 * check results, incident/maintenance changes, service config changes.
 */
import { EventEmitter } from 'node:events';
import type { ServiceStatus } from '@openstatuspage/shared';
import type { Kysely } from 'kysely';
import type { Database, DB } from '../db/index.js';
import { LOCK_KEYS, serialized } from '../db/locks.js';
import { newId } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import { aggregateMonitorStatus, computeEffectiveStatus, type CheckLinkState } from './status-rules.js';

export interface StatusChange {
  serviceId: string;
  from: ServiceStatus;
  to: ServiceStatus;
  at: string;
}

export interface StatusEngineEvents {
  change: [StatusChange];
}

export class StatusEngine extends EventEmitter<StatusEngineEvents> {
  constructor(private readonly db: DB) {
    super();
  }

  /** Recomputes all services. */
  async recomputeAll(): Promise<StatusChange[]> {
    const rows = await this.db.selectFrom('services').select('id').execute();
    return this.recompute(rows.map((r) => r.id));
  }

  /** Recomputes every service that links at least one of the given checks. */
  async recomputeForChecks(checkIds: string[]): Promise<StatusChange[]> {
    if (checkIds.length === 0) return [];
    const rows = await this.db
      .selectFrom('service_checks')
      .select('service_id')
      .distinct()
      .where('check_id', 'in', checkIds)
      .execute();
    return this.recompute(rows.map((r) => r.service_id));
  }

  /**
   * Recomputes the given services and records status history. Returns actual changes.
   * Serialised across instances on PostgreSQL (db/locks.ts), so two recomputes never
   * open two history segments for one service; `change` events follow the commit.
   */
  async recompute(serviceIds: string[]): Promise<StatusChange[]> {
    const ids = [...new Set(serviceIds)];
    if (ids.length === 0) return [];
    const changes = await serialized(this.db, LOCK_KEYS.statusEngine, (q) => this.recomputeWith(q, ids));
    for (const change of changes) this.emit('change', change);
    return changes;
  }

  private async recomputeWith(q: Kysely<Database>, ids: string[]): Promise<StatusChange[]> {
    const now = nowIso();
    const changes: StatusChange[] = [];

    // Load everything needed in a handful of queries.
    const services = await q.selectFrom('services').selectAll().where('id', 'in', ids).execute();

    const links = await q
      .selectFrom('service_checks')
      .innerJoin('monitor_checks', 'monitor_checks.id', 'service_checks.check_id')
      .innerJoin('monitor_sources', 'monitor_sources.id', 'monitor_checks.source_id')
      .select([
        'service_checks.service_id',
        'service_checks.warning_status',
        'service_checks.critical_status',
        'service_checks.unknown_status',
        'monitor_checks.state',
      ])
      .where('service_checks.service_id', 'in', ids)
      // Checks of disabled sources do not influence the public status.
      .where('monitor_sources.enabled', '=', 1)
      .execute();

    const incidentRows = await q
      .selectFrom('incident_services')
      .innerJoin('incidents', 'incidents.id', 'incident_services.incident_id')
      .select(['incident_services.service_id', 'incident_services.status'])
      .where('incident_services.service_id', 'in', ids)
      .where('incidents.status', '!=', 'resolved')
      .where('incidents.is_public', '=', 1)
      .execute();

    const maintenanceRows = await q
      .selectFrom('maintenance_services')
      .innerJoin('maintenances', 'maintenances.id', 'maintenance_services.maintenance_id')
      .select('maintenance_services.service_id')
      .where('maintenance_services.service_id', 'in', ids)
      .where('maintenances.status', '=', 'in_progress')
      .where('maintenances.is_public', '=', 1)
      .execute();
    const inMaintenance = new Set(maintenanceRows.map((r) => r.service_id));

    for (const service of services) {
      const serviceLinks: CheckLinkState[] = links
        .filter((l) => l.service_id === service.id)
        .map((l) => ({
          state: l.state,
          warningStatus: l.warning_status,
          criticalStatus: l.critical_status,
          unknownStatus: l.unknown_status,
        }));

      const monitorStatus = aggregateMonitorStatus(service.aggregation, serviceLinks);
      const status = computeEffectiveStatus({
        statusMode: service.status_mode,
        manualStatus: service.manual_status,
        monitorStatus,
        incidentStatuses: incidentRows.filter((r) => r.service_id === service.id).map((r) => r.status),
        inMaintenance: inMaintenance.has(service.id),
      });

      const statusChanged = status !== service.current_status;
      if (statusChanged || monitorStatus !== service.monitor_status) {
        await q
          .updateTable('services')
          .set({
            current_status: status,
            monitor_status: monitorStatus,
            ...(statusChanged ? { status_changed_at: now } : {}),
          })
          .where('id', '=', service.id)
          .execute();
      }

      await this.recordHistory(q, service.id, status, now);

      if (statusChanged) {
        const change = { serviceId: service.id, from: service.current_status, to: status, at: now };
        changes.push(change);
      }
    }

    return changes;
  }

  /**
   * Ensures the open history segment of a service matches `status`.
   * Also creates the very first segment for new services.
   */
  private async recordHistory(q: Kysely<Database>, serviceId: string, status: ServiceStatus, now: string): Promise<void> {
    const open = await q
      .selectFrom('service_status_history')
      .select(['id', 'status'])
      .where('service_id', '=', serviceId)
      .where('ended_at', 'is', null)
      .orderBy('started_at', 'desc')
      .execute();

    if (open.length === 1 && open[0]!.status === status) return;

    if (open.length > 0) {
      await q
        .updateTable('service_status_history')
        .set({ ended_at: now })
        .where('service_id', '=', serviceId)
        .where('ended_at', 'is', null)
        .execute();
    }
    await q
      .insertInto('service_status_history')
      .values({ id: newId(), service_id: serviceId, status, started_at: now, ended_at: null })
      .execute();
  }
}

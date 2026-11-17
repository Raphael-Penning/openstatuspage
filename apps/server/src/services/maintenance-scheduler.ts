/**
 * Moves maintenance windows through their lifecycle automatically
 * (scheduled → in_progress → completed) when auto_start / auto_complete are set.
 *
 * Automatic transitions add an update with an empty message; clients render a
 * localized default text for empty messages.
 *
 * Every transition is a conditional claim (UPDATE ... WHERE status = <expected>):
 * only the run whose UPDATE changed the row adds the update entry, recomputes
 * and notifies. Concurrent runs (worker tick and an admin request, several
 * instances) therefore never duplicate updates or mails.
 *
 * Subscribers are notified about automatic transitions when the maintenance is
 * public and its notify flag is set. A window that is started and completed in
 * the same run (e.g. missed while the server was down) only sends the completion.
 */
import type { DB } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';
import type { NotificationService } from './notifications.js';
import type { StatusEngine } from './status-engine.js';

type AutoStatus = 'in_progress' | 'completed';

/**
 * Moves one maintenance from `from` to `to` if it still has status `from`.
 * Returns true when this call made the change (and added the update entry).
 */
async function claimTransition(db: DB, id: string, from: 'scheduled' | 'in_progress', to: AutoStatus, now: string) {
  const result = await db
    .updateTable('maintenances')
    .set(
      to === 'in_progress'
        ? { status: to, actual_start: now, updated_at: now }
        : { status: to, actual_end: now, updated_at: now },
    )
    .where('id', '=', id)
    .where('status', '=', from)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows ?? 0) === 0) return false;
  await db
    .insertInto('maintenance_updates')
    .values({ id: newId(), maintenance_id: id, status: to, message: '', created_by: null, created_at: now })
    .execute();
  return true;
}

export async function runMaintenanceTransitions(
  db: DB,
  engine: StatusEngine,
  now = nowIso(),
  notifications?: NotificationService,
): Promise<number> {
  const toStart = await db
    .selectFrom('maintenances')
    .select('id')
    .where('status', '=', 'scheduled')
    .where('auto_start', '=', 1)
    .where('scheduled_start', '<=', now)
    .execute();

  const toComplete = await db
    .selectFrom('maintenances')
    .select('id')
    .where('status', '=', 'in_progress')
    .where('auto_complete', '=', 1)
    .where('scheduled_end', '<=', now)
    .execute();

  // Maintenance windows this run changed.
  const ids = new Set<string>();
  const started: string[] = [];
  for (const { id } of toStart) {
    if (await claimTransition(db, id, 'scheduled', 'in_progress', now)) {
      started.push(id);
      ids.add(id);
    }
  }

  // A window that was missed entirely (e.g. server down) is started and completed,
  // but only by the run that started it.
  const startedAndDue = started.length
    ? await db
        .selectFrom('maintenances')
        .select('id')
        .where('id', 'in', started)
        .where('auto_complete', '=', 1)
        .where('scheduled_end', '<=', now)
        .execute()
    : [];

  for (const { id } of [...toComplete, ...startedAndDue]) {
    if (await claimTransition(db, id, 'in_progress', 'completed', now)) ids.add(id);
  }

  if (ids.size > 0) {
    const services = await db
      .selectFrom('maintenance_services')
      .select('service_id')
      .where('maintenance_id', 'in', [...ids])
      .execute();
    await engine.recompute(services.map((s) => s.service_id));
  }

  if (notifications) {
    for (const id of ids) {
      await notifications.safely('maintenance.auto_transition', () =>
        notifications.maintenanceEvent(id, 'update', { requireStoredFlag: true }),
      );
    }
  }
  return ids.size;
}

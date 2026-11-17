/**
 * Moves maintenance windows through their lifecycle automatically
 * (scheduled → in_progress → completed) when auto_start / auto_complete are set.
 *
 * Automatic transitions add an update with an empty message; clients render a
 * localized default text for empty messages.
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

  // A window that was missed entirely (e.g. server down) is started and completed.
  const ids = new Set<string>();
  for (const { id } of toStart) {
    await db
      .updateTable('maintenances')
      .set({ status: 'in_progress', actual_start: now, updated_at: now })
      .where('id', '=', id)
      .execute();
    await db
      .insertInto('maintenance_updates')
      .values({ id: newId(), maintenance_id: id, status: 'in_progress', message: '', created_by: null, created_at: now })
      .execute();
    ids.add(id);
  }

  const startedAndDue = toStart.length
    ? await db
        .selectFrom('maintenances')
        .select('id')
        .where('id', 'in', toStart.map((m) => m.id))
        .where('auto_complete', '=', 1)
        .where('scheduled_end', '<=', now)
        .execute()
    : [];

  for (const { id } of [...toComplete, ...startedAndDue]) {
    await db
      .updateTable('maintenances')
      .set({ status: 'completed', actual_end: now, updated_at: now })
      .where('id', '=', id)
      .execute();
    await db
      .insertInto('maintenance_updates')
      .values({ id: newId(), maintenance_id: id, status: 'completed', message: '', created_by: null, created_at: now })
      .execute();
    ids.add(id);
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

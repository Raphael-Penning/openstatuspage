import type { DB } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { nowIso } from '../lib/time.js';

export interface AuditEntry {
  userId: string | null;
  /** Verb in the form `<entity>.<action>`, e.g. `incident.create`. */
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: Record<string, unknown> | null;
}

/** Appends an entry to the audit log. Never store secrets in `details`. */
export async function audit(db: DB, entry: AuditEntry): Promise<void> {
  await db
    .insertInto('audit_log')
    .values({
      id: newId(),
      user_id: entry.userId,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      details: entry.details ? JSON.stringify(entry.details) : null,
      created_at: nowIso(),
    })
    .execute();
}

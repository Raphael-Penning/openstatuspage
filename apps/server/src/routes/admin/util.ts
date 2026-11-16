/**
 * Helpers shared by the admin route modules.
 */
import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { badRequest } from '../../lib/errors.js';
import { unique } from '../../lib/http.js';
import { actorUserId, requireRole } from '../../plugins/auth.js';
import { audit } from '../../services/audit.js';

export const editor = { preHandler: requireRole('editor') };
export const admin = { preHandler: requireRole('admin') };

/** Writes an audit entry for the current request. API tokens are recorded by name. */
export async function auditRequest(
  db: Kysely<Database>,
  req: FastifyRequest,
  action: string,
  entityType: string,
  entityId: string | null,
  details?: Record<string, unknown> | null,
): Promise<void> {
  const viaToken = req.authUser?.via === 'token';
  await audit(db, {
    userId: actorUserId(req),
    action,
    entityType,
    entityId,
    details: viaToken ? { ...(details ?? {}), apiToken: req.authUser!.name } : (details ?? null),
  });
}

type ReferencedTable = 'services' | 'locations' | 'service_groups' | 'monitor_checks';

/** Throws 400 when one of `ids` does not exist in `table`. Returns the de-duplicated ids. */
export async function assertExist(
  db: Kysely<Database>,
  table: ReferencedTable,
  ids: string[],
  label: string,
): Promise<string[]> {
  const list = unique(ids);
  if (list.length === 0) return list;
  const rows = await db.selectFrom(table).select('id').where('id', 'in', list).execute();
  if (rows.length !== list.length) {
    const found = new Set(rows.map((r) => r.id));
    throw badRequest(`Unknown ${label}: ${list.filter((id) => !found.has(id)).join(', ')}`);
  }
  return list;
}

/** Sets `sort_order` to the position of each id in `ids`. */
export async function applyOrder(
  db: Kysely<Database>,
  table: 'services' | 'locations' | 'service_groups',
  ids: string[],
): Promise<void> {
  const list = unique(ids);
  await db.transaction().execute(async (trx) => {
    for (const [index, id] of list.entries()) {
      await trx.updateTable(table).set({ sort_order: index }).where('id', '=', id).execute();
    }
  });
}

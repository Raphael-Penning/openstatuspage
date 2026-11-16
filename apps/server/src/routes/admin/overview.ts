import { SERVICE_STATUS_SEVERITY, SettingsInput, type AuditLogEntry } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.js';
import { offsetOf, PageQuery, paginated, parse } from '../../lib/http.js';
import { loadAdminServices } from '../../services/admin-catalog.js';
import { getSettings, saveSettings } from '../../services/settings.js';
import { admin, auditRequest, editor } from './util.js';

const AuditQuery = PageQuery.extend({ entityType: z.string().min(1).max(64).optional() });

async function count(db: DB, build: (db: DB) => { executeTakeFirstOrThrow(): Promise<{ n: number | string | bigint }> }) {
  const row = await build(db).executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function loadAuditEntries(
  db: DB,
  opts: { limit: number; offset: number; entityType?: string },
): Promise<AuditLogEntry[]> {
  let q = db
    .selectFrom('audit_log')
    .leftJoin('users', 'users.id', 'audit_log.user_id')
    .select([
      'audit_log.id',
      'audit_log.user_id',
      'users.name as user_name',
      'audit_log.action',
      'audit_log.entity_type',
      'audit_log.entity_id',
      'audit_log.details',
      'audit_log.created_at',
    ])
    .orderBy('audit_log.created_at', 'desc')
    .orderBy('audit_log.id', 'desc')
    .limit(opts.limit)
    .offset(opts.offset);
  if (opts.entityType) q = q.where('audit_log.entity_type', '=', opts.entityType);
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    userName: r.user_name ?? null,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    details: r.details ? (JSON.parse(r.details) as Record<string, unknown>) : null,
    createdAt: r.created_at,
  }));
}

/** /api/admin/overview, /api/admin/settings and /api/admin/audit-log */
export async function registerOverviewRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;

  app.get('/api/admin/overview', editor, async () => {
    const now = new Date().toISOString();
    const [
      services,
      incidentsActive,
      maintenancesActive,
      maintenancesUpcoming,
      sources,
      sourcesFailing,
      checks,
      checksFailing,
      recentAudit,
    ] = await Promise.all([
      loadAdminServices(db),
      count(db, (d) =>
        d.selectFrom('incidents').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '!=', 'resolved'),
      ),
      count(db, (d) =>
        d.selectFrom('maintenances').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '=', 'in_progress'),
      ),
      count(db, (d) =>
        d
          .selectFrom('maintenances')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('status', '=', 'scheduled')
          .where('scheduled_end', '>', now),
      ),
      count(db, (d) => d.selectFrom('monitor_sources').select((eb) => eb.fn.countAll<number>().as('n'))),
      count(db, (d) =>
        d
          .selectFrom('monitor_sources')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('enabled', '=', 1)
          .where('last_poll_ok', '=', 0),
      ),
      count(db, (d) => d.selectFrom('monitor_checks').select((eb) => eb.fn.countAll<number>().as('n'))),
      count(db, (d) =>
        d
          .selectFrom('monitor_checks')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('state', 'in', ['warning', 'critical']),
      ),
      loadAuditEntries(db, { limit: 10, offset: 0 }),
    ]);

    // Non-operational first (worst first), then display order.
    const ordered = services
      .map((s, index) => ({ s, index }))
      .sort((a, b) => SERVICE_STATUS_SEVERITY[b.s.status] - SERVICE_STATUS_SEVERITY[a.s.status] || a.index - b.index)
      .map((x) => x.s);

    return {
      counts: {
        services: services.length,
        incidentsActive,
        maintenancesActive,
        maintenancesUpcoming,
        sources,
        sourcesFailing,
        checks,
        checksFailing,
      },
      services: ordered,
      recentAudit,
    };
  });

  app.get('/api/admin/settings', editor, async () => getSettings(db));

  app.put('/api/admin/settings', admin, async (req) => {
    const input = parse(SettingsInput, req.body);
    const saved = await saveSettings(db, input);
    await auditRequest(db, req, 'settings.update', 'settings', null, { siteName: input.siteName });
    return saved;
  });

  app.get('/api/admin/audit-log', admin, async (req) => {
    const q = parse(AuditQuery, req.query);
    let totalQuery = db.selectFrom('audit_log').select((eb) => eb.fn.countAll<number>().as('n'));
    if (q.entityType) totalQuery = totalQuery.where('entity_type', '=', q.entityType);
    const [total, items] = await Promise.all([
      totalQuery.executeTakeFirstOrThrow().then((r) => Number(r.n)),
      loadAuditEntries(db, { limit: q.pageSize, offset: offsetOf(q), entityType: q.entityType }),
    ]);
    return paginated(items, total, q);
  });
}

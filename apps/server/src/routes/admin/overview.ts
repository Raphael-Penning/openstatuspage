import { BUNDLE_SOURCE_TYPE, SERVICE_STATUS_SEVERITY, SettingsInput, type AuditLogEntry } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.js';
import { parse } from '../../lib/http.js';
import { collection, document, Included, selfLink } from '../../lib/jsonapi.js';
import { parseListQuery } from '../../lib/jsonapi-query.js';
import { hasRole } from '../../plugins/auth.js';
import { useJsonApi } from '../../plugins/jsonapi.js';
import { adminSettingsResource, AUTH_TYPES, auditEntryResource, overviewResource } from '../../serializers/auth-users.js';
import { loadAdminServices } from '../../services/admin-catalog.js';
import { getSettings, saveSettings } from '../../services/settings.js';
import { admin, auditRequest, editor } from './util.js';

/** `filter[entityType]` of GET /api/admin/audit-log. */
const AuditFilter = { entityType: z.string().min(1).max(64).optional() };

/**
 * Audit entity types editors may see on the dashboard: the ones they can change
 * themselves. Everything else (users, API tokens, monitoring, settings, logins)
 * is admin-only, like the full audit log.
 */
export const EDITOR_AUDIT_ENTITY_TYPES = ['incident', 'maintenance'] as const;

async function count(db: DB, build: (db: DB) => { executeTakeFirstOrThrow(): Promise<{ n: number | string | bigint }> }) {
  const row = await build(db).executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function loadAuditEntries(
  db: DB,
  opts: { limit: number; offset: number; entityType?: string; entityTypes?: readonly string[] },
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
  if (opts.entityTypes) q = q.where('audit_log.entity_type', 'in', [...opts.entityTypes]);
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

/** /api/admin/overview, /api/admin/settings and /api/admin/audit-log (JSON:API) */
export async function registerOverviewRoutes(app: FastifyInstance): Promise<void> {
  await app.register(registerOverviewScope);
}

async function registerOverviewScope(app: FastifyInstance): Promise<void> {
  useJsonApi(app);
  const { db } = app.ctx;
  const instance = { analyticsAvailable: Boolean(app.ctx.config.UMAMI_URL) };

  app.get('/api/admin/overview', editor, async (req) => {
    const now = new Date().toISOString();
    const auditTypes = hasRole(req.authUser!, 'admin') ? undefined : EDITOR_AUDIT_ENTITY_TYPES;
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
      // The virtual bundle source and its checks are left out: a down target would
      // otherwise count twice (each member plus the bundle check).
      count(db, (d) =>
        d
          .selectFrom('monitor_sources')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('type', '!=', BUNDLE_SOURCE_TYPE),
      ),
      count(db, (d) =>
        d
          .selectFrom('monitor_sources')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('type', '!=', BUNDLE_SOURCE_TYPE)
          .where('enabled', '=', 1)
          .where('last_poll_ok', '=', 0),
      ),
      count(db, (d) =>
        d
          .selectFrom('monitor_checks')
          .innerJoin('monitor_sources', 'monitor_sources.id', 'monitor_checks.source_id')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('monitor_sources.type', '!=', BUNDLE_SOURCE_TYPE),
      ),
      count(db, (d) =>
        d
          .selectFrom('monitor_checks')
          .innerJoin('monitor_sources', 'monitor_sources.id', 'monitor_checks.source_id')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('monitor_sources.type', '!=', BUNDLE_SOURCE_TYPE)
          .where('monitor_checks.state', 'in', ['warning', 'critical']),
      ),
      loadAuditEntries(db, { limit: 10, offset: 0, entityTypes: auditTypes }),
    ]);

    // Non-operational first (worst first), then display order.
    const ordered = services
      .map((s, index) => ({ s, index }))
      .sort((a, b) => SERVICE_STATUS_SEVERITY[b.s.status] - SERVICE_STATUS_SEVERITY[a.s.status] || a.index - b.index)
      .map((x) => x.s);

    const included = new Included();
    const overview = overviewResource(
      {
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
      },
      included,
    );
    return document(overview, { included, links: { self: selfLink(req) } });
  });

  app.get('/api/admin/settings', editor, async (req) =>
    document(adminSettingsResource(await getSettings(db), instance), { links: { self: selfLink(req) } }),
  );

  // Partial update: missing attributes keep their current value.
  app.patch('/api/admin/settings', { ...admin, config: { jsonapi: { type: AUTH_TYPES.settings } } }, async (req) => {
    const current = await getSettings(db);
    const input = parse(SettingsInput, { ...current, ...(req.body as object) });
    const saved = await saveSettings(db, input);
    // The accent override is part of the theme stylesheet.
    app.ctx.themes.invalidate();
    await auditRequest(db, req, 'settings.update', 'settings', null, { siteName: input.siteName });
    return document(adminSettingsResource(saved, instance));
  });

  app.get('/api/admin/audit-log', admin, async (req) => {
    const q = parseListQuery(req.query, { page: { defaultSize: 20, maxSize: 100 }, filter: AuditFilter });
    const { entityType } = q.filter;
    let totalQuery = db.selectFrom('audit_log').select((eb) => eb.fn.countAll<number>().as('n'));
    if (entityType) totalQuery = totalQuery.where('entity_type', '=', entityType);
    const [total, items] = await Promise.all([
      totalQuery.executeTakeFirstOrThrow().then((r) => Number(r.n)),
      loadAuditEntries(db, { limit: q.page.size, offset: q.page.offset, entityType }),
    ]);
    return collection(req, items.map(auditEntryResource), { page: q.page, total });
  });
}

/**
 * Monitoring sources (CRUD, token rotation) and checks as JSON:API resources
 * ("monitor-sources", "monitor-checks"; see serializers/monitoring.ts).
 * Test / poll endpoints and ingest live in src/adapters (owned by the adapters).
 *
 *   GET    /api/admin/monitor-sources
 *   POST   /api/admin/monitor-sources                   201; the ingest token is an attribute once
 *   GET    /api/admin/monitor-sources/:id
 *   PATCH  /api/admin/monitor-sources/:id               partial update
 *   DELETE /api/admin/monitor-sources/:id
 *   POST   /api/admin/monitor-sources/:id/rotate-token  meta: { ingestToken }
 *   GET    /api/admin/checks?filter[source]=&filter[q]=&filter[state]=&filter[unlinked]=
 *   GET    /api/admin/checks/:id
 *   DELETE /api/admin/checks/:id
 */
import {
  BUNDLE_SOURCE_TYPE,
  MonitorSourceInput,
  SECRET_MASK,
  zCheckState,
  zId,
  type AdminMonitorSource,
} from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { syncPollers } from '../../adapters/poller.js';
import type { DB } from '../../db/index.js';
import { sha256 } from '../../lib/crypto.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { newId, newToken } from '../../lib/ids.js';
import { IdParams, parse, zQueryBool } from '../../lib/http.js';
import { collection, created, document, metaDocument, noContent, selfLink } from '../../lib/jsonapi.js';
import { parseFilter } from '../../lib/jsonapi-query.js';
import { nowIso } from '../../lib/time.js';
import { useJsonApi } from '../../plugins/jsonapi.js';
import { checkResource, MONITORING_TYPES, sourceLink, sourceResource } from '../../serializers/monitoring.js';
import {
  decryptSourceConfig,
  loadAdminChecks,
  loadAdminSources,
  SECRET_FIELDS,
  SELF_CONTAINED_SECRETS,
} from '../../services/admin-catalog.js';
import { admin, auditRequest, editor } from './util.js';

/** `filter[...]` parameters of GET /api/admin/checks. */
const ChecksFilter = {
  source: zId.optional(),
  q: z.string().max(200).optional(),
  state: zCheckState.optional(),
  unlinked: zQueryBool.optional(),
};

const MANAGED_SOURCE = 'The check bundle source is managed automatically; edit the bundles instead.';

/** 400 for a secret that has to be sent (again), pointing at the config field. */
function secretRequired(key: string, message = `config.${key} must be provided`) {
  return badRequest(message, [{ path: ['config', key], message, code: 'secret_required' }]);
}

async function servicesOfSource(db: DB, sourceId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('service_checks')
    .innerJoin('monitor_checks', 'monitor_checks.id', 'service_checks.check_id')
    .select('service_checks.service_id')
    .distinct()
    .where('monitor_checks.source_id', '=', sourceId)
    .execute();
  return rows.map((r) => r.service_id);
}

/** /api/admin/monitor-sources and /api/admin/checks */
export async function registerMonitoringRoutes(root: FastifyInstance): Promise<void> {
  await root.register(monitoringRoutes);
}

async function monitoringRoutes(app: FastifyInstance): Promise<void> {
  useJsonApi(app);
  const { ctx } = app;
  const { db, engine, secrets, config } = ctx;
  const sourceBody = { config: { jsonapi: { type: MONITORING_TYPES.source } } };

  const getSource = async (id: string): Promise<AdminMonitorSource> => {
    const [source] = await loadAdminSources(db, secrets, config.BASE_URL, [id]);
    if (!source) throw notFound('Monitoring source');
    return source;
  };

  app.get('/api/admin/monitor-sources', admin, async (req) =>
    collection(req, (await loadAdminSources(db, secrets, config.BASE_URL)).map((s) => sourceResource(s))),
  );

  app.post('/api/admin/monitor-sources', { ...admin, ...sourceBody }, async (req, reply) => {
    const input = parse(MonitorSourceInput, req.body);
    const sourceConfig = input.config as Record<string, unknown>;
    for (const key of SECRET_FIELDS) {
      if (sourceConfig[key] === SECRET_MASK) throw secretRequired(key);
    }
    const id = newId();
    const token = newToken();
    const now = nowIso();
    await db
      .insertInto('monitor_sources')
      .values({
        id,
        name: input.name,
        type: input.sourceType,
        enabled: input.enabled ? 1 : 0,
        config_encrypted: secrets.encryptJson(sourceConfig),
        poll_interval_seconds: input.pollIntervalSeconds,
        ingest_token_hash: sha256(token),
        last_poll_at: null,
        last_poll_ok: null,
        last_error: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    // Never log the config: it contains credentials.
    await auditRequest(db, req, 'monitor_source.create', 'monitor_source', id, { name: input.name, type: input.sourceType });
    await syncPollers(ctx);
    // The token is shown once: only this response carries it.
    return created(reply, document(sourceResource(await getSource(id), { ingestToken: token })), sourceLink(id));
  });

  app.get('/api/admin/monitor-sources/:id', admin, async (req) =>
    document(sourceResource(await getSource(parse(IdParams, req.params).id)), { links: { self: selfLink(req) } }),
  );

  app.patch('/api/admin/monitor-sources/:id', { ...admin, ...sourceBody }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const current = await db.selectFrom('monitor_sources').selectAll().where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Monitoring source');
    if (current.type === BUNDLE_SOURCE_TYPE) throw conflict(MANAGED_SOURCE);

    // Partial update: attributes left out keep their stored values. The config is
    // replaced as a whole; it is kept when it is left out and the type stays.
    const changes = (req.body ?? {}) as Record<string, unknown>;
    const nextType = changes.sourceType ?? current.type;
    const input = parse(MonitorSourceInput, {
      name: current.name,
      sourceType: current.type,
      enabled: current.enabled === 1,
      pollIntervalSeconds: current.poll_interval_seconds,
      ...changes,
      config: 'config' in changes ? changes.config : nextType === current.type ? decryptSourceConfig(secrets, current) : undefined,
    });

    // SECRET_MASK means "keep the stored value". Only allowed when the type, URL and
    // username are unchanged, so stored credentials can never be redirected to another host.
    const stored = current.type === input.sourceType ? decryptSourceConfig(secrets, current) : {};
    const sourceConfig = { ...(input.config as Record<string, unknown>) };
    // The history login of Uptime Kuma belongs to its own user name.
    const sameTarget = (key: string) =>
      ['baseUrl', key === 'historyPassword' ? 'historyUsername' : 'username'].every(
        (k) => (sourceConfig[k] ?? null) === (stored[k] ?? null),
      );
    for (const key of SECRET_FIELDS) {
      if (sourceConfig[key] !== SECRET_MASK) continue;
      const previous = stored[key];
      if (typeof previous !== 'string' || previous === '') throw secretRequired(key);
      if (!SELF_CONTAINED_SECRETS.includes(key) && !sameTarget(key)) {
        throw secretRequired(key, `config.${key} must be entered again when the URL or username changes`);
      }
      sourceConfig[key] = previous;
    }

    await db
      .updateTable('monitor_sources')
      .set({
        name: input.name,
        type: input.sourceType,
        enabled: input.enabled ? 1 : 0,
        config_encrypted: secrets.encryptJson(sourceConfig),
        poll_interval_seconds: input.pollIntervalSeconds,
        updated_at: nowIso(),
      })
      .where('id', '=', id)
      .execute();
    // Enabling/disabling a source changes which checks count.
    if ((current.enabled === 1) !== input.enabled) await engine.recompute(await servicesOfSource(db, id));
    // Enabled state and poll interval decide whether its checks count in bundle votes.
    await ctx.bundles.recomputeForSource(id);
    await auditRequest(db, req, 'monitor_source.update', 'monitor_source', id, {
      name: input.name,
      type: input.sourceType,
      enabled: input.enabled,
    });
    await syncPollers(ctx);
    return document(sourceResource(await getSource(id)), { links: { self: selfLink(req) } });
  });

  app.delete('/api/admin/monitor-sources/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const current = await db.selectFrom('monitor_sources').select(['name', 'type']).where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Monitoring source');
    if (current.type === BUNDLE_SOURCE_TYPE) {
      const bundle = await db.selectFrom('check_bundles').select('id').limit(1).executeTakeFirst();
      if (bundle) throw conflict('The check bundle source cannot be deleted while check bundles exist.');
    }
    const affected = await servicesOfSource(db, id);
    const affectedBundles = await ctx.bundles.bundlesOfSource(id);
    // Checks, their service links and bundle memberships cascade.
    await db.deleteFrom('monitor_sources').where('id', '=', id).execute();
    await engine.recompute(affected);
    await ctx.bundles.recompute(affectedBundles);
    await auditRequest(db, req, 'monitor_source.delete', 'monitor_source', id, { name: current.name, type: current.type });
    await syncPollers(ctx);
    return noContent(reply);
  });

  app.post('/api/admin/monitor-sources/:id/rotate-token', admin, async (req) => {
    const { id } = parse(IdParams, req.params);
    const source = await db.selectFrom('monitor_sources').select('type').where('id', '=', id).executeTakeFirst();
    if (source?.type === BUNDLE_SOURCE_TYPE) throw conflict(MANAGED_SOURCE);
    const token = newToken();
    const result = await db
      .updateTable('monitor_sources')
      .set({ ingest_token_hash: sha256(token), updated_at: nowIso() })
      .where('id', '=', id)
      // The bundle source accepts no ingest: it never gets a usable token.
      .where('type', '!=', BUNDLE_SOURCE_TYPE)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw notFound('Monitoring source');
    await auditRequest(db, req, 'monitor_source.rotate_token', 'monitor_source', id);
    return metaDocument({ ingestToken: token });
  });

  // --- Checks --------------------------------------------------------------------

  // Not paginated: the check pickers work on the whole (filtered) list.
  app.get('/api/admin/checks', editor, async (req) => {
    const filter = parseFilter((req.query ?? {}) as Record<string, unknown>, ChecksFilter);
    const checks = await loadAdminChecks(db, {
      sourceId: filter.source,
      q: filter.q?.trim() || undefined,
      state: filter.state,
      unlinked: filter.unlinked,
    });
    return collection(req, checks.map(checkResource));
  });

  app.get('/api/admin/checks/:id', editor, async (req) => {
    const { id } = parse(IdParams, req.params);
    const [check] = await loadAdminChecks(db, { ids: [id] });
    if (!check) throw notFound('Check');
    return document(checkResource(check), { links: { self: selfLink(req) } });
  });

  app.delete('/api/admin/checks/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const check = await db
      .selectFrom('monitor_checks')
      .select(['id', 'name', 'source_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!check) throw notFound('Check');
    const bundle = await db.selectFrom('check_bundles').select('id').where('check_id', '=', id).executeTakeFirst();
    if (bundle) throw conflict('This is the check of a bundle; delete the bundle instead.');
    const links = await db.selectFrom('service_checks').select('service_id').where('check_id', '=', id).execute();
    const affectedBundles = await ctx.bundles.bundlesOfChecks([id]);
    await db.deleteFrom('monitor_checks').where('id', '=', id).execute();
    await engine.recompute(links.map((l) => l.service_id));
    await ctx.bundles.recompute(affectedBundles);
    await auditRequest(db, req, 'check.delete', 'check', id, { sourceId: check.source_id });
    return noContent(reply);
  });
}

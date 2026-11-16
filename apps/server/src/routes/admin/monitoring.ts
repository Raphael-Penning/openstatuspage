/**
 * Monitoring sources (CRUD, token rotation) and checks.
 * Test / poll endpoints and ingest live in src/adapters (owned by the adapters).
 */
import { MonitorSourceInput, SECRET_MASK, zCheckState, zId, type AdminMonitorSource } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { syncPollers } from '../../adapters/poller.js';
import type { DB } from '../../db/index.js';
import { sha256 } from '../../lib/crypto.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { newId, newToken } from '../../lib/ids.js';
import { IdParams, parse, zQueryBool } from '../../lib/http.js';
import { nowIso } from '../../lib/time.js';
import {
  decryptSourceConfig,
  loadAdminChecks,
  loadAdminSources,
  SECRET_FIELDS,
} from '../../services/admin-catalog.js';
import { admin, auditRequest, editor } from './util.js';

const ChecksQuery = z.object({
  sourceId: zId.optional(),
  q: z.string().max(200).optional(),
  state: zCheckState.optional(),
  unlinked: zQueryBool.optional(),
});

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
export async function registerMonitoringRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;
  const { db, engine, secrets, config } = ctx;

  const getSource = async (id: string): Promise<AdminMonitorSource> => {
    const [source] = await loadAdminSources(db, secrets, config.BASE_URL, [id]);
    if (!source) throw notFound('Monitoring source');
    return source;
  };

  app.get('/api/admin/monitor-sources', admin, async () => loadAdminSources(db, secrets, config.BASE_URL));

  app.post('/api/admin/monitor-sources', admin, async (req, reply) => {
    const input = parse(MonitorSourceInput, req.body);
    const sourceConfig = input.config as Record<string, unknown>;
    for (const key of SECRET_FIELDS) {
      if (sourceConfig[key] === SECRET_MASK) throw badRequest(`config.${key} must be provided`);
    }
    const id = newId();
    const token = newToken();
    const now = nowIso();
    await db
      .insertInto('monitor_sources')
      .values({
        id,
        name: input.name,
        type: input.type,
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
    await auditRequest(db, req, 'monitor_source.create', 'monitor_source', id, { name: input.name, type: input.type });
    await syncPollers(ctx);
    return reply.status(201).send({ ...(await getSource(id)), ingestToken: token });
  });

  app.get('/api/admin/monitor-sources/:id', admin, async (req) => getSource(parse(IdParams, req.params).id));

  app.put('/api/admin/monitor-sources/:id', admin, async (req) => {
    const { id } = parse(IdParams, req.params);
    const input = parse(MonitorSourceInput, req.body);
    const current = await db.selectFrom('monitor_sources').selectAll().where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Monitoring source');

    // SECRET_MASK means "keep the stored value" (only possible when the type is unchanged).
    const stored = current.type === input.type ? decryptSourceConfig(secrets, current) : {};
    const sourceConfig = { ...(input.config as Record<string, unknown>) };
    for (const key of SECRET_FIELDS) {
      if (sourceConfig[key] !== SECRET_MASK) continue;
      const previous = stored[key];
      if (typeof previous !== 'string' || previous === '') throw badRequest(`config.${key} must be provided`);
      sourceConfig[key] = previous;
    }

    await db
      .updateTable('monitor_sources')
      .set({
        name: input.name,
        type: input.type,
        enabled: input.enabled ? 1 : 0,
        config_encrypted: secrets.encryptJson(sourceConfig),
        poll_interval_seconds: input.pollIntervalSeconds,
        updated_at: nowIso(),
      })
      .where('id', '=', id)
      .execute();
    // Enabling/disabling a source changes which checks count.
    if ((current.enabled === 1) !== input.enabled) await engine.recompute(await servicesOfSource(db, id));
    await auditRequest(db, req, 'monitor_source.update', 'monitor_source', id, {
      name: input.name,
      type: input.type,
      enabled: input.enabled,
    });
    await syncPollers(ctx);
    return getSource(id);
  });

  app.delete('/api/admin/monitor-sources/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const current = await db.selectFrom('monitor_sources').select(['name', 'type']).where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Monitoring source');
    const affected = await servicesOfSource(db, id);
    // Checks and their service links cascade.
    await db.deleteFrom('monitor_sources').where('id', '=', id).execute();
    await engine.recompute(affected);
    await auditRequest(db, req, 'monitor_source.delete', 'monitor_source', id, { name: current.name, type: current.type });
    await syncPollers(ctx);
    return reply.status(204).send();
  });

  app.post('/api/admin/monitor-sources/:id/rotate-token', admin, async (req) => {
    const { id } = parse(IdParams, req.params);
    const token = newToken();
    const result = await db
      .updateTable('monitor_sources')
      .set({ ingest_token_hash: sha256(token), updated_at: nowIso() })
      .where('id', '=', id)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw notFound('Monitoring source');
    await auditRequest(db, req, 'monitor_source.rotate_token', 'monitor_source', id);
    return { ingestToken: token };
  });

  // --- Checks --------------------------------------------------------------------

  app.get('/api/admin/checks', editor, async (req) => {
    const q = parse(ChecksQuery, req.query);
    return loadAdminChecks(db, {
      sourceId: q.sourceId,
      q: q.q?.trim() || undefined,
      state: q.state,
      unlinked: q.unlinked,
    });
  });

  app.delete('/api/admin/checks/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const check = await db
      .selectFrom('monitor_checks')
      .select(['id', 'name', 'source_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!check) throw notFound('Check');
    const links = await db.selectFrom('service_checks').select('service_id').where('check_id', '=', id).execute();
    await db.deleteFrom('monitor_checks').where('id', '=', id).execute();
    await engine.recompute(links.map((l) => l.service_id));
    await auditRequest(db, req, 'check.delete', 'check', id, { sourceId: check.source_id });
    return reply.status(204).send();
  });
}

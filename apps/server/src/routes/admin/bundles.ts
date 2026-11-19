/**
 * Check bundles (admin only): weighted voting over checks of several monitoring
 * sources. Each bundle owns one check of the virtual "bundle" source, which is
 * linked to services like any other check.
 *
 *   GET    /api/admin/check-bundles
 *   GET    /api/admin/check-bundles/candidates?type=<source type>
 *   GET    /api/admin/check-bundles/:id
 *   POST   /api/admin/check-bundles
 *   PUT    /api/admin/check-bundles/:id
 *   DELETE /api/admin/check-bundles/:id
 */
import {
  BUNDLE_SOURCE_TYPE,
  CheckBundleInput,
  CONFIGURABLE_SOURCE_TYPES,
  type AdminCheckBundle,
  type BundleCandidateSource,
} from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { IdParams, parse } from '../../lib/http.js';
import { nowIso } from '../../lib/time.js';
import { admin, auditRequest } from './util.js';

const CandidatesQuery = z.object({ type: z.enum(CONFIGURABLE_SOURCE_TYPES).optional() });

/** Member checks must exist and must not be bundle checks (no nesting). */
async function assertMemberChecks(db: DB, checkIds: string[]): Promise<void> {
  if (checkIds.length === 0) return;
  const rows = await db
    .selectFrom('monitor_checks')
    .innerJoin('monitor_sources', 'monitor_sources.id', 'monitor_checks.source_id')
    .select(['monitor_checks.id', 'monitor_sources.type'])
    .where('monitor_checks.id', 'in', checkIds)
    .execute();
  const found = new Map(rows.map((r) => [r.id, r.type]));
  const missing = checkIds.filter((id) => !found.has(id));
  if (missing.length > 0) throw badRequest(`Unknown checks: ${missing.join(', ')}`);
  if (rows.some((r) => r.type === BUNDLE_SOURCE_TYPE)) {
    throw badRequest('A bundle cannot contain the check of another bundle');
  }
}

export async function registerBundleRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;
  const { db, engine, bundles } = ctx;

  const getBundle = async (id: string): Promise<AdminCheckBundle> => {
    const [bundle] = await bundles.loadAdmin([id]);
    if (!bundle) throw notFound('Check bundle');
    return bundle;
  };

  app.get('/api/admin/check-bundles', admin, async () => bundles.loadAdmin());

  app.get('/api/admin/check-bundles/candidates', admin, async (req): Promise<BundleCandidateSource[]> => {
    const q = parse(CandidatesQuery, req.query);
    let sourcesQuery = db
      .selectFrom('monitor_sources')
      .select(['id', 'name', 'type', 'enabled'])
      .where('type', '!=', BUNDLE_SOURCE_TYPE)
      .orderBy('name')
      .orderBy('id');
    if (q.type) sourcesQuery = sourcesQuery.where('type', '=', q.type);
    const sources = await sourcesQuery.execute();
    if (sources.length === 0) return [];
    const checks = await db
      .selectFrom('monitor_checks')
      .select(['id', 'source_id', 'name', 'host', 'state', 'last_check_at'])
      .where(
        'source_id',
        'in',
        sources.map((s) => s.id),
      )
      .orderBy('host')
      .orderBy('name')
      .execute();
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      enabled: s.enabled === 1,
      checks: checks
        .filter((c) => c.source_id === s.id)
        .map((c) => ({ id: c.id, name: c.name, host: c.host, state: c.state, lastCheckAt: c.last_check_at })),
    }));
  });

  app.get('/api/admin/check-bundles/:id', admin, async (req) => getBundle(parse(IdParams, req.params).id));

  app.post('/api/admin/check-bundles', admin, async (req, reply) => {
    const input = parse(CheckBundleInput, req.body);
    await assertMemberChecks(db, input.members.map((m) => m.checkId));
    const id = newId();
    const checkId = newId();
    const now = nowIso();
    await db.transaction().execute(async (trx) => {
      const sourceId = await bundles.ensureSource(trx);
      await trx
        .insertInto('monitor_checks')
        .values({
          id: checkId,
          source_id: sourceId,
          external_id: id,
          name: input.name,
          host: null,
          state: 'unknown',
          output: null,
          last_check_at: null,
          last_state_change_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await trx
        .insertInto('check_bundles')
        .values({ id, name: input.name, description: input.description ?? null, check_id: checkId, created_at: now, updated_at: now })
        .execute();
      if (input.members.length > 0) {
        await trx
          .insertInto('check_bundle_members')
          .values(input.members.map((m) => ({ bundle_id: id, check_id: m.checkId, votes: m.votes })))
          .execute();
      }
    });
    await bundles.recompute([id]);
    await auditRequest(db, req, 'check_bundle.create', 'check_bundle', id, {
      name: input.name,
      members: input.members.map((m) => ({ checkId: m.checkId, votes: m.votes })),
    });
    return reply.status(201).send(await getBundle(id));
  });

  app.put('/api/admin/check-bundles/:id', admin, async (req) => {
    const { id } = parse(IdParams, req.params);
    const input = parse(CheckBundleInput, req.body);
    const current = await db.selectFrom('check_bundles').selectAll().where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Check bundle');
    await assertMemberChecks(db, input.members.map((m) => m.checkId));
    const now = nowIso();
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('check_bundles')
        .set({ name: input.name, description: input.description ?? null, updated_at: now })
        .where('id', '=', id)
        .execute();
      // The bundle check carries the bundle's name in check lists and service links.
      await trx.updateTable('monitor_checks').set({ name: input.name, updated_at: now }).where('id', '=', current.check_id).execute();
      await trx.deleteFrom('check_bundle_members').where('bundle_id', '=', id).execute();
      if (input.members.length > 0) {
        await trx
          .insertInto('check_bundle_members')
          .values(input.members.map((m) => ({ bundle_id: id, check_id: m.checkId, votes: m.votes })))
          .execute();
      }
    });
    await bundles.recompute([id]);
    await auditRequest(db, req, 'check_bundle.update', 'check_bundle', id, {
      name: input.name,
      members: input.members.map((m) => ({ checkId: m.checkId, votes: m.votes })),
    });
    return getBundle(id);
  });

  app.delete('/api/admin/check-bundles/:id', admin, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const current = await db.selectFrom('check_bundles').selectAll().where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Check bundle');
    const links = await db.selectFrom('service_checks').select('service_id').where('check_id', '=', current.check_id).execute();
    // Deleting the bundle check cascades to the bundle, its members and its service links.
    await db.deleteFrom('monitor_checks').where('id', '=', current.check_id).execute();
    await engine.recompute(links.map((l) => l.service_id));
    await auditRequest(db, req, 'check_bundle.delete', 'check_bundle', id, { name: current.name });
    return reply.status(204).send();
  });
}

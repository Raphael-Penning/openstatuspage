/**
 * Check bundles (admin only): weighted voting over checks of several monitoring
 * sources. Each bundle owns one check of the virtual "bundle" source, which is
 * linked to services like any other check. JSON:API type "check-bundles"
 * (relationship `check`; `members` and `vote` are attributes).
 *
 *   GET    /api/admin/check-bundles
 *   GET    /api/admin/check-bundles/candidates?filter[sourceType]=<source type>
 *          monitor-sources with their checks (relationship `checks`, included)
 *   GET    /api/admin/check-bundles/:id
 *   POST   /api/admin/check-bundles
 *   PATCH  /api/admin/check-bundles/:id   partial update (`members` replaces the list)
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
import { collection, created, document, Included, noContent, selfLink } from '../../lib/jsonapi.js';
import { parseFilter } from '../../lib/jsonapi-query.js';
import { nowIso } from '../../lib/time.js';
import { useJsonApi } from '../../plugins/jsonapi.js';
import { bundleLink, bundleResource, candidateSourceResource, MONITORING_TYPES } from '../../serializers/monitoring.js';
import { admin, auditRequest } from './util.js';
import { recordCheckState } from '../../services/check-history.js';

const CandidatesFilter = { sourceType: z.enum(CONFIGURABLE_SOURCE_TYPES).optional() };

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
  if (missing.length > 0) {
    const message = `Unknown checks: ${missing.join(', ')}`;
    throw badRequest(message, [{ path: ['members'], message, code: 'unknown_checks', checkIds: missing }]);
  }
  if (rows.some((r) => r.type === BUNDLE_SOURCE_TYPE)) {
    const message = 'A bundle cannot contain the check of another bundle';
    throw badRequest(message, [{ path: ['members'], message, code: 'nested_bundle' }]);
  }
}

export async function registerBundleRoutes(root: FastifyInstance): Promise<void> {
  await root.register(bundleRoutes);
}

async function bundleRoutes(app: FastifyInstance): Promise<void> {
  useJsonApi(app);
  const { ctx } = app;
  const { db, engine, bundles } = ctx;
  const bundleBody = { config: { jsonapi: { type: MONITORING_TYPES.bundle } } };

  const getBundle = async (id: string): Promise<AdminCheckBundle> => {
    const [bundle] = await bundles.loadAdmin([id]);
    if (!bundle) throw notFound('Check bundle');
    return bundle;
  };

  app.get('/api/admin/check-bundles', admin, async (req) => collection(req, (await bundles.loadAdmin()).map(bundleResource)));

  app.get('/api/admin/check-bundles/candidates', admin, async (req) => {
    const filter = parseFilter((req.query ?? {}) as Record<string, unknown>, CandidatesFilter);
    let sourcesQuery = db
      .selectFrom('monitor_sources')
      .select(['id', 'name', 'type', 'enabled'])
      .where('type', '!=', BUNDLE_SOURCE_TYPE)
      .orderBy('name')
      .orderBy('id');
    if (filter.sourceType) sourcesQuery = sourcesQuery.where('type', '=', filter.sourceType);
    const sources = await sourcesQuery.execute();
    const checks =
      sources.length === 0
        ? []
        : await db
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
    const candidates: BundleCandidateSource[] = sources.map((s) => ({
      id: s.id,
      name: s.name,
      sourceType: s.type,
      enabled: s.enabled === 1,
      checks: checks
        .filter((c) => c.source_id === s.id)
        .map((c) => ({ id: c.id, name: c.name, host: c.host, state: c.state, lastCheckAt: c.last_check_at })),
    }));
    const included = new Included();
    return collection(
      req,
      candidates.map((c) => candidateSourceResource(c, included)),
      { included },
    );
  });

  app.get('/api/admin/check-bundles/:id', admin, async (req) =>
    document(bundleResource(await getBundle(parse(IdParams, req.params).id)), { links: { self: selfLink(req) } }),
  );

  app.post('/api/admin/check-bundles', { ...admin, ...bundleBody }, async (req, reply) => {
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
      await recordCheckState(trx, checkId, 'unknown', now);
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
    return created(reply, document(bundleResource(await getBundle(id))), bundleLink(id));
  });

  app.patch('/api/admin/check-bundles/:id', { ...admin, ...bundleBody }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const current = await db.selectFrom('check_bundles').selectAll().where('id', '=', id).executeTakeFirst();
    if (!current) throw notFound('Check bundle');
    // Partial update: attributes left out keep their stored values.
    const members = await db
      .selectFrom('check_bundle_members')
      .select(['check_id as checkId', 'votes'])
      .where('bundle_id', '=', id)
      .execute();
    const input = parse(CheckBundleInput, {
      name: current.name,
      description: current.description,
      members,
      ...((req.body ?? {}) as Record<string, unknown>),
    });
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
    return document(bundleResource(await getBundle(id)), { links: { self: selfLink(req) } });
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
    return noContent(reply);
  });
}

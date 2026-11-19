/**
 * History imports of a monitoring source (admin only), JSON:API type
 * "history-imports" (relationships `source` and `createdBy`, the user is
 * included by default; `include=` leaves it out):
 *   GET  /api/admin/monitor-sources/:id/history-imports                     recent jobs (without previews)
 *   POST /api/admin/monitor-sources/:id/history-imports                     start (fetch + preview), 202
 *   GET  /api/admin/monitor-sources/:id/history-imports/:importId           status, progress, preview
 *   POST /api/admin/monitor-sources/:id/history-imports/:importId/apply     write the previewed data, 202
 *   POST /api/admin/monitor-sources/:id/history-imports/:importId/cancel    abort or discard
 */
import { HISTORY_CSV_MAX_CHARS, HistoryImportCreateInput, zId, type AdminHistoryImport } from '@openstatuspage/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../lib/errors.js';
import { IdParams, parse } from '../../lib/http.js';
import { collection, document, Included, selfLink } from '../../lib/jsonapi.js';
import { parseInclude } from '../../lib/jsonapi-query.js';
import { useJsonApi } from '../../plugins/jsonapi.js';
import { historyImportLink, historyImportResource, MONITORING_TYPES } from '../../serializers/monitoring.js';
import type { Actor } from '../../services/history-import.js';
import { admin } from './util.js';

const ImportParams = z.object({ id: zId, importId: zId });

const INCLUDES = ['createdBy'];

function actorOf(req: FastifyRequest): Actor {
  const user = req.authUser;
  return {
    userId: user?.via === 'session' ? user.id : null,
    apiToken: user?.via === 'token' ? user.name : null,
  };
}

/** `included` for the requested paths (only `createdBy` exists). */
function includedFor(req: FastifyRequest): { included: Included; keep: boolean } {
  const include = parseInclude((req.query ?? {}) as Record<string, unknown>, INCLUDES, INCLUDES);
  return { included: new Included(), keep: include.has('createdBy') };
}

export async function registerHistoryImportRoutes(root: FastifyInstance): Promise<void> {
  await root.register(historyImportRoutes);
}

async function historyImportRoutes(app: FastifyInstance): Promise<void> {
  useJsonApi(app);
  const { db, historyImports } = app.ctx;

  const loadSource = async (id: string) => {
    const source = await db.selectFrom('monitor_sources').selectAll().where('id', '=', id).executeTakeFirst();
    if (!source) throw notFound('Monitoring source');
    return source;
  };

  /** Single job document (self link to the job, not to the action URL). */
  const jobDocument = (req: FastifyRequest, job: AdminHistoryImport) => {
    const { included, keep } = includedFor(req);
    const res = historyImportResource(job, included);
    return document(res, { included: keep ? included : undefined, links: { self: historyImportLink(job.sourceId, job.id) } });
  };

  app.get('/api/admin/monitor-sources/:id/history-imports', admin, async (req) => {
    const { id } = parse(IdParams, req.params);
    await loadSource(id);
    const { included, keep } = includedFor(req);
    const jobs = (await historyImports.list(id)).map((job) => historyImportResource(job, included));
    return collection(req, jobs, { included: keep ? included : undefined });
  });

  app.post(
    '/api/admin/monitor-sources/:id/history-imports',
    // CSV uploads are sent as JSON strings: allow the documented size plus overhead.
    {
      ...admin,
      bodyLimit: HISTORY_CSV_MAX_CHARS * 2 + 64 * 1024,
      config: { jsonapi: { type: MONITORING_TYPES.historyImport } },
    },
    async (req, reply) => {
      const { id } = parse(IdParams, req.params);
      const input = parse(HistoryImportCreateInput, req.body);
      const source = await loadSource(id);
      const job = await historyImports.create(source, input, actorOf(req));
      // 202: the job runs in the background; poll its self link.
      return reply.status(202).header('location', historyImportLink(id, job.id)).send(jobDocument(req, job));
    },
  );

  app.get('/api/admin/monitor-sources/:id/history-imports/:importId', admin, async (req) => {
    const { id, importId } = parse(ImportParams, req.params);
    const job = await historyImports.get(id, importId);
    const doc = jobDocument(req, job);
    return { ...doc, links: { self: selfLink(req) } };
  });

  app.post('/api/admin/monitor-sources/:id/history-imports/:importId/apply', admin, async (req, reply) => {
    const { id, importId } = parse(ImportParams, req.params);
    return reply.status(202).send(jobDocument(req, await historyImports.apply(id, importId, actorOf(req))));
  });

  app.post('/api/admin/monitor-sources/:id/history-imports/:importId/cancel', admin, async (req) => {
    const { id, importId } = parse(ImportParams, req.params);
    return jobDocument(req, await historyImports.cancel(id, importId, actorOf(req)));
  });
}

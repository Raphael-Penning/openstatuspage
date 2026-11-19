/**
 * History imports of a monitoring source (admin only):
 *   GET  /api/admin/monitor-sources/:id/history-imports                     recent jobs
 *   POST /api/admin/monitor-sources/:id/history-imports                     start (fetch + preview)
 *   GET  /api/admin/monitor-sources/:id/history-imports/:importId           status, progress, preview
 *   POST /api/admin/monitor-sources/:id/history-imports/:importId/apply     write the previewed data
 *   POST /api/admin/monitor-sources/:id/history-imports/:importId/cancel    abort or discard
 */
import { HISTORY_CSV_MAX_CHARS, HistoryImportCreateInput, zId } from '@openstatuspage/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../lib/errors.js';
import { IdParams, parse } from '../../lib/http.js';
import type { Actor } from '../../services/history-import.js';
import { admin } from './util.js';

const ImportParams = z.object({ id: zId, importId: zId });

function actorOf(req: FastifyRequest): Actor {
  const user = req.authUser;
  return {
    userId: user?.via === 'session' ? user.id : null,
    apiToken: user?.via === 'token' ? user.name : null,
  };
}

export async function registerHistoryImportRoutes(app: FastifyInstance): Promise<void> {
  const { db, historyImports } = app.ctx;

  const loadSource = async (id: string) => {
    const source = await db.selectFrom('monitor_sources').selectAll().where('id', '=', id).executeTakeFirst();
    if (!source) throw notFound('Monitoring source');
    return source;
  };

  app.get('/api/admin/monitor-sources/:id/history-imports', admin, async (req) => {
    const { id } = parse(IdParams, req.params);
    await loadSource(id);
    return historyImports.list(id);
  });

  app.post(
    '/api/admin/monitor-sources/:id/history-imports',
    // CSV uploads are sent as JSON strings: allow the documented size plus overhead.
    { ...admin, bodyLimit: HISTORY_CSV_MAX_CHARS * 2 + 64 * 1024 },
    async (req, reply) => {
      const { id } = parse(IdParams, req.params);
      const input = parse(HistoryImportCreateInput, req.body);
      const source = await loadSource(id);
      const job = await historyImports.create(source, input, actorOf(req));
      return reply.status(202).send(job);
    },
  );

  app.get('/api/admin/monitor-sources/:id/history-imports/:importId', admin, async (req) => {
    const { id, importId } = parse(ImportParams, req.params);
    return historyImports.get(id, importId);
  });

  app.post('/api/admin/monitor-sources/:id/history-imports/:importId/apply', admin, async (req, reply) => {
    const { id, importId } = parse(ImportParams, req.params);
    return reply.status(202).send(await historyImports.apply(id, importId, actorOf(req)));
  });

  app.post('/api/admin/monitor-sources/:id/history-imports/:importId/cancel', admin, async (req) => {
    const { id, importId } = parse(ImportParams, req.params);
    return historyImports.cancel(id, importId, actorOf(req));
  });
}

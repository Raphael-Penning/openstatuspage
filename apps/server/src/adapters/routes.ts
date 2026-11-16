/**
 * Routes owned by the monitoring adapters:
 *   POST /api/ingest/:sourceId[/<type>]           push endpoints (source token)
 *   POST /api/admin/monitor-sources/:id/test      test connection (admin)
 *   POST /api/admin/monitor-sources/:id/poll      poll now (admin)
 *
 * STUB in feat/core, implemented together with the adapters.
 */
import type { FastifyInstance } from 'fastify';

export async function registerAdapterRoutes(_app: FastifyInstance): Promise<void> {}

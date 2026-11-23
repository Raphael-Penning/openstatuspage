/**
 * GET /uploads/<sha256>.<ext>: the images uploaded in the management UI
 * (services/uploads.ts), on every role that serves the public API.
 *
 * The name is the SHA-256 of the bytes, so a URL never changes its content:
 * cached for a year as immutable. The Content-Type is the one detected from the
 * magic bytes on upload (never the declared one), served with nosniff,
 * `Content-Disposition: inline` and a Content-Security-Policy that lets the
 * answer load and run nothing even when it is opened directly.
 */
import type { FastifyInstance } from 'fastify';
import { notFound } from '../lib/errors.js';
import { loadUploadFile } from '../services/uploads.js';

/** The answer of an upload loads, runs and frames nothing (also when opened directly). */
export const UPLOAD_CSP = "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'; frame-ancestors 'none'; sandbox";
const IMMUTABLE = 'public, max-age=31536000, immutable';

export async function registerUploadRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;
  app.get<{ Params: { file: string } }>(
    '/uploads/:file',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const file = await loadUploadFile(db, req.params.file);
      if (!file) throw notFound('Upload');
      const etag = `"${file.hash}"`;
      reply
        .header('Cache-Control', IMMUTABLE)
        .header('ETag', etag)
        .header('Content-Disposition', `inline; filename="${req.params.file}"`)
        .header('Content-Security-Policy', UPLOAD_CSP)
        .header('X-Content-Type-Options', 'nosniff');
      if (req.headers['if-none-match'] === etag) return reply.status(304).send();
      return reply.type(file.contentType).send(file.data);
    },
  );
}

/**
 * Routes owned by the monitoring adapters:
 *   POST /api/ingest/:sourceId                    generic push (any source type)
 *   POST /api/ingest/:sourceId/<type>             native push payloads (icinga2, uptimekuma, openitcockpit)
 *   POST /api/admin/monitor-sources/:id/test      test connection without storing (admin)
 *   POST /api/admin/monitor-sources/:id/poll      poll now and store (admin)
 *
 * Ingest authentication: `Authorization: Bearer <token>` or `?token=<token>`;
 * the SHA-256 of the token is compared with `monitor_sources.ingest_token_hash`.
 */
import type { MonitorSourceTestResult } from '@openstatuspage/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { AppContext } from '../context.js';
import type { MonitorSource } from '../db/types.js';
import { safeEqual, sha256 } from '../lib/crypto.js';
import { badRequest, conflict, HttpError, notFound, unauthorized } from '../lib/errors.js';
import { requireRole } from '../plugins/auth.js';
import { audit } from '../services/audit.js';
import type { IngestResult } from '../services/ingest.js';
import { genericPushParser, getAdapter } from './index.js';
import { TokenBucketLimiter } from './rate-limit.js';
import { loadSource, pollAndStore, testSource, type RunnerOptions } from './runner.js';
import type { PushParser } from './types.js';

/** Requests per minute and source on the ingest endpoints. */
export const INGEST_RATE_LIMIT_PER_MINUTE = 120;

export interface AdapterRoutesOptions {
  /** Overrides the ingest rate limiter (tests). */
  limiter?: TokenBucketLimiter;
}

export async function registerAdapterRoutes(app: FastifyInstance, options: AdapterRoutesOptions = {}): Promise<void> {
  const limiter =
    options.limiter ??
    new TokenBucketLimiter({
      capacity: INGEST_RATE_LIMIT_PER_MINUTE,
      refillPerSecond: INGEST_RATE_LIMIT_PER_MINUTE / 60,
    });

  // Encapsulated so the text/plain handling below only applies to ingest routes.
  await app.register(async (scope) => {
    // Some senders cannot set a JSON content type; accept text/plain bodies containing JSON.
    scope.removeContentTypeParser('text/plain');
    scope.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(badRequest('Body is not valid JSON'), undefined);
      }
    });

    // Tokens may arrive in the query string: keep these routes out of info-level request logs.
    // Full syncs of large sources can exceed the global 1 MiB body limit.
    const routeOptions = { logLevel: 'warn' as const, bodyLimit: 5 * 1024 * 1024 };

    scope.post<{ Params: { sourceId: string } }>('/api/ingest/:sourceId', routeOptions, async (req, reply) => {
      const result = await handleIngest(app.ctx, limiter, req, reply, req.params.sourceId, null);
      return { ok: true, ...result };
    });

    scope.post<{ Params: { sourceId: string; type: string } }>(
      '/api/ingest/:sourceId/:type',
      routeOptions,
      async (req, reply) => {
        const result = await handleIngest(app.ctx, limiter, req, reply, req.params.sourceId, req.params.type);
        return { ok: true, ...result };
      },
    );
  });

  app.post<{ Params: { id: string } }>(
    '/api/admin/monitor-sources/:id/test',
    { preHandler: requireRole('admin') },
    async (req) => testMonitorSource(app.ctx, req.params.id),
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/monitor-sources/:id/poll',
    { preHandler: requireRole('admin') },
    async (req) => {
      // audit_log.user_id references users: API tokens are recorded by name instead.
      const user = req.authUser;
      return pollMonitorSourceNow(app.ctx, req.params.id, {
        userId: user?.via === 'session' ? user.id : null,
        apiToken: user?.via === 'token' ? user.name : null,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/** Extracts the ingest token from `Authorization: Bearer` or the `token` query parameter. */
export function extractIngestToken(req: Pick<FastifyRequest, 'headers' | 'query'>): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
    if (match) return match[1]!;
  }
  const query = req.query as Record<string, unknown> | undefined;
  const token = query?.token;
  if (typeof token === 'string' && token.length > 0) return token;
  return null;
}

/** Verifies the token against the stored hash in constant time. */
export function verifyIngestToken(source: Pick<MonitorSource, 'ingest_token_hash'>, token: string | null): boolean {
  if (!token || token.length > 512) return false;
  return safeEqual(sha256(token), source.ingest_token_hash);
}

function tooManyRequests(retryAfterSeconds: number): HttpError {
  return new HttpError(429, 'rate_limited', `Too many requests for this source, retry in ${retryAfterSeconds}s`);
}

async function handleIngest(
  ctx: AppContext,
  limiter: TokenBucketLimiter,
  req: FastifyRequest,
  reply: FastifyReply,
  sourceId: string,
  format: string | null,
): Promise<IngestResult> {
  let parser: PushParser = genericPushParser;
  if (format !== null) {
    const adapter = getAdapter(format);
    if (!adapter?.push) throw notFound('Ingest format');
    parser = adapter.push;
  }

  const source =
    sourceId.length <= 64
      ? await ctx.db
          .selectFrom('monitor_sources')
          .select(['id', 'type', 'enabled', 'ingest_token_hash'])
          .where('id', '=', sourceId)
          .executeTakeFirst()
      : undefined;
  if (!source) throw notFound('Monitoring source');
  if (!verifyIngestToken(source, extractIngestToken(req))) throw unauthorized('Invalid or missing ingest token');
  if (source.enabled !== 1) throw conflict('Monitoring source is disabled');
  if (format !== null && format !== source.type && source.type !== 'webhook') {
    throw badRequest(
      `This source is of type "${source.type}". Send "${format}" payloads to a source of that type or of type "webhook", or use the generic endpoint.`,
    );
  }

  const retryAfter = limiter.take(source.id);
  if (retryAfter > 0) {
    reply.header('retry-after', String(retryAfter));
    throw tooManyRequests(retryAfter);
  }

  let parsed;
  try {
    parsed = parser.parse(req.body, req.headers);
  } catch (err) {
    if (err instanceof ZodError || err instanceof HttpError) throw err;
    throw badRequest(err instanceof Error ? err.message : 'Invalid payload');
  }

  // A full sync deletes checks (and their service links). Pull sources get
  // their complete check list from polling, so pushes may only add or update.
  if (parsed.full && source.type !== 'webhook') {
    throw badRequest(
      `"full" is only supported for sources of type "webhook"; this source is of type "${source.type}". Push without "full".`,
    );
  }

  if (parsed.checks.length === 0 && !parsed.full) {
    // e.g. Uptime Kuma test notifications
    return { created: 0, updated: 0, removed: 0, stateChanges: 0 };
  }
  return ctx.ingest.ingest(source.id, parsed.checks, { full: parsed.full, guardLinkedChecks: true });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** POST /api/admin/monitor-sources/:id/test */
export async function testMonitorSource(
  ctx: AppContext,
  id: string,
  options: RunnerOptions = {},
): Promise<MonitorSourceTestResult> {
  const source = await loadSource(ctx, id);
  return testSource(ctx, source, options);
}

/** POST /api/admin/monitor-sources/:id/poll */
export async function pollMonitorSourceNow(
  ctx: AppContext,
  id: string,
  options: RunnerOptions & { userId?: string | null; apiToken?: string | null } = {},
): Promise<MonitorSourceTestResult> {
  const source = await loadSource(ctx, id);
  if (!getAdapter(source.type)?.poll) {
    throw badRequest(`Sources of type "${source.type}" receive pushed results and cannot be polled`);
  }
  if (source.enabled !== 1) throw conflict('Monitoring source is disabled');
  const { userId = null, apiToken = null, ...runnerOptions } = options;
  const outcome = await pollAndStore(ctx, source.id, runnerOptions);
  await audit(ctx.db, {
    userId,
    action: 'monitor_source.poll',
    entityType: 'monitor_source',
    entityId: source.id,
    details: { ok: outcome.ok, checkCount: outcome.checkCount ?? null, ...(apiToken ? { apiToken } : {}) },
  });
  const result: MonitorSourceTestResult = { ok: outcome.ok, message: outcome.message };
  if (outcome.checkCount !== undefined) result.checkCount = outcome.checkCount;
  return result;
}

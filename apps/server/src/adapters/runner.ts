/**
 * Runs pull adapters for a monitoring source: loads and decrypts the config,
 * polls with a timeout, stores results and records the poll outcome.
 * Shared by the background poller and the admin "test" / "poll now" endpoints.
 */
import type { MonitorSourceTestResult } from '@openstatuspage/shared';
import type { AppContext } from '../context.js';
import type { MonitorSource } from '../db/types.js';
import { notFound } from '../lib/errors.js';
import type { IngestResult } from '../services/ingest.js';
import { createAdapterFetch, describeTransportError, type AdapterFetchOptions, type FetchFn } from './http.js';
import { withLease } from '../lib/task-leases.js';
import { getAdapter } from './index.js';
import type { NormalizedCheck } from './types.js';

/** Worker tasks (and leases) of polls are named `poll:<sourceId>`. */
export const POLL_TASK_PREFIX = 'poll:';

export function pollTaskName(sourceId: string): string {
  return `${POLL_TASK_PREFIX}${sourceId}`;
}

/** Upper bound for one complete poll (all requests of a source together). */
export const POLL_TIMEOUT_MS = 120_000;

export interface RunnerOptions {
  /** Creates the fetch used by the adapter (overridable in tests). */
  fetchFactory?: (options: AdapterFetchOptions) => FetchFn;
  /** Aborts the poll, e.g. on shutdown. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** The caller already holds the lease `poll:<sourceId>` (the scheduled poll task). */
  leaseHeld?: boolean;
}

export interface PollOutcome {
  ok: boolean;
  message: string;
  checkCount?: number;
  result?: IngestResult;
}

export async function loadSource(ctx: AppContext, id: string): Promise<MonitorSource> {
  const row = await ctx.db.selectFrom('monitor_sources').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw notFound('Monitoring source');
  return row;
}

/** Error raised before any request is made (config problems). */
class SourceConfigError extends Error {}

/**
 * Polls a source and returns its checks without storing anything.
 * Throws with a message that is safe to show to administrators.
 */
export async function fetchSourceChecks(
  ctx: AppContext,
  source: MonitorSource,
  options: RunnerOptions = {},
): Promise<NormalizedCheck[]> {
  const adapter = getAdapter(source.type);
  if (!adapter?.poll) throw new SourceConfigError(`Sources of type "${source.type}" cannot be polled`);

  let raw: unknown;
  try {
    raw = ctx.secrets.decryptJson(source.config_encrypted);
  } catch {
    throw new SourceConfigError('The stored configuration could not be decrypted (was SECRET_KEY changed?)');
  }
  const parsed = adapter.configSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))].join(', ');
    throw new SourceConfigError(`Invalid configuration: check the fields ${fields}`);
  }
  const config = parsed.data as Record<string, unknown>;

  const fetchFactory = options.fetchFactory ?? createAdapterFetch;
  const signals = [AbortSignal.timeout(options.timeoutMs ?? POLL_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);
  try {
    const checks = await adapter.poll.poll(config, {
      signal,
      fetch: fetchFactory({ verifyTls: config.verifyTls !== false }),
    });
    if (signal.aborted) throw signal.reason;
    return checks;
  } catch (err) {
    const message = err instanceof Error && err.name !== 'TimeoutError' && err.name !== 'AbortError'
      ? err.message
      : `Poll ${describeTransportError(err)}`;
    throw new Error(redactSecrets(message, config, adapter.secretKeys));
  }
}

/** Removes secret config values (and their Basic-auth encodings) from a message. */
export function redactSecrets(message: string, config: Record<string, unknown>, secretKeys: readonly string[]): string {
  const secrets = new Set<string>();
  for (const key of secretKeys) {
    const value = config[key];
    if (typeof value !== 'string' || value.length < 4) continue;
    secrets.add(value);
    secrets.add(encodeURIComponent(value));
    const user = typeof config.username === 'string' ? config.username : '';
    secrets.add(Buffer.from(`${user}:${value}`).toString('base64'));
    secrets.add(Buffer.from(`:${value}`).toString('base64'));
  }
  let out = message;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('***');
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "Test connection": polls without storing. */
export async function testSource(
  ctx: AppContext,
  source: MonitorSource,
  options: RunnerOptions = {},
): Promise<MonitorSourceTestResult> {
  if (!getAdapter(source.type)?.poll) {
    return {
      ok: true,
      message: 'This source only receives pushed results; there is no connection to test.',
    };
  }
  try {
    const checks = await fetchSourceChecks(ctx, source, options);
    return {
      ok: true,
      message: `Connection successful: ${checks.length} check${checks.length === 1 ? '' : 's'} found.`,
      checkCount: checks.length,
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

const inFlight = new Map<string, Promise<PollOutcome>>();

/**
 * Polls a source and stores the result (full sync). A failed poll only records
 * the error: check states keep their last known value.
 * Concurrent calls for the same source share one poll. On PostgreSQL the poll
 * runs under the lease `poll:<sourceId>`, so it never overlaps with a poll of
 * the same source on another instance.
 */
export function pollAndStore(ctx: AppContext, sourceId: string, options: RunnerOptions = {}): Promise<PollOutcome> {
  const running = inFlight.get(sourceId);
  if (running) return running;
  const { leaseHeld, ...rest } = options;
  const promise = withLease(leaseHeld ? null : ctx.leases, pollTaskName(sourceId), {}, () =>
    doPollAndStore(ctx, sourceId, rest),
  )
    .then(
      (r): PollOutcome =>
        r.ran ? r.value : { ok: false, message: 'Another instance is polling this source right now; try again shortly.' },
    )
    .finally(() => inFlight.delete(sourceId));
  inFlight.set(sourceId, promise);
  return promise;
}

async function doPollAndStore(ctx: AppContext, sourceId: string, options: RunnerOptions): Promise<PollOutcome> {
  const source = await ctx.db.selectFrom('monitor_sources').selectAll().where('id', '=', sourceId).executeTakeFirst();
  if (!source) return { ok: false, message: 'Monitoring source not found' };

  let checks: NormalizedCheck[];
  try {
    checks = await fetchSourceChecks(ctx, source, options);
  } catch (err) {
    const message = errorMessage(err);
    ctx.log.warn({ sourceId, error: message }, 'monitoring source poll failed');
    await ctx.ingest.recordPoll(sourceId, false, message);
    return { ok: false, message };
  }

  if (checks.length === 0) {
    // An empty answer usually means a broken filter or missing permissions.
    // Removing every check would also remove all links to services, so keep them.
    const existing = await ctx.db
      .selectFrom('monitor_checks')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('source_id', '=', sourceId)
      .executeTakeFirst();
    if (Number(existing?.n ?? 0) > 0) {
      const message =
        'The monitoring system returned no checks; the existing checks were kept. Check the filter and the permissions of the API user.';
      await ctx.ingest.recordPoll(sourceId, false, message);
      return { ok: false, message, checkCount: 0 };
    }
  }

  // recordPoll re-evaluates the source's bundles with the new poll outcome.
  const result = await ctx.ingest.ingest(sourceId, checks, { full: true, deferBundleRecompute: true });
  await ctx.ingest.recordPoll(sourceId, true);
  return {
    ok: true,
    message: `Poll successful: ${checks.length} check${checks.length === 1 ? '' : 's'} (${result.created} new, ${result.removed} removed, ${result.stateChanges} state changes).`,
    checkCount: checks.length,
    result,
  };
}

/**
 * History import jobs: fetch (background) → preview → apply (background).
 *
 *   create   validates, stores the job (status "fetching") and starts the fetch
 *   fetch    runs the importer of the source type (or parses the CSV), stages
 *            the intervals of matching checks, computes the preview → "ready"
 *   apply    plans again against the current data and writes it in one
 *            transaction → "completed". Applies are serialised globally (an
 *            advisory lock on PostgreSQL, the write lock on SQLite), so jobs of
 *            different sources feeding the same service never interleave.
 *   cancel   "fetching" (aborts) or "ready" (discards) → "cancelled"
 *
 * Only one job per source can be active (fetching, ready, applying). One-off
 * credentials are stored encrypted on the job and cleared when fetching ends.
 * Jobs run in the process that received the request; a periodic task fails
 * jobs that stopped making progress (e.g. after a restart); previews nobody
 * applied within a day are discarded by that task and, lazily, whenever jobs
 * are read or started (so they also expire without a worker process).
 */
import {
  BUNDLE_SOURCE_TYPE,
  type AdminHistoryImport,
  type CheckState,
  type HistoryImportCreateInput,
  type HistoryImportCredentials,
  type HistoryImportErrorCode,
  type HistoryImportPreview,
  type HistoryImportProgress,
  type HistoryImportResult,
  type HistoryImportWarning,
  type ServiceStatus,
} from '@openstatuspage/shared';
import type { FastifyBaseLogger } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { createAdapterFetch, type AdapterFetchOptions, type FetchFn } from '../adapters/http.js';
import { getAdapter } from '../adapters/index.js';
import { redactSecrets } from '../adapters/runner.js';
import type { DB } from '../db/index.js';
import type { Database, HistoryImport, MonitorSource } from '../db/types.js';
import type { SecretBox } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { Valued } from '../lib/intervals.js';
import { nowIso } from '../lib/time.js';
import { CsvImportError, parseHistoryCsv } from '../importers/csv.js';
import { defaultImporters, type ImporterRegistry } from '../importers/index.js';
import type { ImportedHistory, ImportTarget } from '../importers/types.js';
import type { Worker } from '../worker.js';
import { audit } from './audit.js';
import { planImport, type ImportPlan, type StagedData } from './history-import-plan.js';

/** Key of the PostgreSQL advisory lock that serialises applying imports. */
const APPLY_LOCK_KEY = 4_711_005;

/** Requests of importers may take long (large heartbeat lists, long polling). */
export const IMPORT_REQUEST_TIMEOUT_MS = 120_000;
/** Upper bound for fetching one import. */
export const IMPORT_FETCH_TIMEOUT_MS = 30 * 60_000;
/** Jobs without progress for this long are considered dead. */
export const IMPORT_STALE_MS = 15 * 60_000;
/** Previews that were not applied are discarded after this time. */
export const IMPORT_PREVIEW_TTL_MS = 24 * 60 * 60_000;
export const HISTORY_IMPORT_TASK = 'history-import-cleanup';

const ACTIVE = ['fetching', 'ready', 'applying'] as const;

class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export interface Actor {
  userId: string | null;
  apiToken: string | null;
}

interface FetchSummary {
  unmatched: string[];
  unmatchedCount: number;
  checksWithoutData: number;
  warnings: HistoryImportWarning[];
}

function json<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

const iso = (t: number) => new Date(t).toISOString();

export class HistoryImportService {
  /** Replaceable in tests. */
  importers: ImporterRegistry = defaultImporters;
  fetchFactory: (options: AdapterFetchOptions) => FetchFn = createAdapterFetch;

  private readonly running = new Map<string, AbortController>();
  private shuttingDown = false;

  constructor(
    private readonly db: DB,
    private readonly secrets: SecretBox,
    private readonly worker: Worker,
    private readonly log: FastifyBaseLogger,
    private readonly dialect: 'sqlite' | 'postgres' = 'sqlite',
  ) {}

  // --- Queries ------------------------------------------------------------------

  async list(sourceId: string, limit = 20): Promise<AdminHistoryImport[]> {
    await this.expirePreviews();
    const rows = await this.baseQuery().where('history_imports.source_id', '=', sourceId).orderBy('history_imports.created_at', 'desc').limit(limit).execute();
    // The list is for overviews: previews can be large and are loaded per job.
    return rows.map((r) => ({ ...this.toAdmin(r), preview: null }));
  }

  async get(sourceId: string, id: string): Promise<AdminHistoryImport> {
    await this.expirePreviews();
    const row = await this.baseQuery()
      .where('history_imports.source_id', '=', sourceId)
      .where('history_imports.id', '=', id)
      .executeTakeFirst();
    if (!row) throw notFound('History import');
    return this.toAdmin(row);
  }

  private baseQuery() {
    return this.db
      .selectFrom('history_imports')
      .leftJoin('users', 'users.id', 'history_imports.created_by')
      .selectAll('history_imports')
      .select(['users.name as creator_name']);
  }

  private toAdmin(r: HistoryImport & { creator_name: string | null }): AdminHistoryImport {
    const summary = json<FetchSummary>(r.fetch_summary);
    const preview = json<Omit<HistoryImportPreview, keyof FetchSummary>>(r.preview);
    return {
      id: r.id,
      sourceId: r.source_id,
      status: r.status,
      from: r.range_from,
      to: r.range_to,
      onlyLinkedChecks: r.only_linked === 1,
      progress: json<HistoryImportProgress>(r.progress),
      preview: preview
        ? {
            ...preview,
            unmatched: summary?.unmatched ?? [],
            unmatchedCount: summary?.unmatchedCount ?? 0,
            checksWithoutData: summary?.checksWithoutData ?? 0,
            warnings: summary?.warnings ?? [],
          }
        : null,
      result: json<HistoryImportResult>(r.result),
      error: r.error,
      errorCode: (r.error_code as HistoryImportErrorCode | null) ?? null,
      createdBy: r.created_by && r.creator_name ? { id: r.created_by, name: r.creator_name } : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      finishedAt: r.finished_at,
    };
  }

  // --- Create -------------------------------------------------------------------

  async create(source: MonitorSource, input: HistoryImportCreateInput, actor: Actor): Promise<AdminHistoryImport> {
    if (source.type === BUNDLE_SOURCE_TYPE) {
      throw conflict('Check bundles have no history of their own; import the history of their member sources.');
    }
    const now = Date.now();
    const from = Date.parse(input.from);
    const to = Math.min(Date.parse(input.to), now);
    if (from >= to) throw badRequest('The time range must lie in the past.');

    const config = this.sourceConfig(source);
    const credentials = cleanCredentials(input.credentials);
    let csvRows = 0;
    if (input.csv !== undefined) {
      try {
        csvRows = parseHistoryCsv(input.csv).rows;
      } catch (err) {
        if (err instanceof CsvImportError) throw badRequest(err.message, err.errors);
        throw err;
      }
    } else {
      if (!this.importers[source.type]) {
        throw badRequest('This source type has no history API; upload a CSV file instead.');
      }
      this.assertCredentials(source.type, config, credentials);
    }

    await this.expirePreviews();
    const active = await this.db
      .selectFrom('history_imports')
      .select('id')
      .where('source_id', '=', source.id)
      .where('status', 'in', [...ACTIVE])
      .executeTakeFirst();
    if (active) throw conflict('Another history import of this source is still running or waiting for confirmation.');

    const id = newId();
    const ts = nowIso();
    await this.db
      .insertInto('history_imports')
      .values({
        id,
        source_id: source.id,
        status: 'fetching',
        range_from: iso(from),
        range_to: iso(to),
        only_linked: input.onlyLinkedChecks ? 1 : 0,
        progress: JSON.stringify({ phase: 'queued', done: 0, total: 0 } satisfies HistoryImportProgress),
        credentials_encrypted: Object.keys(credentials).length > 0 ? this.secrets.encryptJson(credentials) : null,
        fetch_summary: null,
        preview: null,
        result: null,
        error: null,
        error_code: null,
        created_by: actor.userId,
        created_at: ts,
        updated_at: ts,
        finished_at: null,
      })
      .execute();
    // Never log credentials or the CSV content.
    await audit(this.db, {
      userId: actor.userId,
      action: 'history_import.start',
      entityType: 'monitor_source',
      entityId: source.id,
      details: {
        importId: id,
        from: iso(from),
        to: iso(to),
        method: input.csv !== undefined ? 'csv' : source.type,
        ...(input.csv !== undefined ? { csvRows } : {}),
        onlyLinkedChecks: input.onlyLinkedChecks,
        ...(actor.apiToken ? { apiToken: actor.apiToken } : {}),
      },
    });

    const controller = new AbortController();
    this.running.set(id, controller);
    this.worker.runDetached(`history-import:${id}`, () =>
      this.runFetch(id, source, input.csv, controller.signal).finally(() => this.running.delete(id)),
    );
    return this.get(source.id, id);
  }

  private sourceConfig(source: MonitorSource): Record<string, unknown> {
    let raw: unknown;
    try {
      raw = this.secrets.decryptJson(source.config_encrypted);
    } catch {
      throw badRequest('The stored configuration could not be decrypted (was SECRET_KEY changed?)');
    }
    const parsed = getAdapter(source.type)?.configSchema.safeParse(raw);
    if (!parsed?.success) throw badRequest('The configuration of this source is invalid; fix it first.');
    return parsed.data as Record<string, unknown>;
  }

  private assertCredentials(type: string, config: Record<string, unknown>, c: HistoryImportCredentials): void {
    if (type === 'uptimekuma' && !((c.username ?? config.historyUsername) && (c.password ?? config.historyPassword))) {
      throw badRequest('Uptime Kuma needs a user name and password to read the history.');
    }
    if (type === 'icinga2' && !(c.databaseUrl ?? config.icingaDbUrl)) {
      throw badRequest('Icinga 2 needs the connection string of the Icinga DB database.');
    }
  }

  // --- Fetch --------------------------------------------------------------------

  private async touch(id: string, fields: { progress?: HistoryImportProgress }, status: 'fetching' | 'applying'): Promise<void> {
    const result = await this.db
      .updateTable('history_imports')
      .set({ updated_at: nowIso(), ...(fields.progress ? { progress: JSON.stringify(fields.progress) } : {}) })
      .where('id', '=', id)
      .where('status', '=', status)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw new CancelledError();
  }

  private async runFetch(id: string, source: MonitorSource, csv: string | undefined, cancel: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([cancel, AbortSignal.timeout(IMPORT_FETCH_TIMEOUT_MS)]);
    let config: Record<string, unknown> = {};
    try {
      config = this.sourceConfig(source);
      const job = await this.db.selectFrom('history_imports').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      const credentials = job.credentials_encrypted
        ? this.secrets.decryptJson<HistoryImportCredentials>(job.credentials_encrypted)
        : {};
      const range = { from: Date.parse(job.range_from), to: Date.parse(job.range_to) };

      const targets = await this.targets(source.id, job.only_linked === 1);
      const progress = async (phase: string, done: number, total: number) => {
        if (signal.aborted) throw cancel.aborted ? new CancelledError() : signal.reason;
        await this.touch(id, { progress: { phase, done, total } }, 'fetching');
      };

      let fetched: ImportedHistory;
      if (csv !== undefined) {
        const parsed = parseHistoryCsv(csv);
        fetched = { checks: parsed.checks, services: parsed.services, warnings: [] };
      } else {
        const importer = this.importers[source.type];
        if (!importer) throw new Error('No importer for this source type');
        fetched = await importer.fetch(config, credentials, targets, range, {
          signal,
          fetch: this.fetchFactory({ verifyTls: config.verifyTls !== false, timeoutMs: IMPORT_REQUEST_TIMEOUT_MS }),
          progress,
        });
      }
      if (signal.aborted) throw cancel.aborted ? new CancelledError() : signal.reason;
      // Credentials are not needed any more.
      await this.db.updateTable('history_imports').set({ credentials_encrypted: null }).where('id', '=', id).execute();

      await progress('planning', 0, 1);
      const staged = await this.stage(id, source.id, targets, fetched, csv !== undefined);
      const plan = await planImport(this.db, { from: job.range_from, to: job.range_to }, staged.data);
      const done = await this.db
        .updateTable('history_imports')
        .set({
          status: 'ready',
          fetch_summary: JSON.stringify(staged.summary),
          preview: JSON.stringify(plan.preview),
          progress: JSON.stringify({ phase: 'ready', done: 1, total: 1 } satisfies HistoryImportProgress),
          updated_at: nowIso(),
        })
        .where('id', '=', id)
        .where('status', '=', 'fetching')
        .executeTakeFirst();
      if (Number(done.numUpdatedRows) === 0) throw new CancelledError();
    } catch (err) {
      await this.discardStaging(id);
      if (this.shuttingDown) {
        await this.finish(id, 'failed', 'shutdown', 'The import was interrupted by a server shutdown; nothing was written.', ['fetching']);
        return;
      }
      if (err instanceof CancelledError || cancel.aborted) {
        await this.finish(id, 'cancelled', null, null, ['fetching']);
        return;
      }
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      const raw = err instanceof Error ? (err.name === 'TimeoutError' ? 'The import timed out.' : err.message) : String(err);
      const secretKeys = [...(getAdapter(source.type)?.secretKeys ?? []), 'password', 'databaseUrl'];
      let credentials: Record<string, unknown> = {};
      try {
        const job = await this.db.selectFrom('history_imports').select('credentials_encrypted').where('id', '=', id).executeTakeFirst();
        if (job?.credentials_encrypted) credentials = this.secrets.decryptJson(job.credentials_encrypted);
      } catch {
        // ignore
      }
      const message = redactSecrets(
        redactSecrets(raw, withUrlPasswords(config), [...secretKeys, 'urlPassword']),
        withUrlPasswords(credentials),
        [...secretKeys, 'urlPassword'],
      ).slice(0, 1000);
      this.log.warn({ importId: id, sourceId: source.id, error: message }, 'history import failed');
      await this.finish(id, 'failed', timedOut ? 'timeout' : 'source', message, ['fetching']);
    } finally {
      await this.db.updateTable('history_imports').set({ credentials_encrypted: null }).where('id', '=', id).execute();
    }
  }

  /** Local checks whose history is requested. */
  private async targets(sourceId: string, onlyLinked: boolean): Promise<ImportTarget[]> {
    let q = this.db
      .selectFrom('monitor_checks')
      .select(['monitor_checks.id', 'monitor_checks.external_id'])
      .where('monitor_checks.source_id', '=', sourceId);
    if (onlyLinked) {
      q = q.where((eb) =>
        eb.or([
          eb.exists(eb.selectFrom('service_checks').select('check_id').whereRef('service_checks.check_id', '=', 'monitor_checks.id')),
          eb.exists(
            eb.selectFrom('check_bundle_members').select('check_id').whereRef('check_bundle_members.check_id', '=', 'monitor_checks.id'),
          ),
        ]),
      );
    }
    const rows = await q.orderBy('monitor_checks.external_id').execute();
    return rows.map((r) => ({ checkId: r.id, externalId: r.external_id }));
  }

  /** Matches fetched data to checks/services and stores it on the job. */
  private async stage(
    id: string,
    sourceId: string,
    targets: ImportTarget[],
    fetched: ImportedHistory,
    isCsv: boolean,
  ): Promise<{ data: StagedData; summary: FetchSummary }> {
    // CSV rows may name any check of the source, linked or not.
    const byExternal = new Map(
      (isCsv ? await this.targets(sourceId, false) : targets).map((t) => [t.externalId, t.checkId]),
    );
    const unmatched: string[] = [];
    const checks = new Map<string, Valued<CheckState>[]>();
    for (const [externalId, intervals] of fetched.checks) {
      const checkId = byExternal.get(externalId);
      if (!checkId) unmatched.push(externalId);
      else if (intervals.length > 0) checks.set(checkId, intervals);
    }
    const services = new Map<string, Valued<ServiceStatus>[]>();
    const slugs = [...(fetched.services?.keys() ?? [])];
    if (slugs.length > 0) {
      const rows = await this.db.selectFrom('services').select(['id', 'slug']).where('slug', 'in', slugs).execute();
      const bySlug = new Map(rows.map((r) => [r.slug, r.id]));
      for (const [slug, intervals] of fetched.services!) {
        const serviceId = bySlug.get(slug);
        if (!serviceId) unmatched.push(`service:${slug}`);
        else services.set(serviceId, intervals);
      }
    }

    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('history_import_intervals').where('import_id', '=', id).execute();
      const rows = [
        ...[...checks].flatMap(([checkId, list]) =>
          list.map((i) => ({ check_id: checkId as string | null, service_id: null as string | null, ...i })),
        ),
        ...[...services].flatMap(([serviceId, list]) =>
          list.map((i) => ({ check_id: null as string | null, service_id: serviceId as string | null, ...i })),
        ),
      ];
      for (let i = 0; i < rows.length; i += 200) {
        await trx
          .insertInto('history_import_intervals')
          .values(
            rows.slice(i, i + 200).map((r) => ({
              id: newId(),
              import_id: id,
              check_id: r.check_id,
              service_id: r.service_id,
              state: r.value,
              started_at: iso(r.start),
              ended_at: iso(r.end),
            })),
          )
          .execute();
      }
    });

    unmatched.sort();
    return {
      data: { checks, services },
      summary: {
        unmatched: unmatched.slice(0, 50),
        unmatchedCount: unmatched.length,
        checksWithoutData: isCsv ? 0 : targets.filter((t) => !checks.has(t.checkId)).length,
        warnings: fetched.warnings,
      },
    };
  }

  private async loadStaged(id: string): Promise<StagedData> {
    const rows = await this.db
      .selectFrom('history_import_intervals')
      .select(['check_id', 'service_id', 'state', 'started_at', 'ended_at'])
      .where('import_id', '=', id)
      .orderBy('started_at')
      .execute();
    const data: StagedData = { checks: new Map(), services: new Map() };
    for (const r of rows) {
      const item = { start: Date.parse(r.started_at), end: Date.parse(r.ended_at) };
      if (r.check_id) {
        const list = data.checks.get(r.check_id) ?? [];
        list.push({ ...item, value: r.state as CheckState });
        data.checks.set(r.check_id, list);
      } else if (r.service_id) {
        const list = data.services.get(r.service_id) ?? [];
        list.push({ ...item, value: r.state as ServiceStatus });
        data.services.set(r.service_id, list);
      }
    }
    return data;
  }

  // --- Apply --------------------------------------------------------------------

  async apply(sourceId: string, id: string, actor: Actor): Promise<AdminHistoryImport> {
    await this.expirePreviews();
    const result = await this.db
      .updateTable('history_imports')
      .set({
        status: 'applying',
        progress: JSON.stringify({ phase: 'writing', done: 0, total: 1 } satisfies HistoryImportProgress),
        updated_at: nowIso(),
      })
      .where('id', '=', id)
      .where('source_id', '=', sourceId)
      .where('status', '=', 'ready')
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) {
      await this.get(sourceId, id); // 404 when it does not exist
      throw conflict('Only an import with a preview that is ready can be applied.');
    }
    await audit(this.db, {
      userId: actor.userId,
      action: 'history_import.apply',
      entityType: 'monitor_source',
      entityId: sourceId,
      details: { importId: id, ...(actor.apiToken ? { apiToken: actor.apiToken } : {}) },
    });
    this.running.set(id, new AbortController());
    this.worker.runDetached(`history-import:${id}`, () => this.runApply(id).finally(() => this.running.delete(id)));
    return this.get(sourceId, id);
  }

  private async runApply(id: string): Promise<void> {
    try {
      const job = await this.db.selectFrom('history_imports').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      const staged = await this.loadStaged(id);
      // Plan and write in one transaction, one import at a time: a plan made
      // outside could be stale once another import (e.g. of another source
      // feeding the same service) has written.
      const result = await this.db.transaction().execute(async (trx) => {
        await this.lockApply(trx, id);
        const plan = await planImport(trx, { from: job.range_from, to: job.range_to }, staged);
        const written = await this.write(trx, plan);
        const done = await trx
          .updateTable('history_imports')
          .set({
            status: 'completed',
            result: JSON.stringify(written),
            progress: JSON.stringify({ phase: 'completed', done: 1, total: 1 } satisfies HistoryImportProgress),
            updated_at: nowIso(),
            finished_at: nowIso(),
          })
          .where('id', '=', id)
          .where('status', '=', 'applying')
          .executeTakeFirst();
        // Failed meanwhile (e.g. by the cleanup of another process): roll back.
        if (Number(done.numUpdatedRows) === 0) throw new CancelledError();
        return written;
      });
      await this.discardStaging(id);
      await audit(this.db, {
        userId: job.created_by,
        action: 'history_import.complete',
        entityType: 'monitor_source',
        entityId: job.source_id,
        details: { importId: id, ...result },
      });
    } catch (err) {
      await this.discardStaging(id);
      if (err instanceof CancelledError) return;
      const message = err instanceof Error ? err.message.slice(0, 1000) : String(err);
      this.log.error({ err, importId: id }, 'applying history import failed');
      await this.finish(id, 'failed', 'apply_failed', `Applying failed, nothing was written: ${message}`, ['applying']);
    }
  }

  /**
   * Serialises applying imports across jobs and processes. On PostgreSQL a
   * transaction-scoped advisory lock; on SQLite the first statement is a write,
   * which takes the database write lock for the rest of the transaction.
   */
  private async lockApply(trx: Kysely<Database>, id: string): Promise<void> {
    if (this.dialect === 'postgres') await sql`select pg_advisory_xact_lock(${APPLY_LOCK_KEY})`.execute(trx);
    const touched = await trx
      .updateTable('history_imports')
      .set({ updated_at: nowIso() })
      .where('id', '=', id)
      .where('status', '=', 'applying')
      .executeTakeFirst();
    if (Number(touched.numUpdatedRows) === 0) throw new CancelledError();
  }

  /** Writes a plan (inside the caller's transaction). */
  private async write(trx: Kysely<Database>, plan: ImportPlan): Promise<HistoryImportResult> {
    const result: HistoryImportResult = { checkIntervals: 0, serviceSegments: 0, services: 0 };
    for (const [checkId, p] of plan.checks) {
      for (let i = 0; i < p.deleteIds.length; i += 500) {
        await trx.deleteFrom('monitor_check_history').where('id', 'in', p.deleteIds.slice(i, i + 500)).execute();
      }
      const rows = [...p.keep, ...p.insert].map((x) => ({
        id: newId(),
        check_id: checkId,
        state: x.value,
        started_at: iso(x.start),
        ended_at: iso(x.end),
        source: 'import' as const,
      }));
      for (let i = 0; i < rows.length; i += 200) {
        await trx.insertInto('monitor_check_history').values(rows.slice(i, i + 200)).execute();
      }
      result.checkIntervals += p.insert.length;
    }
    for (const [serviceId, p] of plan.services) {
      for (let i = 0; i < p.deleteIds.length; i += 500) {
        await trx.deleteFrom('service_status_history').where('id', 'in', p.deleteIds.slice(i, i + 500)).execute();
      }
      const rows = [...p.keep, ...p.insert].map((x) => ({
        id: newId(),
        service_id: serviceId,
        status: x.value,
        started_at: iso(x.start),
        ended_at: iso(x.end),
        source: x.source ?? ('import' as const),
      }));
      for (let i = 0; i < rows.length; i += 200) {
        await trx.insertInto('service_status_history').values(rows.slice(i, i + 200)).execute();
      }
      result.serviceSegments += p.insert.length;
      if (p.insert.length > 0 || p.deleteIds.length > 0) result.services++;
    }
    return result;
  }

  // --- Cancel / cleanup -----------------------------------------------------------

  /** Aborts running fetches (server shutdown); they end as failed. */
  abortAll(): void {
    this.shuttingDown = true;
    for (const controller of this.running.values()) controller.abort();
  }

  async cancel(sourceId: string, id: string, actor: Actor): Promise<AdminHistoryImport> {
    const job = await this.get(sourceId, id);
    if (job.status === 'applying') throw conflict('The import is being written and can no longer be cancelled.');
    if (job.status !== 'fetching' && job.status !== 'ready') throw conflict('The import has already finished.');
    const changed = await this.finish(id, 'cancelled', null, null, ['fetching', 'ready']);
    if (!changed) throw conflict('The import has already finished.');
    this.running.get(id)?.abort();
    await this.discardStaging(id);
    await audit(this.db, {
      userId: actor.userId,
      action: 'history_import.cancel',
      entityType: 'monitor_source',
      entityId: sourceId,
      details: { importId: id, ...(actor.apiToken ? { apiToken: actor.apiToken } : {}) },
    });
    return this.get(sourceId, id);
  }

  private async finish(
    id: string,
    status: 'cancelled' | 'failed',
    errorCode: HistoryImportErrorCode | null,
    error: string | null,
    from: ('fetching' | 'ready' | 'applying')[],
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('history_imports')
      .set({ status, error, error_code: errorCode, credentials_encrypted: null, updated_at: nowIso(), finished_at: nowIso() })
      .where('id', '=', id)
      .where('status', 'in', from)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  private async discardStaging(id: string): Promise<void> {
    await this.db.deleteFrom('history_import_intervals').where('import_id', '=', id).execute();
  }

  /** Discards previews nobody applied in time (cheap; runs in every process). */
  async expirePreviews(now = Date.now()): Promise<void> {
    const rows = await this.db
      .selectFrom('history_imports')
      .select('id')
      .where('status', '=', 'ready')
      .where('updated_at', '<', iso(now - IMPORT_PREVIEW_TTL_MS))
      .execute();
    for (const r of rows) {
      if (await this.finish(r.id, 'cancelled', 'expired', 'The preview expired without being applied.', ['ready'])) {
        await this.discardStaging(r.id);
      }
    }
  }

  /** Fails jobs without progress, expires old previews and drops their staged data. */
  async cleanup(now = Date.now()): Promise<void> {
    await this.expirePreviews(now);
    const stale = iso(now - IMPORT_STALE_MS);
    const rows = await this.db
      .selectFrom('history_imports')
      .select(['id', 'status', 'updated_at'])
      .where('status', 'in', ['fetching', 'applying'])
      .where('updated_at', '<', stale)
      .execute();
    for (const r of rows) {
      if (this.running.has(r.id)) continue;
      const status = r.status as 'fetching' | 'applying';
      const message = 'The import was interrupted (e.g. by a restart); nothing was written.';
      if (await this.finish(r.id, 'failed', 'interrupted', message, [status])) await this.discardStaging(r.id);
    }
  }
}

/** Adds the password of a connection string (`icingaDbUrl` / `databaseUrl`) as `urlPassword` for redaction. */
function withUrlPasswords(values: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['icingaDbUrl', 'databaseUrl']) {
    const value = values[key];
    if (typeof value !== 'string') continue;
    try {
      const password = decodeURIComponent(new URL(value).password);
      if (password) return { ...values, urlPassword: password };
    } catch {
      // not a URL
    }
  }
  return values;
}

function cleanCredentials(c: HistoryImportCredentials | undefined): HistoryImportCredentials {
  const out: HistoryImportCredentials = {};
  if (!c) return out;
  if (c.username) out.username = c.username;
  if (c.password) out.password = c.password;
  if (c.totp) out.totp = c.totp;
  // The mask stands for "use the stored value".
  if (c.databaseUrl && !c.databaseUrl.includes('••')) out.databaseUrl = c.databaseUrl;
  return out;
}

/** Cleanup every 5 minutes (only with WORKER_ENABLED; also runs once on start). */
export function registerHistoryImportTasks(ctx: { worker: Worker; historyImports: HistoryImportService }): void {
  ctx.worker.schedule(HISTORY_IMPORT_TASK, 5 * 60_000, async () => {
    await ctx.historyImports.cleanup();
  });
}

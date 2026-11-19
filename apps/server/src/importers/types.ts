/**
 * Contract for history importers.
 *
 * An importer reads the state history of checks from a monitoring system for a
 * time range and returns normalized state intervals per external check id (the
 * same ids the live adapters use). Importers never write to the database; the
 * HistoryImportService stages, previews and applies their results.
 */
import type {
  CheckState,
  HistoryImportCredentials,
  HistoryImportWarning,
  MonitorSourceType,
  ServiceStatus,
} from '@openstatuspage/shared';
import type { FetchFn } from '../adapters/http.js';
import type { Valued } from '../lib/intervals.js';

export interface ImportRange {
  /** Epoch ms, inclusive. */
  from: number;
  /** Epoch ms, exclusive. Never later than "now". */
  to: number;
}

/** A local check whose history is requested. */
export interface ImportTarget {
  checkId: string;
  externalId: string;
}

export interface ImporterContext {
  signal: AbortSignal;
  /** fetch honouring the source's verifyTls setting. */
  fetch: FetchFn;
  /** Reports progress; throws when the job was cancelled meanwhile. */
  progress(phase: string, done: number, total: number): Promise<void>;
}

export interface ImportedHistory {
  /** Intervals per external check id (sorted, disjoint, inside the range). */
  checks: Map<string, Valued<CheckState>[]>;
  /** Explicit service statuses per service slug (CSV only). */
  services?: Map<string, Valued<ServiceStatus>[]>;
  /** Non-fatal notes for the preview (e.g. retention). */
  warnings: HistoryImportWarning[];
}

export interface HistoryImporter<Config = Record<string, unknown>> {
  type: MonitorSourceType;
  /** Whether credentials are required in addition to the source configuration. */
  fetch(
    config: Config,
    credentials: HistoryImportCredentials,
    targets: ImportTarget[],
    range: ImportRange,
    ctx: ImporterContext,
  ): Promise<ImportedHistory>;
}

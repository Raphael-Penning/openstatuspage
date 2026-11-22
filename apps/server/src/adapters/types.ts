/**
 * Contract for monitoring adapters.
 *
 * An adapter turns data of an external monitoring system into normalized
 * check results. Pull adapters fetch from the system's API on a schedule;
 * push parsers accept the system's native webhook payloads.
 * Adapters never write to the database themselves; they return results that
 * `IngestService.ingest()` stores.
 */
import type { CheckState, MonitorSourceType } from '@openstatuspage/shared';
import type { ResponseLimits } from './http.js';

export interface NormalizedCheck {
  /** Stable ID within the source, e.g. `web01!http` for Icinga 2. */
  externalId: string;
  /**
   * Internal display name (never shown publicly). When omitted, a new check is
   * named after its externalId and an existing check keeps its stored name.
   */
  name?: string;
  /** Omitted (undefined) keeps the stored value; null clears it. */
  host?: string | null;
  state: CheckState;
  /** Omitted keeps the stored output unless the state changed (then it is cleared). */
  output?: string | null;
  /** When the monitoring system last executed the check (ISO-8601). */
  checkedAt?: string | null;
}

export interface AdapterContext {
  /** Aborted on shutdown or when the poll exceeds its timeout. */
  signal: AbortSignal;
  /** fetch that honours the source's verifyTls setting. */
  fetch: typeof fetch;
  /** Bounds for every response body (POLL_MAX_RESPONSE_MB, POLL_MAX_VALUES); pass them to each request. */
  limits: ResponseLimits;
}

export interface PollAdapter<Config = Record<string, unknown>> {
  type: MonitorSourceType;
  /** Returns the complete current set of checks of the source. */
  poll(config: Config, ctx: AdapterContext): Promise<NormalizedCheck[]>;
}

export interface PushParseResult {
  checks: NormalizedCheck[];
  /** True when the payload contains the complete set (stale checks may be removed). */
  full: boolean;
}

export interface PushParser {
  /** Parses a native webhook payload. Throws on invalid payloads. */
  parse(body: unknown, headers: Record<string, string | string[] | undefined>): PushParseResult;
}

/**
 * Icinga 2 history importer, reading the Icinga DB database.
 *
 * The Icinga 2 REST API has no state history; Icinga DB stores it in SQL
 * (MySQL/MariaDB or PostgreSQL). The importer connects with a read-only user
 * and reads:
 *   state_history  (event_time in ms, object_type, hard_state) joined with host/service names
 *   host_state / service_state (hard_state, last_state_change) for the state
 *   that held before the first event when older history was removed by retention.
 *
 * External ids match the live adapter: `host!service` for services, `host` for hosts.
 * Hard states only (soft states are retries), like the live adapter.
 *
 * Memory: every query reads at most `maxRows` rows (LIMIT). A 7-day window
 * with more events is split in halves until each part fits (down to one
 * minute), and the import keeps at most IMPORT_MAX_EVENTS state changes.
 */
import type { CheckState, HistoryImportWarning, Icinga2Config as Icinga2ConfigSchema } from '@openstatuspage/shared';
import type { z } from 'zod';
import { AdapterError } from '../adapters/http.js';
import { hostState, serviceState } from '../adapters/states.js';
import { eventsToIntervals, type Valued } from '../lib/intervals.js';
import { EventBudget, IMPORT_MAX_EVENTS } from './limits.js';
import type { HistoryImporter } from './types.js';

type Icinga2Config = z.infer<typeof Icinga2ConfigSchema>;

const SYSTEM = 'Icinga DB';
/** Events are read in windows of this size, so large installations stay manageable. */
export const ICINGADB_WINDOW_MS = 7 * 86_400_000;
/** Rows one query returns at most; larger event windows are split. */
export const ICINGADB_MAX_ROWS = 50_000;
/** Event windows are not split below this size. */
const MIN_WINDOW_MS = 60_000;

export type Row = Record<string, unknown>;

/** Minimal SQL access; `?` placeholders. */
export interface SqlRunner {
  query(sql: string, params: unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

export type SqlConnector = (url: string) => Promise<SqlRunner>;

/** Converts `?` placeholders to PostgreSQL's `$1, $2, ...`. */
export function toPgPlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/** Connects to MySQL/MariaDB (mysql2) or PostgreSQL (pg) in read-only mode. */
export const connectIcingaDb: SqlConnector = async (url) => {
  const scheme = url.slice(0, url.indexOf(':')).toLowerCase();
  if (scheme === 'mysql' || scheme === 'mariadb') {
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection({
      uri: url.replace(/^mariadb:/i, 'mysql:'),
      supportBigNumbers: true,
      bigNumberStrings: false,
      connectTimeout: 15_000,
    });
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    return {
      async query(sql, params) {
        const [rows] = await conn.query(sql, params);
        return rows as Row[];
      },
      close: () => conn.end(),
    };
  }
  if (scheme === 'postgres' || scheme === 'postgresql') {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
    await client.connect();
    await client.query('SET default_transaction_read_only = on');
    return {
      async query(sql, params) {
        const res = await client.query(toPgPlaceholders(sql), params);
        return res.rows as Row[];
      },
      close: () => client.end(),
    };
  }
  throw new AdapterError(`${SYSTEM}: unsupported database URL scheme "${scheme}" (use mysql:// or postgres://)`);
};

export const SQL_EVENTS = `
SELECT sh.event_time, sh.object_type, sh.hard_state, h.name AS host_name, s.name AS service_name
FROM state_history sh
JOIN host h ON h.id = sh.host_id
LEFT JOIN service s ON s.id = sh.service_id
WHERE sh.event_time >= ? AND sh.event_time < ?
ORDER BY sh.event_time
LIMIT ?`;

export const SQL_LAST_SERVICE_BEFORE = `
SELECT sh.event_time, sh.hard_state, h.name AS host_name, s.name AS service_name
FROM state_history sh
JOIN (
  SELECT service_id, MAX(event_time) AS t FROM state_history
  WHERE object_type = 'service' AND event_time < ? GROUP BY service_id
) last ON last.service_id = sh.service_id AND last.t = sh.event_time
JOIN host h ON h.id = sh.host_id
JOIN service s ON s.id = sh.service_id
WHERE sh.object_type = 'service'
LIMIT ?`;

export const SQL_LAST_HOST_BEFORE = `
SELECT sh.event_time, sh.hard_state, h.name AS host_name
FROM state_history sh
JOIN (
  SELECT host_id, MAX(event_time) AS t FROM state_history
  WHERE object_type = 'host' AND event_time < ? GROUP BY host_id
) last ON last.host_id = sh.host_id AND last.t = sh.event_time
JOIN host h ON h.id = sh.host_id
WHERE sh.object_type = 'host'
LIMIT ?`;

export const SQL_SERVICE_STATE = `
SELECT ss.hard_state, ss.last_state_change, h.name AS host_name, s.name AS service_name
FROM service_state ss
JOIN service s ON s.id = ss.service_id
JOIN host h ON h.id = ss.host_id
LIMIT ?`;

export const SQL_HOST_STATE = `
SELECT hs.hard_state, hs.last_state_change, h.name AS host_name
FROM host_state hs
JOIN host h ON h.id = hs.host_id
LIMIT ?`;

function text(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return null;
}

function externalIdOf(row: Row, isService: boolean): string | null {
  const host = text(row.host_name);
  if (!host) return null;
  if (!isService) return host;
  const service = text(row.service_name);
  return service ? `${host}!${service}` : null;
}

function stateOf(value: unknown, isService: boolean): CheckState {
  return isService ? serviceState(value) : hostState(value);
}

export interface IcingaDbImporterOptions {
  /** Rows per query (default ICINGADB_MAX_ROWS). */
  maxRows?: number;
  /** State changes per import (default IMPORT_MAX_EVENTS). */
  maxEvents?: number;
}

export function createIcingaDbImporter(
  connect: SqlConnector = connectIcingaDb,
  options: IcingaDbImporterOptions = {},
): HistoryImporter<Icinga2Config> {
  const maxRows = options.maxRows ?? ICINGADB_MAX_ROWS;
  const tooMany = () =>
    new AdapterError(`${SYSTEM}: more than ${maxRows} rows in one query; import fewer checks or a shorter range.`);
  return {
    type: 'icinga2',
    async fetch(config, credentials, targets, range, ctx) {
      const url = credentials.databaseUrl ?? config.icingaDbUrl ?? '';
      if (!url) throw new AdapterError(`${SYSTEM}: a database connection string is required.`);
      const wanted = new Set(targets.map((t) => t.externalId));
      const events = new Map<string, { at: number; value: CheckState }[]>();
      const budget = new EventBudget(SYSTEM, options.maxEvents ?? IMPORT_MAX_EVENTS);
      const add = (id: string | null, at: number, value: CheckState) => {
        if (!id || !wanted.has(id) || !Number.isFinite(at)) return;
        budget.take();
        const list = events.get(id) ?? [];
        list.push({ at, value });
        events.set(id, list);
      };

      await ctx.progress('connecting', 0, 1);
      let db: SqlRunner;
      try {
        db = await connect(url);
      } catch (err) {
        throw new AdapterError(`${SYSTEM}: connection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const warnings: HistoryImportWarning[] = [];
      /** Rows of a query that must fit into one LIMIT. */
      const all = async (sql: string, params: unknown[]): Promise<Row[]> => {
        const rows = await db.query(sql, [...params, maxRows + 1]);
        if (rows.length > maxRows) throw tooMany();
        return rows;
      };
      /** Events in [start, end), split into smaller windows while a query hits the limit. */
      const readEvents = async (start: number, end: number): Promise<void> => {
        const rows = await db.query(SQL_EVENTS, [start, end, maxRows + 1]);
        if (rows.length > maxRows) {
          if (end - start <= MIN_WINDOW_MS) throw tooMany();
          const mid = start + Math.floor((end - start) / 2);
          await readEvents(start, mid);
          await readEvents(mid, end);
          return;
        }
        for (const row of rows) {
          const isService = text(row.object_type) === 'service';
          add(externalIdOf(row, isService), Number(row.event_time), stateOf(row.hard_state, isService));
        }
      };
      try {
        const windows = Math.max(1, Math.ceil((range.to - range.from) / ICINGADB_WINDOW_MS));
        // Total = windows + 2 (state before the range, current state).
        const total = windows + 2;

        // State at the start of the range: the last event before it ...
        await ctx.progress('fetching', 0, total);
        const known = new Set<string>();
        for (const [sql, isService] of [
          [SQL_LAST_SERVICE_BEFORE, true],
          [SQL_LAST_HOST_BEFORE, false],
        ] as const) {
          for (const row of await all(sql, [range.from])) {
            const id = externalIdOf(row, isService);
            if (!id || known.has(id)) continue;
            known.add(id);
            add(id, range.from, stateOf(row.hard_state, isService));
          }
        }

        let done = 1;
        for (let start = range.from; start < range.to; start += ICINGADB_WINDOW_MS) {
          await ctx.progress('fetching', done++, total);
          await readEvents(start, Math.min(start + ICINGADB_WINDOW_MS, range.to));
        }

        // ... or, without older events (retention), the current state when it has
        // not changed since before the range.
        await ctx.progress('fetching', done, total);
        for (const [sql, isService] of [
          [SQL_SERVICE_STATE, true],
          [SQL_HOST_STATE, false],
        ] as const) {
          for (const row of await all(sql, [])) {
            const id = externalIdOf(row, isService);
            if (!id || !wanted.has(id)) continue;
            const changed = Number(row.last_state_change);
            if (!Number.isFinite(changed) || changed >= range.to) continue;
            add(id, Math.max(changed, range.from), stateOf(row.hard_state, isService));
          }
        }
        await ctx.progress('fetching', total, total);
      } catch (err) {
        if (err instanceof AdapterError) throw err;
        throw new AdapterError(`${SYSTEM}: query failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await db.close().catch(() => undefined);
      }

      const checks = new Map<string, Valued<CheckState>[]>();
      for (const [id, list] of events) {
        // Same timestamp: one value (derived start states agree with the history).
        const deduped = new Map<number, CheckState>();
        for (const e of list.sort((a, b) => a.at - b.at)) deduped.set(e.at, e.value);
        const intervals = eventsToIntervals(
          [...deduped].map(([at, value]) => ({ at, value })),
          range.to,
        );
        if (intervals.length > 0) checks.set(id, intervals);
      }
      return { checks, warnings };
    },
  };
}

export const icingaDbImporter = createIcingaDbImporter();

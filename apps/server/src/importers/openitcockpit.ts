/**
 * openITCockpit history importer (API, existing API key of the source).
 *
 *   GET /services/index.json?angular=true&page=N  (and hosts/index.json)
 *       → numeric ids and the current status of the checks (uuid → id)
 *   GET /statehistories/service/<id>.json?angular=true&filter[from]=...&filter[to]=...
 *       &filter[StatehistoryServices.state_type]=1&sort=StatehistoryServices.state_time&direction=asc&page=N
 *   GET /statehistories/host/<id>.json (same with StatehistoryHosts.*)
 *
 * openITCockpit formats `state_time` with the date format and time zone of the
 * API user. Unix timestamps and ISO-8601 are used as they are; the usual
 * formats (`Y-m-d H:i:s`, `d.m.Y H:i:s`, `m/d/Y H:i:s`, `H:i:s - d.m.Y`) are
 * read as UTC, so the API user's time zone should be UTC (see docs/adapters/openitcockpit.md).
 *
 * Only hard states count, like the live adapter. The state before the first
 * event comes from the last event in the 30 days before the range, or from the
 * current status when its last hard state change lies before the range.
 *
 * Memory: one import keeps at most IMPORT_MAX_EVENTS state changes (all
 * checks together) and fails when the history holds more.
 */
import type { CheckState, HistoryImportWarning, OpenItCockpitConfig as OpenItCockpitConfigSchema } from '@openstatuspage/shared';
import type { z } from 'zod';
import { AdapterError, joinUrl, requestJson } from '../adapters/http.js';
import { extractEntries, hasNextPage, mapOitcHost, mapOitcService } from '../adapters/openitcockpit.js';
import { hostState, isRecord, serviceState, str } from '../adapters/states.js';
import { eventsToIntervals, type Valued } from '../lib/intervals.js';
import { EventBudget, IMPORT_MAX_EVENTS } from './limits.js';
import type { HistoryImporter, ImporterContext } from './types.js';

type OpenItCockpitConfig = z.infer<typeof OpenItCockpitConfigSchema>;
type Rec = Record<string, unknown>;
type Kind = 'service' | 'host';

const SYSTEM = 'openITCockpit API';
export const OITC_HISTORY_MAX_PAGES = 1000;
const LOOKBACK_MS = 30 * 86_400_000;

const rec = (v: unknown): Rec => (isRecord(v) ? v : {});
function pick(obj: Rec, ...keys: string[]): unknown {
  for (const key of keys) {
    const v = obj[key];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

const pad = (s: string) => s.padStart(2, '0');

/**
 * Parses a state_time / status timestamp: unix seconds or ms, ISO-8601, or one
 * of the openITCockpit user date formats (interpreted as UTC). Returns epoch ms or null.
 */
export function parseOitcTime(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (/^\d{9,13}$/.test(v)) return parseOitcTime(Number(v));
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    const iso = /([zZ]|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}Z`;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : t;
  }
  const time = '(\\d{1,2}):(\\d{2})(?::(\\d{2}))?';
  const build = (y: string, mo: string, d: string, h: string, mi: string, s?: string) => {
    const t = Date.parse(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${mi}:${s ?? '00'}Z`);
    return Number.isNaN(t) ? null : t;
  };
  let m = new RegExp(`^(\\d{4})-(\\d{1,2})-(\\d{1,2})[ T]${time}$`).exec(v);
  if (m) return build(m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, m[6]);
  m = new RegExp(`^(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4}),? ${time}$`).exec(v);
  if (m) return build(m[3]!, m[2]!, m[1]!, m[4]!, m[5]!, m[6]);
  m = new RegExp(`^(\\d{1,2})/(\\d{1,2})/(\\d{4}),? ${time}$`).exec(v);
  if (m) return build(m[3]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]);
  m = new RegExp(`^${time} - (\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})$`).exec(v);
  if (m) return build(m[6]!, m[5]!, m[4]!, m[1]!, m[2]!, m[3]);
  return null;
}

/** `Y-m-d H:i:s` in UTC, understood by PHP's strtotime(). */
function phpTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

interface OitcObject {
  kind: Kind;
  numericId: string;
  state: CheckState | null;
  /** Last hard state change (epoch ms) when known. */
  lastChange: number | null;
}

/** Numeric id and current status of an index entry. */
export function mapIndexEntry(entry: unknown, kind: Kind): { externalId: string; object: OitcObject } | null {
  const mapped = kind === 'service' ? mapOitcService(entry) : mapOitcHost(entry);
  if (!mapped) return null;
  const e = rec(entry);
  const obj = rec(pick(e, kind === 'service' ? 'Service' : 'Host', kind));
  const numericId = str(obj.id);
  if (!numericId || !/^\d+$/.test(numericId)) return null;
  const statusKey = kind === 'service' ? 'Servicestatus' : 'Hoststatus';
  const status = rec(pick(e, statusKey, statusKey.toLowerCase(), kind === 'service' ? 'ServiceStatus' : 'HostStatus'));
  const lastChange = parseOitcTime(
    pick(status, 'lastHardStateChangeUnix', 'last_hard_state_change', 'lastHardStateChange', 'last_state_change', 'lastStateChange'),
  );
  return {
    externalId: mapped.externalId,
    object: { kind, numericId, state: mapped.state === 'unknown' && mapped.output === 'No status available' ? null : mapped.state, lastChange },
  };
}

/** Events of a statehistory response page. */
export function mapStatehistoryEntries(body: unknown, kind: Kind): { at: number; value: CheckState }[] | null {
  if (!isRecord(body)) return null;
  const list = Array.isArray(body.all_statehistories) ? body.all_statehistories : null;
  if (!list) return null;
  const key = kind === 'service' ? 'StatehistoryService' : 'StatehistoryHost';
  const out: { at: number; value: CheckState }[] = [];
  for (const item of list) {
    const r = rec(pick(rec(item), key, key.toLowerCase()));
    const at = parseOitcTime(r.state_time);
    if (at === null || r.state === undefined) continue;
    // Soft states are retries: ignore them when the API marks them.
    if (r.is_hardstate === false) continue;
    out.push({ at, value: kind === 'service' ? serviceState(r.state) : hostState(r.state) });
  }
  return out;
}

async function getJson(config: OpenItCockpitConfig, ctx: ImporterContext, path: string): Promise<unknown> {
  return requestJson(ctx.fetch, joinUrl(config.baseUrl, path), {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `X-OITC-API ${config.apiKey}` },
    signal: ctx.signal,
    system: SYSTEM,
  });
}

async function loadIndex(config: OpenItCockpitConfig, ctx: ImporterContext, kind: Kind, into: Map<string, OitcObject>) {
  const plural = kind === 'service' ? 'services' : 'hosts';
  for (let page = 1; page <= OITC_HISTORY_MAX_PAGES; page++) {
    const body = await getJson(config, ctx, `${plural}/index.json?angular=true&page=${page}`);
    const entries = extractEntries(body, plural);
    if (!entries) throw new AdapterError(`${SYSTEM} returned an unexpected response for ${plural}/index.json (no result list)`);
    const before = into.size;
    for (const entry of entries) {
      const mapped = mapIndexEntry(entry, kind);
      if (mapped) into.set(mapped.externalId, mapped.object);
    }
    if (entries.length === 0 || into.size === before || !hasNextPage(body, page)) return;
  }
}

function historyPath(obj: OitcObject, from: number, to: number, page: number, direction: 'asc' | 'desc'): string {
  const table = obj.kind === 'service' ? 'StatehistoryServices' : 'StatehistoryHosts';
  const params = new URLSearchParams({
    angular: 'true',
    'filter[from]': phpTime(from),
    'filter[to]': phpTime(to),
    [`filter[${table}.state_type]`]: '1',
    sort: `${table}.state_time`,
    direction,
    page: String(page),
  });
  return `statehistories/${obj.kind}/${obj.numericId}.json?${params.toString()}`;
}

async function loadEvents(
  config: OpenItCockpitConfig,
  ctx: ImporterContext,
  obj: OitcObject,
  from: number,
  to: number,
  budget: EventBudget,
): Promise<{ at: number; value: CheckState }[]> {
  const events: { at: number; value: CheckState }[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= OITC_HISTORY_MAX_PAGES; page++) {
    const body = await getJson(config, ctx, historyPath(obj, from, to, page, 'asc'));
    const list = mapStatehistoryEntries(body, obj.kind);
    if (!list) throw new AdapterError(`${SYSTEM} returned an unexpected statehistory response (no "all_statehistories")`);
    let added = 0;
    for (const e of list) {
      const key = `${e.at}|${e.value}`;
      if (seen.has(key)) continue;
      budget.take();
      seen.add(key);
      events.push(e);
      added++;
    }
    if (list.length === 0 || added === 0 || !hasNextPage(body, page)) break;
  }
  return events.filter((e) => e.at >= from && e.at < to);
}

/** The last hard state before `from` (within the lookback window), or null. */
async function loadStateBefore(
  config: OpenItCockpitConfig,
  ctx: ImporterContext,
  obj: OitcObject,
  from: number,
): Promise<CheckState | null> {
  const body = await getJson(config, ctx, historyPath(obj, from - LOOKBACK_MS, from, 1, 'desc'));
  const list = (mapStatehistoryEntries(body, obj.kind) ?? []).filter((e) => e.at < from).sort((a, b) => b.at - a.at);
  return list[0]?.value ?? null;
}

export interface OpenItCockpitImporterOptions {
  /** State changes per import (default IMPORT_MAX_EVENTS). */
  maxEvents?: number;
}

export function createOpenItCockpitImporter(options: OpenItCockpitImporterOptions = {}): HistoryImporter<OpenItCockpitConfig> {
  return {
    type: 'openitcockpit',
    async fetch(config, _credentials, targets, range, ctx) {
      const budget = new EventBudget(SYSTEM, options.maxEvents ?? IMPORT_MAX_EVENTS);
      await ctx.progress('connecting', 0, targets.length);
      const objects = new Map<string, OitcObject>();
      const wantsHosts = targets.some((t) => !t.externalId.includes('!'));
      await loadIndex(config, ctx, 'service', objects);
      if (wantsHosts) await loadIndex(config, ctx, 'host', objects);

      const checks = new Map<string, Valued<CheckState>[]>();
      const warnings: HistoryImportWarning[] = [];
      let done = 0;
      for (const target of targets) {
        await ctx.progress('fetching', done++, targets.length);
        const obj = objects.get(target.externalId);
        if (!obj) continue;
        const events = await loadEvents(config, ctx, obj, range.from, range.to, budget);
        let initial = await loadStateBefore(config, ctx, obj, range.from);
        // No event in the lookback window: the current state holds since its last change.
        if (initial === null && obj.state && obj.lastChange !== null && obj.lastChange <= range.from) initial = obj.state;
        // A real event at range.from wins over the derived start state (later events win on ties).
        if (initial !== null && !events.some((e) => e.at === range.from)) events.unshift({ at: range.from, value: initial });
        if (events.length === 0 && obj.state && obj.lastChange !== null && obj.lastChange < range.to) {
          events.push({ at: Math.max(obj.lastChange, range.from), value: obj.state });
        }
        const intervals = eventsToIntervals(events, range.to);
        if (intervals.length > 0) checks.set(target.externalId, intervals);
      }
      await ctx.progress('fetching', done, targets.length);
      if (checks.size > 0) {
        warnings.push({
          code: 'oitc_utc',
          params: {},
          message: "openITCockpit times without a time zone were read as UTC (set the API user's time zone to UTC).",
        });
      }
      return { checks, warnings };
    },
  };
}

export const openItCockpitImporter = createOpenItCockpitImporter();

/**
 * openITCockpit adapter.
 *
 * Implemented against the public API documentation; response shapes differ
 * between versions, so the mapper is defensive. See docs/adapters/openitcockpit.md
 * for the assumptions made here.
 *
 * Pull: `GET /services/index.json?angular=true` and `GET /hosts/index.json?angular=true`
 *       (paginated), header `Authorization: X-OITC-API <apiKey>`.
 * Push: payload of contrib/openitcockpit/openstatuspage-notify.sh.
 *
 * External IDs use the object UUIDs, because openITCockpit writes UUIDs as
 * host_name / service_description into the monitoring core, which is what the
 * notification macros $HOSTNAME$ and $SERVICEDESC$ resolve to:
 *   services: `<host uuid>!<service uuid>`, hosts: `<host uuid>`.
 */
import { z } from 'zod';
import type { OpenItCockpitConfig as OpenItCockpitConfigSchema } from '@openstatuspage/shared';
import { AdapterError, joinUrl, requestJson } from './http.js';
import { hostState, isRecord, serviceState, str } from './states.js';
import type { AdapterContext, NormalizedCheck, PollAdapter, PushParser } from './types.js';

export type OpenItCockpitConfig = z.infer<typeof OpenItCockpitConfigSchema>;

const SYSTEM = 'openITCockpit API';
/** Hard limit of pages fetched per object type and poll. */
export const OITC_MAX_PAGES = 500;

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec {
  return isRecord(value) ? value : {};
}

function pick(obj: Rec, ...keys: string[]): unknown {
  for (const key of keys) {
    const v = obj[key];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** Only machine-readable timestamps (unix seconds or ISO-8601); user-formatted dates are ignored. */
function machineTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value < 1e11 ? value * 1000 : value).toISOString();
  }
  if (typeof value === 'string') {
    const v = value.trim();
    if (/^\d{9,13}$/.test(v)) return machineTimestamp(Number(v));
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
  }
  return null;
}

function statusOf(entry: Rec, key: 'Servicestatus' | 'Hoststatus'): { state: unknown; output: string | null; checkedAt: string | null } {
  const s = rec(pick(entry, key, key.toLowerCase(), key === 'Servicestatus' ? 'ServiceStatus' : 'HostStatus'));
  return {
    state: pick(s, 'currentState', 'current_state', 'state'),
    output: str(pick(s, 'output', 'outputHtml')) ?? null,
    checkedAt: machineTimestamp(pick(s, 'lastCheckUnix', 'last_check', 'lastCheck')),
  };
}

/** Maps one entry of `services/index.json`. Returns null when no usable identifier exists. */
export function mapOitcService(entry: unknown): NormalizedCheck | null {
  const e = rec(entry);
  const service = rec(pick(e, 'Service', 'service'));
  const host = rec(pick(e, 'Host', 'host'));
  const serviceId = str(pick(service, 'uuid', 'id'));
  const hostName = str(pick(host, 'name', 'hostname')) ?? str(pick(service, 'hostname', 'host_name'));
  const hostId = str(pick(host, 'uuid', 'id')) ?? str(pick(service, 'host_uuid', 'host_id')) ?? hostName;
  const serviceName = str(pick(service, 'servicename', 'name', 'service_name'));
  if (!serviceId || !hostId) return null;
  const status = statusOf(e, 'Servicestatus');
  return {
    externalId: `${hostId}!${serviceId}`,
    name: serviceName ?? serviceId,
    host: hostName,
    // No status yet = not (yet) in monitoring.
    state: status.state === undefined ? 'unknown' : serviceState(status.state),
    output: status.state === undefined ? 'No status available' : status.output,
    checkedAt: status.checkedAt,
  };
}

/** Maps one entry of `hosts/index.json`. */
export function mapOitcHost(entry: unknown): NormalizedCheck | null {
  const e = rec(entry);
  const host = rec(pick(e, 'Host', 'host'));
  const hostName = str(pick(host, 'name', 'hostname'));
  const hostId = str(pick(host, 'uuid', 'id')) ?? hostName;
  if (!hostId) return null;
  const status = statusOf(e, 'Hoststatus');
  return {
    externalId: hostId,
    name: hostName ?? hostId,
    host: hostName,
    state: status.state === undefined ? 'unknown' : hostState(status.state),
    output: status.state === undefined ? 'No status available' : status.output,
    checkedAt: status.checkedAt,
  };
}

/** Finds the result array of an index response (`all_services`, `all_hosts`, ...). */
export function extractEntries(body: unknown, kind: 'services' | 'hosts'): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!isRecord(body)) return null;
  for (const key of [`all_${kind}`, kind, 'data', 'results']) {
    if (Array.isArray(body[key])) return body[key] as unknown[];
  }
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value) && !key.startsWith('_') && value.every(isRecord)) return value;
  }
  return null;
}

/** Reads pagination info: `paging` (classic) or `scroll` (newer versions). */
export function hasNextPage(body: unknown, page: number): boolean {
  if (!isRecord(body)) return false;
  const scroll = rec(body.scroll);
  if (typeof scroll.hasNextPage === 'boolean') return scroll.hasNextPage;
  const paging = rec(body.paging);
  if (typeof paging.nextPage === 'boolean') return paging.nextPage;
  const pageCount = Number(paging.pageCount ?? paging.pages);
  if (Number.isFinite(pageCount)) return page < pageCount;
  return false;
}

async function fetchAll(
  config: OpenItCockpitConfig,
  ctx: AdapterContext,
  kind: 'services' | 'hosts',
  map: (entry: unknown) => NormalizedCheck | null,
): Promise<NormalizedCheck[]> {
  const byId = new Map<string, NormalizedCheck>();
  for (let page = 1; page <= OITC_MAX_PAGES; page++) {
    const url = joinUrl(config.baseUrl, `${kind}/index.json?angular=true&page=${page}`);
    const body = await requestJson(ctx.fetch, url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `X-OITC-API ${config.apiKey}` },
      signal: ctx.signal,
      system: SYSTEM,
      limits: ctx.limits,
    });
    const entries = extractEntries(body, kind);
    if (!entries) {
      throw new AdapterError(`${SYSTEM} returned an unexpected response for ${kind}/index.json (no result list)`);
    }
    const before = byId.size;
    for (const entry of entries) {
      const check = map(entry);
      if (check) byId.set(check.externalId, check);
    }
    // Stop on the last page, on empty pages and when the server ignores the page parameter.
    if (entries.length === 0 || byId.size === before || !hasNextPage(body, page)) break;
    if (page === OITC_MAX_PAGES) {
      throw new AdapterError(`${SYSTEM}: more than ${OITC_MAX_PAGES} pages of ${kind}; aborting to protect the server`);
    }
  }
  return [...byId.values()];
}

export const openItCockpitPollAdapter: PollAdapter<OpenItCockpitConfig> = {
  type: 'openitcockpit',
  async poll(config, ctx) {
    const checks = await fetchAll(config, ctx, 'services', mapOitcService);
    if (config.includeHosts) checks.push(...(await fetchAll(config, ctx, 'hosts', mapOitcHost)));
    return checks;
  },
};

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

const zText = (max: number) => z.string().max(max);

/** Payload sent by contrib/openitcockpit/openstatuspage-notify.sh. */
export const OitcPushEvent = z.object({
  type: z.enum(['host', 'service']).optional(),
  /** $HOSTNAME$ (the host UUID in openITCockpit). */
  host: zText(500).min(1),
  /** $SERVICEDESC$ (the service UUID in openITCockpit). */
  service: zText(500).optional(),
  /** $HOSTDISPLAYNAME$ / $SERVICEDISPLAYNAME$ (human readable names). */
  hostDisplayName: zText(500).optional(),
  serviceDisplayName: zText(500).optional(),
  /** $SERVICESTATEID$ / $HOSTSTATEID$. */
  stateId: z.union([z.number(), zText(8)]),
  output: zText(5000).optional(),
  /** $TIMET$ (unix seconds). */
  timestamp: z.union([z.number(), zText(64)]).optional(),
});
export type OitcPushEvent = z.infer<typeof OitcPushEvent>;

const OitcPushBody = z.union([OitcPushEvent, z.array(OitcPushEvent).min(1).max(1000)]);

/** Unresolved Nagios macros (e.g. `$SERVICEDISPLAYNAME$`) are treated as empty. */
function macro(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v || /^\$[A-Z_]+\$$/.test(v)) return null;
  return v;
}

export function mapOitcPushEvent(event: OitcPushEvent): NormalizedCheck {
  const service = macro(event.service);
  const isHost = event.type === 'host' || (event.type === undefined && !service);
  const hostName = macro(event.hostDisplayName) ?? event.host;
  const checkedAt = machineTimestamp(event.timestamp);
  if (isHost) {
    return {
      externalId: event.host,
      name: hostName,
      host: hostName,
      state: hostState(event.stateId),
      output: event.output ?? null,
      checkedAt,
    };
  }
  if (!service) throw new Error('Missing "service" for a service notification');
  return {
    externalId: `${event.host}!${service}`,
    name: macro(event.serviceDisplayName) ?? service,
    host: hostName,
    state: serviceState(event.stateId),
    output: event.output ?? null,
    checkedAt,
  };
}

export const openItCockpitPushParser: PushParser = {
  parse(body) {
    const parsed = OitcPushBody.parse(body);
    const events = Array.isArray(parsed) ? parsed : [parsed];
    return { checks: events.map(mapOitcPushEvent), full: false };
  },
};

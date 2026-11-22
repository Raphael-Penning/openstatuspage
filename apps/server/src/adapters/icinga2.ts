/**
 * Icinga 2 adapter.
 *
 * Pull: REST API `/v1/objects/services` (and `/v1/objects/hosts`), HTTP Basic auth.
 * Push: payload of contrib/icinga2/openstatuspage-notify.sh (see docs/adapters/icinga2.md).
 *
 * External IDs: `host!service` for services, `host` for hosts – identical for
 * pull and push, so both modes can be combined on one source.
 */
import { z } from 'zod';
import type { Icinga2Config as Icinga2ConfigSchema } from '@openstatuspage/shared';
import { AdapterError, basicAuth, joinUrl, requestJson } from './http.js';
import { hostState, isRecord, serviceState, str, timestampToIso } from './states.js';
import type { AdapterContext, NormalizedCheck, PollAdapter, PushParser } from './types.js';

export type Icinga2Config = z.infer<typeof Icinga2ConfigSchema>;

const SYSTEM = 'Icinga 2 API';

export const SERVICE_ATTRS = [
  'name',
  'display_name',
  'host_name',
  'state',
  'last_hard_state',
  'state_type',
  'last_check',
  'last_check_result',
  'downtime_depth',
  'acknowledgement',
] as const;

export const HOST_ATTRS = ['name', 'display_name', 'state', 'last_hard_state', 'state_type', 'last_check', 'last_check_result'] as const;

/** `https://icinga.example.com:5665` and `https://icinga.example.com:5665/v1` both work. */
export function icingaApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return joinUrl(base, `v1/${path}`);
}

interface IcingaObject {
  name?: unknown;
  type?: unknown;
  attrs?: Record<string, unknown>;
}

async function queryObjects(
  config: Icinga2Config,
  ctx: AdapterContext,
  kind: 'services' | 'hosts',
  attrs: readonly string[],
  filter?: { filter: string; filter_vars?: Record<string, unknown> },
): Promise<IcingaObject[]> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: basicAuth(config.username, config.password),
  };
  let url = icingaApiUrl(config.baseUrl, `objects/${kind}`);
  let init: RequestInit;
  if (filter) {
    // Filters can be long: send them in a POST body with method override.
    init = {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'X-HTTP-Method-Override': 'GET' },
      body: JSON.stringify({ ...filter, attrs }),
    };
  } else {
    url += `?${attrs.map((a) => `attrs=${encodeURIComponent(a)}`).join('&')}`;
    init = { method: 'GET', headers };
  }
  const body = await requestJson<{ results?: unknown }>(ctx.fetch, url, {
    ...init,
    signal: ctx.signal,
    system: SYSTEM,
    limits: ctx.limits,
  });
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new AdapterError(`${SYSTEM} returned an unexpected response for objects/${kind} (no "results" array)`);
  }
  return body.results.filter(isRecord) as IcingaObject[];
}

function checkResult(attrs: Record<string, unknown>): { output: string | null; checkedAt: string | null } | null {
  const result = attrs.last_check_result;
  if (!isRecord(result)) return null;
  return {
    output: typeof result.output === 'string' ? result.output : null,
    checkedAt: timestampToIso(result.execution_end) ?? timestampToIso(attrs.last_check),
  };
}

/** Maps one entry of `/v1/objects/services` to a normalized check. */
export function mapIcingaService(obj: IcingaObject): NormalizedCheck | null {
  const attrs = obj.attrs ?? {};
  const host = str(attrs.host_name);
  const service = str(attrs.name);
  if (!host || !service) return null;
  const result = checkResult(attrs);
  return {
    externalId: `${host}!${service}`,
    name: str(attrs.display_name) ?? service,
    host,
    // Soft states are transient (the check is being re-tried): report the last hard state.
    state: result ? serviceState(attrs.last_hard_state ?? attrs.state) : 'unknown',
    output: result ? result.output : 'Pending: not checked yet',
    checkedAt: result?.checkedAt ?? null,
  };
}

/** Maps one entry of `/v1/objects/hosts` to a normalized check. */
export function mapIcingaHost(obj: IcingaObject): NormalizedCheck | null {
  const attrs = obj.attrs ?? {};
  const host = str(attrs.name) ?? str(obj.name);
  if (!host) return null;
  const result = checkResult(attrs);
  return {
    externalId: host,
    name: str(attrs.display_name) ?? host,
    host,
    state: result ? hostState(attrs.last_hard_state ?? attrs.state) : 'unknown',
    output: result ? result.output : 'Pending: not checked yet',
    checkedAt: result?.checkedAt ?? null,
  };
}

export const icinga2PollAdapter: PollAdapter<Icinga2Config> = {
  type: 'icinga2',
  async poll(config, ctx) {
    const filter = config.filter?.trim();
    const services = await queryObjects(config, ctx, 'services', SERVICE_ATTRS, filter ? { filter } : undefined);
    const checks = services.map(mapIcingaService).filter((c): c is NormalizedCheck => c !== null);

    if (config.includeHosts) {
      let hosts: IcingaObject[];
      if (filter) {
        // The filter is a service expression; import only the hosts of matching services.
        const names = [...new Set(checks.map((c) => c.host).filter((h): h is string => !!h))];
        hosts = names.length
          ? await queryObjects(config, ctx, 'hosts', HOST_ATTRS, {
              filter: 'host.name in osp_hosts',
              filter_vars: { osp_hosts: names },
            })
          : [];
      } else {
        hosts = await queryObjects(config, ctx, 'hosts', HOST_ATTRS);
      }
      checks.push(...hosts.map(mapIcingaHost).filter((c): c is NormalizedCheck => c !== null));
    }
    return checks;
  },
};

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

const zText = (max: number) => z.string().max(max);

/** Payload sent by contrib/icinga2/openstatuspage-notify.sh. */
export const Icinga2PushEvent = z.object({
  /** "host" or "service". Defaults to "service" when `service` is set. */
  type: z.enum(['host', 'service']).optional(),
  host: zText(500).min(1),
  service: zText(500).optional(),
  displayName: zText(500).optional(),
  hostDisplayName: zText(500).optional(),
  /** Icinga state name: OK/WARNING/CRITICAL/UNKNOWN or UP/DOWN. */
  state: zText(32).optional(),
  /** Numeric state ($service.state_id$ / $host.state_id$), preferred over `state`. */
  stateId: z.union([z.number(), zText(8)]).optional(),
  output: zText(5000).optional(),
  /** Unix timestamp (seconds) or ISO-8601. */
  timestamp: z.union([z.number(), zText(64)]).optional(),
  notificationType: zText(64).optional(),
});
export type Icinga2PushEvent = z.infer<typeof Icinga2PushEvent>;

const Icinga2PushBody = z.union([Icinga2PushEvent, z.array(Icinga2PushEvent).min(1).max(1000)]);

export function mapIcinga2PushEvent(event: Icinga2PushEvent): NormalizedCheck {
  const isHost = event.type === 'host' || (event.type === undefined && !event.service?.trim());
  const rawState = event.stateId !== undefined && event.stateId !== '' ? event.stateId : event.state;
  if (rawState === undefined || rawState === '') throw new Error('Missing "state" or "stateId"');
  if (isHost) {
    return {
      externalId: event.host,
      name: event.hostDisplayName?.trim() || event.host,
      host: event.host,
      state: hostState(rawState),
      output: event.output ?? null,
      checkedAt: timestampToIso(event.timestamp),
    };
  }
  const service = event.service?.trim();
  if (!service) throw new Error('Missing "service" for a service notification');
  return {
    externalId: `${event.host}!${service}`,
    name: event.displayName?.trim() || service,
    host: event.host,
    state: serviceState(rawState),
    output: event.output ?? null,
    checkedAt: timestampToIso(event.timestamp),
  };
}

export const icinga2PushParser: PushParser = {
  parse(body) {
    const parsed = Icinga2PushBody.parse(body);
    const events = Array.isArray(parsed) ? parsed : [parsed];
    return { checks: events.map(mapIcinga2PushEvent), full: false };
  },
};

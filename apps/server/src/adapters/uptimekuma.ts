/**
 * Uptime Kuma adapter.
 *
 * Pull: Prometheus endpoint `/metrics`, HTTP Basic auth with an empty user
 *       name and an API key as password.
 * Push: native "Webhook" notification (JSON body).
 *
 * External ID is the monitor name in both modes, so pull and push can be
 * combined on one source. Monitor names should therefore be unique.
 */
import { z } from 'zod';
import type { CheckState, UptimeKumaConfig as UptimeKumaConfigSchema } from '@openstatuspage/shared';
import { AdapterError, basicAuth, joinUrl, requestText } from './http.js';
import { parsePrometheusText, type PromSample } from './prometheus.js';
import type { NormalizedCheck, PollAdapter, PushParser } from './types.js';

export type UptimeKumaConfig = z.infer<typeof UptimeKumaConfigSchema>;

const SYSTEM = 'Uptime Kuma';

/** Uptime Kuma heartbeat / monitor_status values. */
export function kumaState(value: number): CheckState {
  switch (value) {
    case 1: // UP
      return 'ok';
    case 0: // DOWN
      return 'critical';
    case 2: // PENDING (retrying)
      return 'warning';
    case 3: // MAINTENANCE: planned work, reported as ok (announce it as maintenance on the status page)
      return 'ok';
    default:
      return 'unknown';
  }
}

const STATE_LABEL: Record<number, string> = { 0: 'Down', 1: 'Up', 2: 'Pending', 3: 'Maintenance' };

/** Uptime Kuma exports missing values as the string "null". */
function label(value: string | undefined | null): string | null {
  if (value == null) return null;
  const t = value.trim();
  return t && t !== 'null' && t !== 'undefined' ? t : null;
}

function hostFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.hostname || null;
  } catch {
    return null;
  }
}

/** Builds normalized checks from parsed `/metrics` samples. */
export function mapKumaMetrics(samples: PromSample[]): NormalizedCheck[] {
  const responseTimes = new Map<string, number>();
  for (const s of samples) {
    if (s.name !== 'monitor_response_time') continue;
    const name = label(s.labels.monitor_name);
    if (name && Number.isFinite(s.value)) responseTimes.set(name, s.value);
  }

  const checks: NormalizedCheck[] = [];
  for (const s of samples) {
    if (s.name !== 'monitor_status') continue;
    const name = label(s.labels.monitor_name);
    if (!name) continue;
    const url = label(s.labels.monitor_url);
    const value = Number.isFinite(s.value) ? Math.round(s.value) : -1;
    const rt = responseTimes.get(name);
    const parts = [STATE_LABEL[value] ?? `Unknown status ${String(s.value)}`];
    const type = label(s.labels.monitor_type);
    if (type) parts.push(`type ${type}`);
    if (rt !== undefined && rt >= 0) parts.push(`response time ${rt} ms`);
    checks.push({
      externalId: name,
      name,
      host: label(s.labels.monitor_hostname) ?? hostFromUrl(url),
      state: kumaState(value),
      output: parts.join(', '),
      checkedAt: null,
    });
  }
  return checks;
}

export const uptimeKumaPollAdapter: PollAdapter<UptimeKumaConfig> = {
  type: 'uptimekuma',
  async poll(config, ctx) {
    const url = joinUrl(config.baseUrl, 'metrics');
    const text = await requestText(ctx.fetch, url, {
      method: 'GET',
      headers: { Accept: 'text/plain', Authorization: basicAuth('', config.apiKey) },
      signal: ctx.signal,
      system: SYSTEM,
    });
    const { samples } = parsePrometheusText(text);
    if (!samples.some((s) => s.name === 'monitor_status')) {
      throw new AdapterError(
        `${SYSTEM}: /metrics contains no "monitor_status" metric. Check the base URL and that it points to Uptime Kuma.`,
      );
    }
    return mapKumaMetrics(samples);
  },
};

// ---------------------------------------------------------------------------
// Push: native webhook notification
// ---------------------------------------------------------------------------

// Length bounds follow the generic push format (GenericIngestPayload): 500 for
// names and hosts, 5000 for messages. URLs get more room; only their host is kept.
const KumaWebhook = z.object({
  heartbeat: z
    .object({
      status: z.number(),
      msg: z.string().max(5000).nullish(),
      time: z.string().max(64).nullish(),
    })
    .nullish(),
  monitor: z
    .object({
      id: z.union([z.number(), z.string().max(500)]).nullish(),
      name: z.string().min(1).max(500),
      url: z.string().max(8192).nullish(),
      hostname: z.string().max(500).nullish(),
      type: z.string().max(100).nullish(),
    })
    .nullish(),
  msg: z.string().max(5000).nullish(),
});

/** Heartbeat times are UTC in the format `YYYY-MM-DD HH:mm:ss.SSS`. */
export function kumaTimeToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v)) v = v.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(v)) v += 'Z';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const uptimeKumaPushParser: PushParser = {
  parse(body) {
    const payload = KumaWebhook.parse(body);
    // Test notifications and certificate expiry warnings carry no heartbeat.
    if (!payload.heartbeat) return { checks: [], full: false };
    if (!payload.monitor) throw new Error('Webhook payload contains a heartbeat but no monitor');
    const { heartbeat, monitor } = payload;
    const url = label(monitor.url ?? null);
    return {
      checks: [
        {
          externalId: monitor.name,
          name: monitor.name,
          host: label(monitor.hostname ?? null) ?? hostFromUrl(url),
          state: kumaState(heartbeat.status),
          output: heartbeat.msg ?? STATE_LABEL[heartbeat.status] ?? null,
          checkedAt: kumaTimeToIso(heartbeat.time),
        },
      ],
      full: false,
    };
  },
};

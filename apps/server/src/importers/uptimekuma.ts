/**
 * Uptime Kuma history importer.
 *
 * Uptime Kuma has no REST API for heartbeats; its web UI talks Socket.IO. The
 * importer logs in like the UI (user name, password, optional 2FA code) and
 * uses the events available in 1.23 and 2.x:
 *   login {username, password, token}  → ack {ok, tokenRequired, msg}
 *   monitorList                         ← pushed after login (id → monitor)
 *   getMonitorBeats(monitorId, hours)   → ack {ok, data: heartbeat[]}
 * Heartbeat status: 0 down, 1 up, 2 pending, 3 maintenance (see adapters/uptimekuma.ts).
 *
 * External ids are monitor names, as in the live adapter. Every heartbeat
 * holds until the next one, but at most 3 check intervals (min. 10 minutes),
 * so a paused monitor does not extend its last state.
 * Uptime Kuma keeps heartbeats for "Keep monitor history data" days (default 180).
 */
import type { CheckState, UptimeKumaConfig as UptimeKumaConfigSchema } from '@openstatuspage/shared';
import type { z } from 'zod';
import { AdapterError } from '../adapters/http.js';
import { isRecord } from '../adapters/states.js';
import { kumaState, kumaTimeToIso } from '../adapters/uptimekuma.js';
import { clipToWindows, eventsToIntervals, type Valued } from '../lib/intervals.js';
import { SocketIoClient } from './socketio.js';
import type { HistoryImporter } from './types.js';

type UptimeKumaConfig = z.infer<typeof UptimeKumaConfigSchema>;

const SYSTEM = 'Uptime Kuma';
const EVENT_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;

interface KumaMonitor {
  id: number;
  name: string;
  intervalSeconds: number;
}

/** Monitors from the `monitorList` event (object keyed by id). */
export function parseMonitorList(value: unknown): KumaMonitor[] {
  if (!isRecord(value)) return [];
  const out: KumaMonitor[] = [];
  for (const m of Object.values(value)) {
    if (!isRecord(m)) continue;
    const id = Number(m.id);
    const name = typeof m.name === 'string' ? m.name : null;
    if (!Number.isInteger(id) || !name) continue;
    const interval = Number(m.interval);
    out.push({ id, name, intervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : 60 });
  }
  return out;
}

/** Heartbeats → state intervals inside [from, to). */
export function beatsToIntervals(
  beats: unknown[],
  intervalSeconds: number,
  from: number,
  to: number,
): Valued<CheckState>[] {
  const events: { at: number; value: CheckState }[] = [];
  for (const b of beats) {
    if (!isRecord(b)) continue;
    const iso = kumaTimeToIso(typeof b.time === 'string' ? b.time : null);
    const status = Number(b.status);
    if (!iso || !Number.isFinite(status)) continue;
    events.push({ at: Date.parse(iso), value: kumaState(status) });
  }
  const maxHold = Math.max(3 * intervalSeconds * 1000, 10 * 60_000);
  return clipToWindows(eventsToIntervals(events, to, maxHold), [{ start: from, end: to }]);
}

async function login(client: SocketIoClient, username: string, password: string, totp?: string): Promise<void> {
  const [res] = await client.emitWithAck('login', { username, password, token: totp ?? '' });
  if (isRecord(res) && res.ok === true) return;
  if (isRecord(res) && res.tokenRequired === true) {
    throw new AdapterError(`${SYSTEM}: this account uses two-factor authentication; enter a current 2FA code.`);
  }
  const msg = isRecord(res) && typeof res.msg === 'string' ? res.msg : 'login failed';
  throw new AdapterError(`${SYSTEM}: ${msg}`);
}

export const uptimeKumaImporter: HistoryImporter<UptimeKumaConfig> = {
  type: 'uptimekuma',
  async fetch(config, credentials, targets, range, ctx) {
    const username = credentials.username ?? config.historyUsername ?? '';
    const password = credentials.password ?? config.historyPassword ?? '';
    if (!username || !password) {
      throw new AdapterError(`${SYSTEM}: a user name and password are required to read the heartbeat history.`);
    }
    const client = new SocketIoClient({ baseUrl: config.baseUrl, fetch: ctx.fetch, signal: ctx.signal, system: SYSTEM });
    const checks = new Map<string, Valued<CheckState>[]>();
    const warnings: string[] = [];
    try {
      await ctx.progress('connecting', 0, targets.length);
      await client.connect();
      // Subscribe before logging in: the list is pushed right after a successful login.
      const listPromise = client.waitFor('monitorList', EVENT_TIMEOUT_MS);
      listPromise.catch(() => undefined);
      await login(client, username, password, credentials.totp);
      const [list] = await listPromise;
      const monitors = parseMonitorList(list);
      const byName = new Map<string, KumaMonitor[]>();
      for (const m of monitors) byName.set(m.name, [...(byName.get(m.name) ?? []), m]);

      const hours = Math.ceil((Date.now() - range.from) / 3_600_000) + 1;
      let earliest = Number.POSITIVE_INFINITY;
      let done = 0;
      for (const target of targets) {
        await ctx.progress('fetching', done++, targets.length);
        const matches = byName.get(target.externalId) ?? [];
        if (matches.length > 1) {
          warnings.push(`Several Uptime Kuma monitors are named "${target.externalId}"; skipped.`);
          continue;
        }
        const monitor = matches[0];
        if (!monitor) continue;
        const [res] = await client.emitWithAck('getMonitorBeats', monitor.id, hours);
        if (!isRecord(res) || res.ok !== true || !Array.isArray(res.data)) {
          const msg = isRecord(res) && typeof res.msg === 'string' ? res.msg : 'unexpected response';
          throw new AdapterError(`${SYSTEM}: getMonitorBeats failed: ${msg}`);
        }
        const intervals = beatsToIntervals(res.data, monitor.intervalSeconds, range.from, range.to);
        if (intervals.length > 0) {
          checks.set(target.externalId, intervals);
          earliest = Math.min(earliest, intervals[0]!.start);
        }
      }
      await ctx.progress('fetching', done, targets.length);
      if (checks.size > 0 && earliest > range.from + DAY_MS) {
        warnings.push(
          `Uptime Kuma returned heartbeats from ${new Date(earliest).toISOString()} on only. Older data was ` +
            'removed by its retention ("Keep monitor history data", default 180 days).',
        );
      }
      return { checks, warnings };
    } finally {
      await client.close();
    }
  },
};

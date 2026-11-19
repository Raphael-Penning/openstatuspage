/**
 * Uptime Kuma history importer.
 *
 * Uptime Kuma has no REST API for heartbeats; its web UI talks Socket.IO. The
 * importer logs in like the UI (user name, password, optional 2FA code) and
 * uses the events available in 1.23 and 2.x:
 *   login {username, password, token}  → ack {ok, tokenRequired, msg}
 *   monitorList                         ← pushed after login (id → monitor)
 *   loginByToken(jwt)                   → ack {ok} (reconnects, no new 2FA code)
 *   getMonitorBeats(monitorId, hours)   → ack {ok, data: heartbeat[]}
 * Heartbeat status: 0 down, 1 up, 2 pending, 3 maintenance (see adapters/uptimekuma.ts).
 *
 * External ids are monitor names, as in the live adapter. Every heartbeat
 * holds until the next one, but at most 3 check intervals (min. 10 minutes),
 * so a paused monitor does not extend its last state.
 * Uptime Kuma keeps heartbeats for "Keep monitor history data" days (default 180).
 *
 * getMonitorBeats returns all heartbeats from the start of the range up to now
 * in one message. A monitor whose answer fails (e.g. over the 50 MiB response
 * limit: roughly 200k heartbeats) is skipped with a warning; the connection is
 * then opened again for the remaining monitors.
 */
import type { CheckState, HistoryImportWarning, UptimeKumaConfig as UptimeKumaConfigSchema } from '@openstatuspage/shared';
import type { z } from 'zod';
import { AdapterError } from '../adapters/http.js';
import { isRecord } from '../adapters/states.js';
import { kumaState, kumaTimeToIso } from '../adapters/uptimekuma.js';
import { clipToWindows, eventsToIntervals, type Valued } from '../lib/intervals.js';
import { SocketIoClient } from './socketio.js';
import type { HistoryImporter, ImporterContext } from './types.js';

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

interface Session {
  client: SocketIoClient;
  monitors: KumaMonitor[];
  /** JWT of the login, used to log in again after a reconnect (no new 2FA code needed). */
  token: string | null;
}

/** Connects and logs in (with the JWT when known, else with user name and password). */
async function openSession(
  config: UptimeKumaConfig,
  ctx: ImporterContext,
  login: { username: string; password: string; totp?: string; token: string | null },
): Promise<Session> {
  const client = new SocketIoClient({ baseUrl: config.baseUrl, fetch: ctx.fetch, signal: ctx.signal, system: SYSTEM });
  try {
    await client.connect();
    // Subscribe before logging in: the list is pushed right after a successful login.
    const listPromise = client.waitFor('monitorList', EVENT_TIMEOUT_MS);
    listPromise.catch(() => undefined);
    let token = login.token;
    if (token) {
      const [res] = await client.emitWithAck('loginByToken', token);
      if (!isRecord(res) || res.ok !== true) throw new AdapterError(`${SYSTEM}: logging in again failed`);
    } else {
      const [res] = await client.emitWithAck('login', { username: login.username, password: login.password, token: login.totp ?? '' });
      if (!isRecord(res) || res.ok !== true) {
        if (isRecord(res) && res.tokenRequired === true) {
          throw new AdapterError(`${SYSTEM}: this account uses two-factor authentication; enter a current 2FA code.`);
        }
        const msg = isRecord(res) && typeof res.msg === 'string' ? res.msg : 'login failed';
        throw new AdapterError(`${SYSTEM}: ${msg}`);
      }
      token = typeof res.token === 'string' && res.token !== '' ? res.token : null;
    }
    const [list] = await listPromise;
    return { client, monitors: parseMonitorList(list), token };
  } catch (err) {
    await client.close();
    throw err;
  }
}

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Uptime Kuma: /, '');

export const uptimeKumaImporter: HistoryImporter<UptimeKumaConfig> = {
  type: 'uptimekuma',
  async fetch(config, credentials, targets, range, ctx) {
    const username = credentials.username ?? config.historyUsername ?? '';
    const password = credentials.password ?? config.historyPassword ?? '';
    if (!username || !password) {
      throw new AdapterError(`${SYSTEM}: a user name and password are required to read the heartbeat history.`);
    }
    const checks = new Map<string, Valued<CheckState>[]>();
    const warnings: HistoryImportWarning[] = [];
    await ctx.progress('connecting', 0, targets.length);
    const login = { username, password, totp: credentials.totp, token: null as string | null };
    let session: Session | null = await openSession(config, ctx, login);
    login.token = session.token;
    try {
      const byName = new Map<string, KumaMonitor[]>();
      for (const m of session.monitors) byName.set(m.name, [...(byName.get(m.name) ?? []), m]);

      const hours = Math.ceil((Date.now() - range.from) / 3_600_000) + 1;
      let earliest = Number.POSITIVE_INFINITY;
      let done = 0;
      for (const target of targets) {
        await ctx.progress('fetching', done++, targets.length);
        const matches = byName.get(target.externalId) ?? [];
        if (matches.length > 1) {
          warnings.push({
            code: 'kuma_duplicate_name',
            params: { name: target.externalId },
            message: `Several Uptime Kuma monitors are named "${target.externalId}"; skipped.`,
          });
          continue;
        }
        const monitor = matches[0];
        if (!monitor) continue;
        // A failed response (e.g. one over the size limit) breaks the connection: open a new one.
        // When that fails too, the source is unreachable and the whole fetch fails.
        if (!session) {
          session = await openSession(config, ctx, login);
          login.token = session.token ?? login.token;
        }
        let beats: unknown[];
        try {
          const [res] = await session.client.emitWithAck('getMonitorBeats', monitor.id, hours);
          if (!isRecord(res) || res.ok !== true || !Array.isArray(res.data)) {
            const msg = isRecord(res) && typeof res.msg === 'string' ? res.msg : 'unexpected response';
            throw new AdapterError(`${SYSTEM}: getMonitorBeats failed: ${msg}`);
          }
          beats = res.data;
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          // Skip this monitor; the others can still be imported.
          warnings.push({
            code: 'kuma_monitor_failed',
            params: { name: target.externalId, reason: reasonOf(err) },
            message: `The heartbeats of "${target.externalId}" could not be read and were skipped: ${reasonOf(err)}`,
          });
          await session?.client.close();
          session = null;
          continue;
        }
        const intervals = beatsToIntervals(beats, monitor.intervalSeconds, range.from, range.to);
        if (intervals.length > 0) {
          checks.set(target.externalId, intervals);
          earliest = Math.min(earliest, intervals[0]!.start);
        }
      }
      await ctx.progress('fetching', done, targets.length);
      if (checks.size > 0 && earliest > range.from + DAY_MS) {
        const at = new Date(earliest).toISOString();
        warnings.push({
          code: 'kuma_retention',
          params: { earliest: at },
          message:
            `Uptime Kuma returned heartbeats from ${at} on only. Older data was ` +
            'removed by its retention ("Keep monitor history data", default 180 days).',
        });
      }
      return { checks, warnings };
    } finally {
      await session?.client.close();
    }
  },
};

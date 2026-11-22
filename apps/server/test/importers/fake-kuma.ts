/**
 * Fake Uptime Kuma Socket.IO server (Engine.IO v4 long polling) behind a fetch
 * double. Implements the handshake, ping/pong, `login`, `loginByToken` and
 * `getMonitorBeats` like Uptime Kuma 1.23 / 2.x do. Every handshake opens a
 * new session.
 */
const SEP = '\x1e';
const JWT = 'fake-jwt';

export interface FakeKumaOptions {
  username?: string;
  password?: string;
  /** Require this 2FA code. */
  totp?: string;
  monitors: { id: number; name: string; interval?: number }[];
  /** Heartbeats per monitor id: [time "YYYY-MM-DD HH:mm:ss.SSS" (UTC), status]. */
  beats: Record<number, [string, number][]>;
  /** Monitor ids whose getMonitorBeats answer is larger than the response limit (51 MiB, streamed). */
  oversized?: number[];
  /** Before answering getMonitorBeats, push `count` events named `event` with a padding of `size` characters each. */
  flood?: { event: string; count: number; size?: number };
}

export interface FakeKuma {
  fetch: typeof fetch;
  /** Events received (name and args), for assertions. */
  received: { event: string; args: unknown[] }[];
  requests: { method: string; url: string }[];
  /** Number of Engine.IO sessions opened. */
  sessions: () => number;
}

interface Session {
  queue: string[];
  waiter: (() => void) | null;
  pinged: boolean;
  /** Pending oversized answer: sent instead of the next poll response. */
  oversized: boolean;
}

/** A body of `mib` MiB, generated lazily so the test does not hold it in memory. */
function hugeBody(mib: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent++ >= mib) controller.close();
      else controller.enqueue(chunk);
    },
  });
}

export function fakeKuma(options: FakeKumaOptions): FakeKuma {
  const sessions = new Map<string, Session>();
  const received: FakeKuma['received'] = [];
  const requests: FakeKuma['requests'] = [];
  const enqueue = (s: Session, packet: string) => {
    s.queue.push(packet);
    s.waiter?.();
    s.waiter = null;
  };
  const monitorList = () =>
    Object.fromEntries(
      options.monitors.map((m) => [String(m.id), { id: m.id, name: m.name, interval: m.interval ?? 60, type: 'http' }]),
    );

  const handleEvent = (s: Session, ackId: string, event: string, args: unknown[]) => {
    received.push({ event, args });
    const ack = (value: unknown) => enqueue(s, `43${ackId}${JSON.stringify([value])}`);
    if (event === 'login') {
      const data = args[0] as { username: string; password: string; token?: string };
      const okUser = data.username === (options.username ?? 'reader') && data.password === (options.password ?? 'kuma-pass');
      if (!okUser) return ack({ ok: false, msg: 'Incorrect username or password.' });
      if (options.totp && !data.token) return ack({ tokenRequired: true });
      if (options.totp && data.token !== options.totp) return ack({ ok: false, msg: 'Invalid Token!' });
      // Uptime Kuma pushes the monitor list from afterLogin(), before the ack.
      enqueue(s, `42${JSON.stringify(['monitorList', monitorList()])}`);
      return ack({ ok: true, token: JWT });
    }
    if (event === 'loginByToken') {
      if (args[0] !== JWT) return ack({ ok: false, msg: 'Invalid token' });
      enqueue(s, `42${JSON.stringify(['monitorList', monitorList()])}`);
      return ack({ ok: true });
    }
    if (event === 'getMonitorBeats') {
      const [monitorId, period] = args as [number, number];
      if (period == null) return ack({ ok: false, msg: 'Invalid period.' });
      if (options.flood) {
        const pad = 'y'.repeat(options.flood.size ?? 16);
        for (let n = 0; n < options.flood.count; n++) enqueue(s, `42${JSON.stringify([options.flood.event, { n, pad }])}`);
      }
      if (options.oversized?.includes(monitorId)) {
        s.oversized = true;
        s.waiter?.();
        s.waiter = null;
        return;
      }
      const data = (options.beats[monitorId] ?? []).map(([time, status], i) => ({
        id: i + 1,
        monitor_id: monitorId,
        status,
        time,
        msg: '',
        important: 0,
        duration: 60,
      }));
      return ack({ ok: true, data });
    }
    return ack({ ok: false, msg: 'unknown event' });
  };

  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init.method ?? 'GET';
    requests.push({ method, url: url.toString() });
    if (!url.pathname.endsWith('/socket.io/') || url.searchParams.get('EIO') !== '4') {
      return new Response('not found', { status: 404 });
    }
    const sidParam = url.searchParams.get('sid');
    if (!sidParam) {
      const sid = `fake-sid-${sessions.size + 1}`;
      sessions.set(sid, { queue: [], waiter: null, pinged: false, oversized: false });
      return new Response(`0${JSON.stringify({ sid, upgrades: ['websocket'], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1e6 })}`);
    }
    const s = sessions.get(sidParam);
    if (!s) return new Response('{"code":1,"message":"Session ID unknown"}', { status: 400 });
    if (method === 'POST') {
      for (const packet of String(init.body ?? '').split(SEP)) {
        if (packet === '40') {
          enqueue(s, `40{"sid":"socket-1"}`);
          // Exercise ping/pong once.
          if (!s.pinged) {
            s.pinged = true;
            enqueue(s, '2');
          }
        } else if (packet.startsWith('42')) {
          const m = /^42(\d*)(.*)$/s.exec(packet)!;
          const [event, ...args] = JSON.parse(m[2]!) as [string, ...unknown[]];
          handleEvent(s, m[1]!, event, args);
        } else if (packet === '1') {
          sessions.delete(sidParam);
        }
      }
      return new Response('ok');
    }
    // GET: long poll.
    if (s.queue.length === 0 && !s.oversized) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 200);
        s.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
        init.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    if (init.signal?.aborted) throw init.signal.reason;
    if (s.oversized) {
      s.oversized = false;
      return new Response(hugeBody(51));
    }
    const packets = s.queue.splice(0, s.queue.length);
    return new Response(packets.length > 0 ? packets.join(SEP) : '6');
  }) as typeof fetch;

  let opened = 0;
  const counting = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (!url.searchParams.get('sid') && (init?.method ?? 'GET') === 'GET') opened++;
    return fn(input, init);
  }) as typeof fetch;

  return { fetch: counting, received, requests, sessions: () => opened };
}

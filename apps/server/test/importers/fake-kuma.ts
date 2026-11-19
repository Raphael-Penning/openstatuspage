/**
 * Fake Uptime Kuma Socket.IO server (Engine.IO v4 long polling) behind a fetch
 * double. Implements the handshake, ping/pong, `login` and `getMonitorBeats`
 * like Uptime Kuma 1.23 / 2.x do.
 */
const SEP = '\x1e';

export interface FakeKumaOptions {
  username?: string;
  password?: string;
  /** Require this 2FA code. */
  totp?: string;
  monitors: { id: number; name: string; interval?: number }[];
  /** Heartbeats per monitor id: [time "YYYY-MM-DD HH:mm:ss.SSS" (UTC), status]. */
  beats: Record<number, [string, number][]>;
}

export interface FakeKuma {
  fetch: typeof fetch;
  /** Events received (name and args), for assertions. */
  received: { event: string; args: unknown[] }[];
  requests: { method: string; url: string }[];
}

export function fakeKuma(options: FakeKumaOptions): FakeKuma {
  const sid = 'fake-sid-1';
  const queue: string[] = [];
  let waiter: (() => void) | null = null;
  let pinged = false;
  const received: FakeKuma['received'] = [];
  const requests: FakeKuma['requests'] = [];
  const enqueue = (packet: string) => {
    queue.push(packet);
    waiter?.();
    waiter = null;
  };

  const handleEvent = (ackId: string, event: string, args: unknown[]) => {
    received.push({ event, args });
    const ack = (value: unknown) => enqueue(`43${ackId}${JSON.stringify([value])}`);
    if (event === 'login') {
      const data = args[0] as { username: string; password: string; token?: string };
      const okUser = data.username === (options.username ?? 'reader') && data.password === (options.password ?? 'kuma-pass');
      if (!okUser) return ack({ ok: false, msg: 'Incorrect username or password.' });
      if (options.totp && !data.token) return ack({ tokenRequired: true });
      if (options.totp && data.token !== options.totp) return ack({ ok: false, msg: 'Invalid Token!' });
      // Uptime Kuma pushes the monitor list from afterLogin(), before the ack.
      const list = Object.fromEntries(
        options.monitors.map((m) => [String(m.id), { id: m.id, name: m.name, interval: m.interval ?? 60, type: 'http' }]),
      );
      enqueue(`42${JSON.stringify(['monitorList', list])}`);
      return ack({ ok: true, token: 'jwt' });
    }
    if (event === 'getMonitorBeats') {
      const [monitorId, period] = args as [number, number];
      if (period == null) return ack({ ok: false, msg: 'Invalid period.' });
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
    if (!url.searchParams.get('sid')) {
      return new Response(`0${JSON.stringify({ sid, upgrades: ['websocket'], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1e6 })}`);
    }
    if (url.searchParams.get('sid') !== sid) return new Response('{"code":1,"message":"Session ID unknown"}', { status: 400 });
    if (method === 'POST') {
      for (const packet of String(init.body ?? '').split(SEP)) {
        if (packet === '40') {
          enqueue(`40{"sid":"socket-1"}`);
          // Exercise ping/pong once.
          if (!pinged) {
            pinged = true;
            enqueue('2');
          }
        } else if (packet.startsWith('42')) {
          const m = /^42(\d*)(.*)$/s.exec(packet)!;
          const [event, ...args] = JSON.parse(m[2]!) as [string, ...unknown[]];
          handleEvent(m[1]!, event, args);
        }
      }
      return new Response('ok');
    }
    // GET: long poll.
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 200);
        waiter = () => {
          clearTimeout(timer);
          resolve();
        };
        init.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    if (init.signal?.aborted) throw init.signal.reason;
    const packets = queue.splice(0, queue.length);
    return new Response(packets.length > 0 ? packets.join(SEP) : '6');
  }) as typeof fetch;

  return { fetch: fn, received, requests };
}

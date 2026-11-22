/**
 * Minimal Socket.IO v4 client over the Engine.IO v4 HTTP long-polling
 * transport, built on the adapter `fetch` (so TLS settings, timeouts and the
 * response size limit of the monitoring adapters apply, and tests can use a
 * fake fetch). Supports what the Uptime Kuma importer needs: connecting to the
 * default namespace, emitting events with acknowledgements and receiving
 * events. No binary packets, no WebSocket upgrade.
 *
 * Engine.IO packets: 0 open, 1 close, 2 ping, 3 pong, 4 message, 6 noop;
 * several packets in one HTTP body are separated by \x1e.
 * Socket.IO packets (inside "4"): 0 connect, 1 disconnect, 2 event,
 * 3 ack, 4 connect_error; an ack id follows the type ("421[...]").
 *
 * Memory: the response size limit applies to one poll only, so the client also
 * bounds what it keeps across polls. Events nobody listens for are dropped
 * unless their name is listed in `expectedEvents`; those are kept for a later
 * waitFor() within a count and size budget, and the session fails with an
 * AdapterError when a peer exceeds it.
 */
import { AdapterError, joinUrl, requestText, type FetchFn } from '../adapters/http.js';

const SEPARATOR = '\x1e';
/** Budget for expected events received before waitFor() asked for them. */
export const SOCKETIO_MAX_BUFFERED_EVENTS = 16;
/** Characters of buffered event payloads (JSON text) kept at most. */
export const SOCKETIO_MAX_BUFFERED_CHARS = 16 * 1024 * 1024;

export interface SocketIoOptions {
  /** Base URL of the server; the client uses `<baseUrl>/socket.io/`. */
  baseUrl: string;
  fetch: FetchFn;
  signal: AbortSignal;
  /** Name of the remote system for error messages. */
  system: string;
  /**
   * Events that may arrive before waitFor() asks for them and are kept until
   * then (within the buffer budget). Other events without a listener are dropped.
   */
  expectedEvents?: readonly string[];
}

type Listener = (...args: unknown[]) => void;

export class SocketIoClient {
  private sid: string | null = null;
  private closed = false;
  private readonly acks = new Map<number, { resolve: (args: unknown[]) => void; reject: (err: Error) => void }>();
  private readonly listeners = new Map<string, Listener[]>();
  private readonly buffered = new Map<string, { payload: unknown[]; chars: number }[]>();
  private bufferedCount = 0;
  private bufferedChars = 0;
  private nextAck = 1;
  private connectWaiter: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private loop: Promise<void> | null = null;
  private failure: Error | null = null;
  private readonly failWaiters = new Set<(err: Error) => void>();
  /** Aborts the pending long-poll request on close. */
  private readonly abort = new AbortController();
  private readonly signal: AbortSignal;

  constructor(private readonly options: SocketIoOptions) {
    this.signal = AbortSignal.any([options.signal, this.abort.signal]);
  }

  private url(): string {
    const base = joinUrl(this.options.baseUrl, 'socket.io/');
    const params = new URLSearchParams({ EIO: '4', transport: 'polling', t: Math.random().toString(36).slice(2) });
    if (this.sid) params.set('sid', this.sid);
    return `${base}?${params.toString()}`;
  }

  private async get(): Promise<string> {
    return requestText(this.options.fetch, this.url(), {
      method: 'GET',
      headers: { Accept: '*/*' },
      signal: this.signal,
      system: this.options.system,
    });
  }

  private async post(body: string): Promise<void> {
    await requestText(this.options.fetch, this.url(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body,
      signal: this.signal,
      system: this.options.system,
    });
  }

  /** Opens the Engine.IO session and connects to the default namespace. */
  async connect(): Promise<void> {
    const open = await this.get();
    const first = open.split(SEPARATOR)[0] ?? '';
    if (!first.startsWith('0')) {
      throw new AdapterError(`${this.options.system}: unexpected Socket.IO handshake. Check the base URL.`);
    }
    let handshake: { sid?: unknown };
    try {
      handshake = JSON.parse(first.slice(1)) as { sid?: unknown };
    } catch {
      throw new AdapterError(`${this.options.system}: invalid Socket.IO handshake. Check the base URL.`);
    }
    if (typeof handshake.sid !== 'string') throw new AdapterError(`${this.options.system}: Socket.IO handshake without session id`);
    this.sid = handshake.sid;
    const connected = new Promise<void>((resolve, reject) => {
      this.connectWaiter = { resolve, reject };
    });
    await this.post('40');
    this.loop = this.pollLoop();
    await connected;
  }

  private async pollLoop(): Promise<void> {
    try {
      while (!this.closed) {
        const body = await this.get();
        for (const packet of body.split(SEPARATOR)) await this.handle(packet);
      }
    } catch (err) {
      if (this.closed) return;
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private clearBuffer(): void {
    this.buffered.clear();
    this.bufferedCount = 0;
    this.bufferedChars = 0;
  }

  private fail(err: Error): void {
    this.failure = err;
    this.closed = true;
    this.clearBuffer();
    this.connectWaiter?.reject(err);
    this.connectWaiter = null;
    for (const ack of this.acks.values()) ack.reject(err);
    this.acks.clear();
    for (const w of this.failWaiters) w(err);
    this.failWaiters.clear();
  }

  private async handle(packet: string): Promise<void> {
    if (packet === '') return;
    switch (packet[0]) {
      case '2':
        await this.post('3');
        return;
      case '1':
        this.fail(new AdapterError(`${this.options.system}: the server closed the connection`));
        return;
      case '4':
        this.handleMessage(packet.slice(1));
        return;
      default:
        return; // 3 pong, 6 noop, unknown
    }
  }

  private handleMessage(msg: string): void {
    const type = msg[0];
    let rest = msg.slice(1);
    // Default namespace only: a namespace prefix ("/admin,") is not expected.
    const idMatch = /^\d+/.exec(rest);
    const id = idMatch ? Number(idMatch[0]) : null;
    if (idMatch) rest = rest.slice(idMatch[0].length);
    switch (type) {
      case '0':
        this.connectWaiter?.resolve();
        this.connectWaiter = null;
        return;
      case '4': {
        let message = 'connection refused';
        try {
          const data = JSON.parse(rest) as { message?: unknown };
          if (typeof data.message === 'string') message = data.message;
        } catch {
          // keep default
        }
        this.fail(new AdapterError(`${this.options.system}: Socket.IO ${message}`));
        return;
      }
      case '1':
        this.fail(new AdapterError(`${this.options.system}: disconnected by the server`));
        return;
      case '2': {
        const args = parseArray(rest);
        if (!args || typeof args[0] !== 'string') return;
        const [event, ...payload] = args as [string, ...unknown[]];
        const listeners = this.listeners.get(event);
        if (listeners && listeners.length > 0) {
          for (const l of listeners) l(...payload);
          return;
        }
        // Nobody asked for it: keep only expected events, within the budget.
        if (!this.options.expectedEvents?.includes(event)) return;
        this.bufferedCount += 1;
        this.bufferedChars += rest.length;
        if (this.bufferedCount > SOCKETIO_MAX_BUFFERED_EVENTS || this.bufferedChars > SOCKETIO_MAX_BUFFERED_CHARS) {
          this.fail(new AdapterError(`${this.options.system}: too many unexpected Socket.IO events`));
          return;
        }
        const list = this.buffered.get(event) ?? [];
        list.push({ payload, chars: rest.length });
        this.buffered.set(event, list);
        return;
      }
      case '3': {
        if (id === null) return;
        const ack = this.acks.get(id);
        if (!ack) return;
        this.acks.delete(id);
        ack.resolve(parseArray(rest) ?? []);
        return;
      }
      default:
        return;
    }
  }

  /** Emits an event and resolves with the arguments of the acknowledgement. */
  async emitWithAck(event: string, ...args: unknown[]): Promise<unknown[]> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new AdapterError(`${this.options.system}: connection closed`);
    const id = this.nextAck++;
    const result = new Promise<unknown[]>((resolve, reject) => this.acks.set(id, { resolve, reject }));
    await this.post(`42${id}${JSON.stringify([event, ...args])}`);
    return result;
  }

  /** Resolves with the arguments of the next `event` (also one received before the call). */
  waitFor(event: string, timeoutMs: number): Promise<unknown[]> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new AdapterError(`${this.options.system}: connection closed`));
    const buffered = this.buffered.get(event)?.shift();
    if (buffered) {
      this.bufferedCount -= 1;
      this.bufferedChars -= buffered.chars;
      return Promise.resolve(buffered.payload);
    }
    return new Promise((resolve, reject) => {
      const onFail = (err: Error) => {
        remove();
        reject(err);
      };
      this.failWaiters.add(onFail);
      const timer = setTimeout(() => {
        remove();
        reject(new AdapterError(`${this.options.system}: no "${event}" event within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      const listener: Listener = (...args) => {
        remove();
        resolve(args);
      };
      const remove = () => {
        clearTimeout(timer);
        this.failWaiters.delete(onFail);
        const list = this.listeners.get(event) ?? [];
        this.listeners.set(
          event,
          list.filter((l) => l !== listener),
        );
      };
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    });
  }

  /** Closes the session (best effort). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearBuffer();
    try {
      if (this.sid) await this.post('1');
    } catch {
      // ignore
    }
    this.abort.abort();
    await this.loop?.catch(() => undefined);
  }
}

function parseArray(text: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

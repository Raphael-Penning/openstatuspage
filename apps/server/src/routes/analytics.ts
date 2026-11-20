/**
 * Umami analytics proxy (docs/configuration.md#analytics), on every instance
 * that serves the public pages, and only when UMAMI_URL is set:
 *
 *   GET  /pulse/p.js        Umami's tracker script (UMAMI_URL/script.js)
 *   POST /pulse/api/send    one tracker event → UMAMI_URL/api/send
 *
 * The browser never talks to the Umami server: the page's CSP stays
 * `script-src 'self'; connect-src 'self'`, and visitors' requests reach Umami
 * only in the shape below.
 *
 * Safety:
 * - The upstream is the instance setting UMAMI_URL; the management UI only
 *   picks the website ID. Redirects are never followed (a 3xx counts as a
 *   failure), so the proxy cannot be steered to another host.
 * - The script is fetched at most once per SCRIPT_TTL_MS and kept in memory
 *   (one copy, at most SCRIPT_MAX_BYTES, plus its gzip copy); an expired copy
 *   keeps answering while a refresh runs or after it failed. Without any copy
 *   the route answers an empty script, so a page never logs an error when
 *   Umami is down.
 * - Events: JSON only, at most SEND_BODY_LIMIT, rate limited per client, at
 *   most MAX_IN_FLIGHT forwarded at a time (MAX_IN_FLIGHT_PER_CLIENT per
 *   client address; more are dropped at once), SEND_TIMEOUT_MS each. Only events
 *   for the configured website ID are forwarded, with the payload fields of
 *   Umami's tracker only. Events of personal pages (subscription links) are
 *   dropped; page and referrer URLs lose their fragment and `token`
 *   parameters (with the `id` next to a token). With "respect Do Not Track" on, requests with `DNT: 1` or
 *   `Sec-GPC: 1` are dropped. Forwarded are the body, the User-Agent and
 *   Umami's own `x-umami-cache` header; never cookies, and the visitor's IP
 *   address (X-Forwarded-For) only when the settings allow it.
 * - Failures answer 204 quickly, without upstream details.
 *
 * Upstream requests use node:http(s), not fetch: fetch would load undici and
 * compile its WebAssembly HTTP parser, several MB that a public instance
 * (docs/architecture.md#memory) does not need to spend.
 */
import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { gzipSync } from 'node:zlib';
import { ANALYTICS_PATHS, analyticsActive, isPersonalPath, type PublicPageSettings } from '@openstatuspage/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSettings } from '../services/settings.js';
import { acceptsGzip } from '../ssr/pages.js';

/** A fresh script copy is reused this long. */
export const SCRIPT_TTL_MS = 60 * 60 * 1000;
/** After a failed script fetch, the next try waits this long. */
export const SCRIPT_RETRY_MS = 60 * 1000;
/** Largest script accepted from Umami (its tracker is about 3 kB). */
export const SCRIPT_MAX_BYTES = 64 * 1024;
export const SCRIPT_TIMEOUT_MS = 5000;
/** Largest event body (Umami's own limit for custom event data is well below). */
export const SEND_BODY_LIMIT = 16 * 1024;
/** Largest answer of Umami to an event that is passed on (a small JSON object). */
const SEND_RESPONSE_MAX_BYTES = 8 * 1024;
export const SEND_TIMEOUT_MS = 3000;
/**
 * Events forwarded at the same time by this instance; more are dropped at once
 * (204), so a slow Umami never holds more than this many sockets and buffers,
 * and never delays the pages.
 */
export const MAX_IN_FLIGHT = 8;
/** Events of one client address forwarded at the same time, so a few clients cannot take every slot. */
export const MAX_IN_FLIGHT_PER_CLIENT = 2;

/** Browsers cache the script for an hour and may use it a day longer while they check it. */
const SCRIPT_CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=86400';
/** Served when no script could be loaded: a no-op, never cached. */
const EMPTY_SCRIPT = '/* analytics unavailable */\n';

const SCRIPT_LIMIT = { rateLimit: { max: 60, timeWindow: '1 minute' } };
const SEND_LIMIT = { rateLimit: { max: 120, timeWindow: '1 minute' } };

/** `x-umami-cache`: Umami's signed session token (a JWT). */
const UMAMI_CACHE = /^[A-Za-z0-9._-]{1,2048}$/;

export interface UmamiProxyOptions {
  /** UMAMI_URL without trailing slash. */
  upstream: string;
  /** The public base URL (resolves the relative page URLs of events). */
  baseUrl: string;
  /** Page settings (tests pass their own). Default: from the database. */
  settings?: () => Promise<PublicPageSettings>;
  /** Replaces the HTTP client (tests). */
  request?: Upstream;
  scriptTimeoutMs?: number;
  sendTimeoutMs?: number;
}

interface ScriptCopy {
  body: Buffer;
  gzip: Buffer;
  etag: string;
  fetchedAt: number;
}

/** A request to Umami. Redirects are never followed. */
export interface UpstreamRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** Longest answer body read; a longer one rejects. */
  maxBytes: number;
}

export interface UpstreamResponse {
  status: number;
  /** Content type of the answer (lower case, without parameters); '' when missing. */
  type: string;
  body: Buffer;
}

export type Upstream = (req: UpstreamRequest) => Promise<UpstreamResponse>;

/** One HTTP request with node:http(s): a timeout for the whole exchange and a cap on the answer. */
export const httpUpstream: Upstream = ({ url, method, headers, body, timeoutMs, maxBytes }) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const outgoing = body === undefined ? headers : { ...headers, 'content-length': String(Buffer.byteLength(body)) };
    const req = send(target, { method, headers: outgoing, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        reject(new Error(`answer larger than ${maxBytes} bytes`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          res.destroy();
          reject(new Error(`answer larger than ${maxBytes} bytes`));
        } else chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: contentType(res.headers), body: Buffer.concat(chunks) }));
      res.on('error', reject);
      // Cut off (timeout, connection lost) before the end: never a partial answer.
      res.on('close', () => {
        if (!res.complete) reject(new Error('answer incomplete'));
      });
    });
    req.on('error', reject);
    req.end(body);
  });

const contentType = (headers: IncomingHttpHeaders) => (headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();

/** The single in-memory copy of Umami's tracker script. */
export class ScriptCache {
  private copy: ScriptCopy | null = null;
  private pending: Promise<ScriptCopy | null> | null = null;
  private retryAt = 0;

  constructor(
    private readonly url: string,
    private readonly upstream: Upstream,
    private readonly timeoutMs: number,
    private readonly log: { warn(obj: object, msg: string): void },
  ) {}

  /** The script: fresh, or an expired copy (refreshing in the background), or null when there is none. */
  async get(now = Date.now()): Promise<ScriptCopy | null> {
    const copy = this.copy;
    if (copy && now - copy.fetchedAt < SCRIPT_TTL_MS) return copy;
    if (now < this.retryAt) return copy;
    this.pending ??= this.refresh(now).finally(() => {
      this.pending = null;
    });
    // An expired copy answers at once; only the very first request waits for Umami.
    return copy ?? this.pending;
  }

  private async refresh(now: number): Promise<ScriptCopy | null> {
    try {
      const res = await this.upstream({
        url: this.url,
        method: 'GET',
        headers: { accept: 'application/javascript, text/javascript', 'user-agent': 'OpenStatusPage' },
        timeoutMs: this.timeoutMs,
        maxBytes: SCRIPT_MAX_BYTES,
      });
      // A redirect (3xx) or an error page is never taken for the script.
      if (res.status !== 200 || !/javascript|ecmascript/.test(res.type)) {
        throw new Error(`unexpected answer ${res.status} (${res.type || 'no content type'})`);
      }
      const { body } = res;
      const copy: ScriptCopy = {
        body,
        gzip: gzipSync(body, { level: 9 }),
        etag: `"${createHash('sha1').update(body).digest('base64url')}"`,
        fetchedAt: now,
      };
      this.copy = copy;
      return copy;
    } catch (err) {
      this.retryAt = now + SCRIPT_RETRY_MS;
      // Never the upstream answer itself: only what went wrong.
      this.log.warn({ reason: err instanceof Error ? err.message : String(err) }, 'Cannot load the Umami tracker script');
      return this.copy;
    }
  }
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Removes the personal parts of a URL object: the fragment (the tracker sends
 * none, `data-exclude-hash`, but a hand-made event can), every `token` query
 * parameter (any case) and, next to a token, the `id` it belongs to
 * (subscription links carry `id` and `token`).
 */
function dropPersonal(url: URL): void {
  url.hash = '';
  const names = [...url.searchParams.keys()];
  if (!names.some((name) => name.toLowerCase() === 'token')) return;
  for (const name of names) if (['token', 'id'].includes(name.toLowerCase())) url.searchParams.delete(name);
}

/** The cleaned URL in the form it came in: absolute stays absolute, a path stays a path. */
const sameForm = (value: string, url: URL) => (/^[a-z][a-z0-9+.-]*:/i.test(value) ? url.href : `${url.pathname}${url.search}`);

/**
 * A page URL of an event without personal parts: null for a personal page
 * (subscription link), otherwise the URL without fragment and token (see
 * {@link dropPersonal}).
 */
export function cleanPageUrl(value: string, baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return null;
  }
  if (isPersonalPath(url.pathname)) return null;
  dropPersonal(url);
  return sameForm(value, url);
}

/** A referrer of an event: this site's personal pages become the site root, other URLs lose fragment and token. */
export function cleanReferrer(value: string, baseUrl: string): string {
  if (!value) return value;
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return '';
  }
  if (url.origin === new URL(baseUrl).origin && isPersonalPath(url.pathname)) return `${url.origin}/`;
  dropPersonal(url);
  return sameForm(value, url);
}

type EventBody = { type: string; payload: Record<string, unknown> };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Payload fields of Umami's tracker that are forwarded; anything else in an
 * event (hand-made or from another tracker version) is left out.
 */
const PAYLOAD_KEYS = ['website', 'hostname', 'url', 'referrer', 'title', 'language', 'screen', 'name', 'data', 'tag'] as const;

/** Checks and cleans an event; null: drop it. */
export function cleanEvent(body: unknown, websiteId: string, baseUrl: string): EventBody | null {
  if (!isRecord(body) || (body.type !== 'event' && body.type !== 'identify') || !isRecord(body.payload)) return null;
  const source = body.payload;
  const payload: Record<string, unknown> = {};
  for (const key of PAYLOAD_KEYS) if (source[key] !== undefined) payload[key] = source[key];
  if (payload.data !== undefined) {
    if (!isRecord(payload.data)) return null;
    // The pages define no custom event data; never a token, whoever sends one.
    payload.data = Object.fromEntries(Object.entries(payload.data).filter(([key]) => key.toLowerCase() !== 'token'));
  }
  if (typeof payload.website !== 'string' || payload.website.toLowerCase() !== websiteId.toLowerCase()) return null;
  if (payload.url !== undefined) {
    if (typeof payload.url !== 'string') return null;
    const url = cleanPageUrl(payload.url, baseUrl);
    if (url === null) return null;
    payload.url = url;
  }
  if (payload.referrer !== undefined) {
    if (typeof payload.referrer !== 'string') return null;
    payload.referrer = cleanReferrer(payload.referrer, baseUrl);
  }
  return { type: body.type, payload };
}

const dropped = (reply: FastifyReply) => reply.status(204).header('Cache-Control', 'no-store').send();

export async function registerAnalyticsRoutes(app: FastifyInstance, options: UmamiProxyOptions): Promise<void> {
  const upstream = options.request ?? httpUpstream;
  const settings = options.settings ?? (() => getSettings(app.ctx.db));
  const script = new ScriptCache(`${options.upstream}/script.js`, upstream, options.scriptTimeoutMs ?? SCRIPT_TIMEOUT_MS, app.log);
  const sendUrl = `${options.upstream}/api/send`;
  const sendTimeout = options.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  let inFlight = 0;
  // Holds at most MAX_IN_FLIGHT addresses: an entry lives only while its events are forwarded.
  const perClient = new Map<string, number>();

  await app.register(async (scope) => {
    scope.get(ANALYTICS_PATHS.script, { config: SCRIPT_LIMIT }, async (req, reply) => {
      if (!analyticsActive(await settings())) return reply.callNotFound();
      const copy = await script.get();
      reply.type('application/javascript; charset=utf-8').header('Vary', 'Accept-Encoding');
      if (!copy) return reply.header('Cache-Control', 'no-store').send(EMPTY_SCRIPT);
      reply.header('Cache-Control', SCRIPT_CACHE_CONTROL).header('ETag', copy.etag);
      if (header(req, 'if-none-match') === copy.etag) return reply.status(304).send();
      if (acceptsGzip(req.headers['accept-encoding'])) return reply.header('Content-Encoding', 'gzip').send(copy.gzip);
      return reply.send(copy.body);
    });

    scope.post(ANALYTICS_PATHS.send, { config: SEND_LIMIT, bodyLimit: SEND_BODY_LIMIT }, async (req, reply) => {
      const type = (header(req, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (type !== 'application/json') return reply.status(415).header('Cache-Control', 'no-store').send();
      const page = await settings();
      if (!analyticsActive(page)) return dropped(reply);
      if (page.analyticsRespectDnt && (header(req, 'dnt') === '1' || header(req, 'sec-gpc') === '1')) return dropped(reply);
      const event = cleanEvent(req.body, page.analyticsWebsiteId!, options.baseUrl);
      const client = req.ip;
      const ofClient = perClient.get(client) ?? 0;
      if (!event || inFlight >= MAX_IN_FLIGHT || ofClient >= MAX_IN_FLIGHT_PER_CLIENT) return dropped(reply);

      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
      const ua = header(req, 'user-agent');
      // Umami counts visitors by user agent (and IP address) and filters bots by it.
      if (ua) headers['user-agent'] = ua.slice(0, 512);
      const cache = header(req, 'x-umami-cache');
      if (cache && UMAMI_CACHE.test(cache)) headers['x-umami-cache'] = cache;
      if (page.analyticsForwardIp) headers['x-forwarded-for'] = req.ip;

      inFlight++;
      perClient.set(client, ofClient + 1);
      try {
        const res = await upstream({
          url: sendUrl,
          method: 'POST',
          headers,
          body: JSON.stringify(event),
          timeoutMs: sendTimeout,
          maxBytes: SEND_RESPONSE_MAX_BYTES,
        });
        if (res.status !== 200) return dropped(reply);
        if (res.type === 'application/json') {
          return reply.status(200).header('Cache-Control', 'no-store').type('application/json').send(res.body);
        }
        // Older Umami 2.x answer the session token as plain text: passed on only
        // when it has the shape of a token, so no other text reaches the page.
        const token = res.type === 'text/plain' ? res.body.toString('utf8').trim() : '';
        if (!UMAMI_CACHE.test(token)) return dropped(reply);
        return reply.status(200).header('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send(token);
      } catch {
        return dropped(reply);
      } finally {
        inFlight--;
        const left = (perClient.get(client) ?? 1) - 1;
        if (left > 0) perClient.set(client, left);
        else perClient.delete(client);
      }
    });
  });
}

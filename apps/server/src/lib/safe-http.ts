/**
 * Outbound HTTP requests to URLs that admins or visitors entered (webhooks, the
 * SMS provider), guarded against server-side request forgery:
 *
 * - https only (http only where the caller allows it: admin webhooks with the option).
 * - The host is resolved once; every address it resolves to must be public
 *   (no private, loopback, link-local, CGNAT, multicast, documentation, cloud
 *   metadata, IPv6 ULA, NAT64 or IPv4-mapped/translated ranges), otherwise the
 *   request is refused. IP literals are refused the same way (the WHATWG URL
 *   parser already turns decimal, octal and hex IPv4 forms into dotted ones).
 * - The connection goes to the address that was checked (a custom `lookup`), so
 *   a second DNS answer cannot point it elsewhere (DNS rebinding). TLS still
 *   checks the certificate against the host name (SNI).
 * - Redirects are never followed (a 3xx is a failed delivery).
 * - Strict timeouts, a response size limit, no connection reuse, no proxy.
 *
 * Errors never contain the URL's path or query (they often hold the webhook
 * secret): only the host.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

export const DEFAULT_TIMEOUT_MS = 10_000;
/** Responses are only read for the status and a short detail. */
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024;
/** Longest request body. */
export const MAX_REQUEST_BYTES = 64 * 1024;

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** Reason of a refused request; the message is safe to store and log. */
export class OutboundRequestError extends Error {
  constructor(
    message: string,
    readonly code: 'scheme' | 'address' | 'dns' | 'timeout' | 'network' | 'too_large',
  ) {
    super(message);
    this.name = 'OutboundRequestError';
  }
}

// Separate lists: BlockList matches IPv4 addresses against IPv4-mapped IPv6 rules too.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT (also Alibaba's metadata address)
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  BLOCKED_V4.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::', 96], // IPv4-compatible (deprecated)
  ['::ffff:0:0', 96], // IPv4-mapped: refused whatever the IPv4 address
  ['::ffff:0:0:0', 96], // IPv4-translated
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 address)
  ['fc00::', 7], // unique local (also AWS metadata fd00:ec2::254)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED_V6.addSubnet(net, prefix, 'ipv6');
}

/** Whether an IP address must not be connected to. Anything that is no IP address is blocked too. */
export function isBlockedAddress(address: string): boolean {
  const ip = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const family = isIP(ip);
  if (family === 4) return BLOCKED_V4.check(ip, 'ipv4');
  if (family === 6) {
    // Zone ids ("fe80::1%eth0") are only valid for link-local addresses, which are blocked.
    if (ip.includes('%')) return true;
    return BLOCKED_V6.check(ip, 'ipv6');
  }
  return true;
}

const systemResolver: Resolver = async (hostname) => {
  const all = await dnsLookup(hostname, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

export interface SafeRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface SafeRequestOptions {
  /** Allow http:// (admin webhooks with the explicit option). */
  allowHttp?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** DNS resolution (tests). */
  resolve?: Resolver;
  /**
   * Replaces the address check (tests only: a local server). Production code never
   * passes it.
   */
  allowAddress?: (address: string) => boolean;
}

export interface SafeResponse {
  status: number;
  /** The first maxResponseBytes of the body, as text. */
  body: string;
  /** The address that was connected to. */
  address: string;
}

/**
 * Resolves a host once and returns the address to connect to: the first one,
 * after checking that none of them is blocked (a host with one internal address
 * among public ones is refused as a whole).
 */
export async function resolvePublic(
  hostname: string,
  options: Pick<SafeRequestOptions, 'resolve' | 'allowAddress'> = {},
): Promise<ResolvedAddress> {
  const allowed = options.allowAddress ?? ((a: string) => !isBlockedAddress(a));
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  const literal = isIP(host);
  if (literal) {
    if (!allowed(host)) throw new OutboundRequestError(`${hostname} is not a public address`, 'address');
    return { address: host, family: literal === 6 ? 6 : 4 };
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await (options.resolve ?? systemResolver)(host);
  } catch {
    throw new OutboundRequestError(`${hostname} could not be resolved`, 'dns');
  }
  if (addresses.length === 0) throw new OutboundRequestError(`${hostname} could not be resolved`, 'dns');
  for (const a of addresses) {
    if (!allowed(a.address)) throw new OutboundRequestError(`${hostname} resolves to an address that is not public`, 'address');
  }
  return addresses[0]!;
}

/** A `lookup` for http.request that answers with the checked address only (no second DNS query). */
export function pinnedLookup(pinned: ResolvedAddress): LookupFunction {
  return ((_hostname: string, options: { all?: boolean } | number | undefined, callback: (...args: unknown[]) => void) => {
    const cb = typeof options === 'function' ? (options as typeof callback) : callback;
    const all = typeof options === 'object' && options !== null && options.all === true;
    if (all) cb(null, [{ address: pinned.address, family: pinned.family }]);
    else cb(null, pinned.address, pinned.family);
  }) as LookupFunction;
}

/**
 * Sends one request under the SSRF rules above. Resolves with the status and the
 * start of the body for any HTTP answer (also 3xx, 4xx, 5xx); rejects with an
 * OutboundRequestError when the request is refused or fails.
 */
export async function safeRequest(rawUrl: string, init: SafeRequestInit = {}, options: SafeRequestOptions = {}): Promise<SafeResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundRequestError('invalid URL', 'scheme');
  }
  const host = url.hostname;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && options.allowHttp)) {
    throw new OutboundRequestError(`${url.protocol} URLs are not allowed`, 'scheme');
  }
  if (url.username || url.password) throw new OutboundRequestError('URLs with credentials are not allowed', 'scheme');
  const body = init.body ?? undefined;
  if (body !== undefined && Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
    throw new OutboundRequestError('request body too large', 'too_large');
  }
  const pinned = await resolvePublic(host, options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const transport = url.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = { 'user-agent': 'OpenStatusPage', ...(init.headers ?? {}) };
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));

  return new Promise<SafeResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = transport.request(url, {
      method: init.method ?? 'POST',
      headers,
      lookup: pinnedLookup(pinned),
      // One connection per request: never reuse a socket of another (pinned) address.
      agent: false,
      // No Happy Eyeballs: the lookup answers with one address anyway.
      autoSelectFamily: false,
      timeout: timeoutMs,
    });
    // Overall deadline (connect, TLS, sending and reading), not only idle time.
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new OutboundRequestError(`${host} did not answer within ${Math.round(timeoutMs / 1000)} s`, 'timeout')));
    }, timeoutMs);
    req.on('timeout', () => {
      req.destroy();
      finish(() => reject(new OutboundRequestError(`${host} did not answer within ${Math.round(timeoutMs / 1000)} s`, 'timeout')));
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      // The code only (ECONNREFUSED, CERT_HAS_EXPIRED, ...): messages may quote the URL.
      finish(() => reject(new OutboundRequestError(`request to ${host} failed (${err.code ?? 'error'})`, 'network')));
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        if (size >= maxBytes) return;
        const room = maxBytes - size;
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        size += Math.min(chunk.length, room);
        // Enough for the detail: stop reading (and downloading) the rest.
        if (size >= maxBytes) {
          res.destroy();
          finish(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), address: pinned.address }));
        }
      });
      res.on('end', () =>
        finish(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), address: pinned.address })),
      );
      res.on('error', () => finish(() => reject(new OutboundRequestError(`reading the answer of ${host} failed`, 'network'))));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A short, secret-free description of an HTTP answer for delivery logs. */
export function describeAnswer(res: Pick<SafeResponse, 'status' | 'body'>): string {
  if (res.status >= 300 && res.status < 400) return `HTTP ${res.status} (redirects are not followed)`;
  const detail = res.body
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 200);
  return detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`;
}

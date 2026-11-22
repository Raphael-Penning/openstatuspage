/**
 * HTTP helpers for pull adapters.
 *
 * - `createAdapterFetch()` returns a `fetch` that applies a per-request timeout
 *   and, when `verifyTls` is false, accepts self-signed certificates.
 * - `requestJson()` / `requestText()` turn transport and HTTP failures into
 *   `AdapterError`s with messages that are useful to an administrator but
 *   never contain credentials (no userinfo, no query string, no auth headers).
 *
 * - Response bodies are read with a byte limit on both fetch paths, so a
 *   misconfigured or hostile endpoint cannot exhaust memory (fetch also
 *   decompresses gzip/brotli transparently, so the limit applies after that).
 *   Pull adapters also bound the number of values a body may hold before it is
 *   parsed (`ResponseLimits`): parsing materializes one heap object per value,
 *   which costs many times the byte count for small values.
 *
 * Without TLS verification, requests go through `node:http(s)` because the
 * built-in fetch offers no per-request switch for certificate checks without
 * an extra dependency. That code path does not follow redirects; a redirect is
 * reported as an error so a misconfigured base URL is easy to spot.
 */
import http from 'node:http';
import https from 'node:https';

export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/**
 * Upper bound for a single response body when the caller sets no `limits`
 * (history imports, which document raising the heap for large imports).
 */
export const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

/** Bounds for reading and parsing one response body. */
export interface ResponseLimits {
  /** Most bytes of the (decompressed) body. */
  maxBytes: number;
  /**
   * Most values the body may hold, checked before parsing: for JSON the number
   * of `{`, `[` and `,` (an over-count, as these also occur inside strings), for
   * text two per line plus one per `=` (see countTextValues).
   */
  maxValues?: number;
}

/**
 * Defaults of the pull adapters (POLL_MAX_RESPONSE_MB, POLL_MAX_VALUES), sized
 * against the image's 96 MB old-space heap (docker/Dockerfile NODE_OPTIONS):
 * the body string plus its parsed values stay well below it next to the rest
 * of the server.
 */
export const DEFAULT_POLL_LIMITS: Readonly<Required<ResponseLimits>> = {
  maxBytes: 8 * 1024 * 1024,
  maxValues: 500_000,
};
/** Error bodies are only read for a short detail message. */
export const MAX_ERROR_BODY_BYTES = 16 * 1024;

/** Error raised by adapters. The message is safe to store and show to administrators. */
export class AdapterError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

export interface AdapterFetchOptions {
  verifyTls: boolean;
  timeoutMs?: number;
  /** Byte limit of the transport without TLS verification (default MAX_RESPONSE_BYTES). */
  maxResponseBytes?: number;
}

export type FetchFn = typeof fetch;

/** Creates the `fetch` used by a pull adapter for one source. */
export function createAdapterFetch(options: AdapterFetchOptions): FetchFn {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const base: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = options.verifyTls
    ? (input, init) => globalThis.fetch(input, init)
    : (input, init) => insecureFetch(input, init, maxBytes);
  const wrapped = (input: string | URL | Request, init: RequestInit = {}) => {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (init.signal) signals.push(init.signal);
    return base(input, { ...init, signal: AbortSignal.any(signals) });
  };
  return wrapped as FetchFn;
}

/**
 * Minimal fetch replacement on top of node:http(s) that skips certificate
 * verification. Supports string bodies, headers and abort signals.
 */
export function insecureFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<Response> {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.reject(new TypeError(`Unsupported protocol ${url.protocol}`));
  }
  const headers = new Headers(init.headers);
  const body = init.body;
  if (body != null && typeof body !== 'string') {
    return Promise.reject(new TypeError('insecureFetch only supports string bodies'));
  }
  if (body != null) headers.set('content-length', String(Buffer.byteLength(body)));
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise<Response>((resolve, reject) => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const req = transport.request(url, {
      method: init.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
      rejectUnauthorized: false,
    });
    const onAbort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    req.on('error', (err) => {
      cleanup();
      reject(err);
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let failure: Error | null = null;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          failure = new Error('Response body too large');
          req.destroy(failure);
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', (err) => {
        cleanup();
        reject(failure ?? err);
      });
      // Safety net: aborted mid-body without an 'error' event (no-op once resolved).
      res.on('close', () => {
        if (res.complete) return;
        cleanup();
        reject(failure ?? (signal?.aborted ? signal.reason : new Error('Connection closed before the response was complete')));
      });
      res.on('end', () => {
        cleanup();
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(key, v);
        }
        const status = res.statusCode ?? 0;
        const nullBody = status === 204 || status === 205 || status === 304;
        try {
          resolve(
            new Response(nullBody ? null : Buffer.concat(chunks), {
              status,
              statusText: res.statusMessage ?? '',
              headers: responseHeaders,
            }),
          );
        } catch (err) {
          reject(err);
        }
      });
    });
    req.end(body ?? undefined);
  });
}

/** URL without userinfo, query string and fragment, for messages and logs. */
export function describeUrl(url: string | URL): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(invalid URL)';
  }
}

/** Joins a base URL (with or without trailing slash / path) and a path. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Basic auth header value. */
export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export interface RequestOptions extends RequestInit {
  /** Human readable name of the remote system, e.g. "Icinga 2 API". */
  system: string;
  /** Bounds of the response body; without them only MAX_RESPONSE_BYTES applies. */
  limits?: ResponseLimits;
}

/** Performs a request and returns the response; non-2xx and transport errors become AdapterErrors. */
export async function request(fetchFn: FetchFn, url: string, options: RequestOptions): Promise<Response> {
  const { system, limits: _limits, ...init } = options;
  const where = describeUrl(url);
  let res: Response;
  try {
    res = await fetchFn(url, { redirect: 'manual', ...init });
  } catch (err) {
    throw new AdapterError(`${system}: request to ${where} failed: ${describeTransportError(err)}`);
  }
  if (res.status >= 300 && res.status < 400) {
    await discard(res);
    const location = res.headers.get('location');
    throw new AdapterError(
      `${system} redirected (HTTP ${res.status}) from ${where}${location ? ` to ${describeUrl(new URL(location, url))}` : ''}. ` +
        'Check the base URL (scheme, port and path) and the credentials.',
      res.status,
    );
  }
  if (!res.ok) {
    const detail = await errorDetail(res);
    throw new AdapterError(
      `${system} returned HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} for ${where}${detail ? `: ${detail}` : ''}${statusHint(res.status)}`,
      res.status,
    );
  }
  return res;
}

export async function requestJson<T = unknown>(fetchFn: FetchFn, url: string, options: RequestOptions): Promise<T> {
  const res = await request(fetchFn, url, options);
  const text = await readText(res, options.system, url, options.limits);
  const maxValues = options.limits?.maxValues;
  if (maxValues !== undefined && countJsonValues(text, maxValues) > maxValues) {
    throw new AdapterError(
      `${options.system}: the response of ${describeUrl(url)} has more than ${maxValues} JSON values. ` +
        'Narrow the query (filters, permissions of the API user) or raise POLL_MAX_VALUES.',
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const type = res.headers.get('content-type') ?? 'unknown content type';
    throw new AdapterError(
      `${options.system} did not return JSON for ${describeUrl(url)} (${type}). Check the base URL.`,
    );
  }
}

export async function requestText(fetchFn: FetchFn, url: string, options: RequestOptions): Promise<string> {
  const res = await request(fetchFn, url, options);
  const text = await readText(res, options.system, url, options.limits);
  const maxValues = options.limits?.maxValues;
  if (maxValues !== undefined && countTextValues(text, maxValues) > maxValues) {
    throw new AdapterError(
      `${options.system}: the response of ${describeUrl(url)} has too many lines or labels (more than ${maxValues} values). ` +
        'Check the base URL or raise POLL_MAX_VALUES.',
    );
  }
  return text;
}

/**
 * Upper estimate of the values JSON.parse would create: every object and array
 * opens with `{` / `[`, and every further element or property follows a `,`.
 * Stops counting once `stopAfter` is exceeded.
 */
export function countJsonValues(text: string, stopAfter = Infinity): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // { [ ,
    if ((c === 123 || c === 91 || c === 44) && ++count > stopAfter) break;
  }
  return count;
}

/**
 * Upper estimate of the values parsing a line-based text (the Prometheus format)
 * creates: two per line (the sample and its label set) and one per `=` (a label).
 * Stops counting once `stopAfter` is exceeded.
 */
export function countTextValues(text: string, stopAfter = Infinity): number {
  let count = 2;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // \n counts the next line, = a label
    if (c === 10) count += 2;
    else if (c === 61) count++;
    else continue;
    if (count > stopAfter) break;
  }
  return count;
}

async function readText(res: Response, system: string, url: string, limits?: ResponseLimits): Promise<string> {
  const maxBytes = limits?.maxBytes ?? MAX_RESPONSE_BYTES;
  try {
    return await readBodyLimited(res, maxBytes);
  } catch (err) {
    if (err instanceof ResponseTooLargeError) {
      throw new AdapterError(
        `${system}: the response of ${describeUrl(url)} exceeds ${formatMiB(maxBytes)} MiB. ` +
          `Check the base URL${limits ? ' or raise POLL_MAX_RESPONSE_MB' : ''}.`,
      );
    }
    throw new AdapterError(`${system}: reading the response of ${describeUrl(url)} failed: ${describeTransportError(err)}`);
  }
}

function formatMiB(bytes: number): string {
  return String(Math.round((bytes / 1024 / 1024) * 100) / 100);
}

class ResponseTooLargeError extends Error {
  constructor() {
    super('Response body too large');
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * Reads a body as UTF-8 text (like `res.text()`) but stops and cancels the
 * stream as soon as more than `limit` bytes arrived. A larger Content-Length
 * is rejected before reading anything.
 */
export async function readBodyLimited(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) {
    await discard(res);
    throw new ResponseTooLargeError();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // ignore
  }
}

/** Short error detail from common JSON error bodies; never echoes arbitrary content. */
async function errorDetail(res: Response): Promise<string | null> {
  let text: string;
  try {
    text = await readBodyLimited(res, MAX_ERROR_BODY_BYTES);
  } catch {
    // Too large or broken: the status line alone has to do.
    return null;
  }
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    for (const key of ['status', 'message', 'error', 'msg']) {
      const value = body?.[key];
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
    }
  } catch {
    // not JSON
  }
  return null;
}

function statusHint(status: number): string {
  if (status === 401) return ' – check the credentials.';
  if (status === 403) return ' – the API user lacks the required permissions.';
  if (status === 404) return ' – check the base URL.';
  return '';
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
]);

/** Converts fetch / socket errors into a short explanation. */
export function describeTransportError(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: string; cause?: unknown };
  if (e?.name === 'TimeoutError') return 'timed out';
  if (e?.name === 'AbortError') return 'aborted';
  const cause = (e?.cause ?? e) as { code?: string; message?: string; name?: string };
  if (cause?.name === 'TimeoutError') return 'timed out';
  const code = cause?.code ?? e?.code;
  if (code && TLS_CODES.has(code)) {
    return `TLS certificate verification failed (${code}). Use a trusted certificate or disable TLS verification for this source.`;
  }
  switch (code) {
    case 'ECONNREFUSED':
      return 'connection refused (ECONNREFUSED)';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `host name could not be resolved (${code})`;
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return `connection timed out (${code})`;
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
      return `connection closed unexpectedly (${code})`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `host unreachable (${code})`;
  }
  const message = stripUrlCredentials(cause?.message ?? e?.message ?? String(err));
  return code ? `${message} (${code})` : message;
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/**
 * Replaces every URL in a message by its form without userinfo, query string and
 * fragment (undici, for one, quotes the full URL including the password).
 */
export function stripUrlCredentials(message: string): string {
  return message.replace(URL_IN_TEXT, (url) => describeUrl(url));
}

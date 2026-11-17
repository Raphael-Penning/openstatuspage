/**
 * HTTP helpers for pull adapters.
 *
 * - `createAdapterFetch()` returns a `fetch` that applies a per-request timeout
 *   and, when `verifyTls` is false, accepts self-signed certificates.
 * - `requestJson()` / `requestText()` turn transport and HTTP failures into
 *   `AdapterError`s with messages that are useful to an administrator but
 *   never contain credentials (no userinfo, no query string, no auth headers).
 *
 * Without TLS verification, requests go through `node:http(s)` because the
 * built-in fetch offers no per-request switch for certificate checks without
 * an extra dependency. That code path does not follow redirects; a redirect is
 * reported as an error so a misconfigured base URL is easy to spot.
 */
import http from 'node:http';
import https from 'node:https';

export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** Upper bound for a single response body (protects memory on misconfigured URLs). */
export const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

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
}

export type FetchFn = typeof fetch;

/** Creates the `fetch` used by a pull adapter for one source. */
export function createAdapterFetch(options: AdapterFetchOptions): FetchFn {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const base: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = options.verifyTls
    ? (input, init) => globalThis.fetch(input, init)
    : insecureFetch;
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
export function insecureFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
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
        if (size > MAX_RESPONSE_BYTES) {
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
}

/** Performs a request and returns the response; non-2xx and transport errors become AdapterErrors. */
export async function request(fetchFn: FetchFn, url: string, options: RequestOptions): Promise<Response> {
  const { system, ...init } = options;
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
  const text = await readText(res, options.system, url);
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
  return readText(res, options.system, url);
}

async function readText(res: Response, system: string, url: string): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    throw new AdapterError(`${system}: reading the response of ${describeUrl(url)} failed: ${describeTransportError(err)}`);
  }
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
    text = await res.text();
  } catch {
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
  const message = cause?.message ?? e?.message ?? String(err);
  return code ? `${message} (${code})` : message;
}

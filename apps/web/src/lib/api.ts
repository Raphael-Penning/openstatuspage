/**
 * Thin fetch wrapper for the JSON API. Same-origin; cookies carry the admin session.
 */
import type { ApiError as ApiErrorBody } from '@openstatuspage/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody | null,
  ) {
    super(body?.message ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  /** Extra request headers (e.g. the subscription manage token). */
  headers?: Record<string, string>;
}

function buildUrl(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function request<T>(method: string, path: string, body?: unknown, query?: Query, options?: RequestOptions): Promise<T> {
  const res = await fetch(buildUrl(path, query), {
    method,
    credentials: 'same-origin',
    headers: {
      ...options?.headers,
      // Required by the server for cookie-authenticated mutations (CSRF protection).
      'x-requested-with': 'openstatuspage',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new ApiError(res.status, data as ApiErrorBody | null);
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query, options?: RequestOptions) => request<T>('GET', path, undefined, query, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST', path, body ?? {}, undefined, options),
  put: <T>(path: string, body: unknown, options?: RequestOptions) => request<T>('PUT', path, body, undefined, options),
  patch: <T>(path: string, body: unknown, options?: RequestOptions) => request<T>('PATCH', path, body, undefined, options),
  delete: <T = void>(path: string, options?: RequestOptions) => request<T>('DELETE', path, undefined, undefined, options),
};

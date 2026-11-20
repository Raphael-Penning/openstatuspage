/**
 * Thin fetch wrapper for the JSON:API (https://jsonapi.org/format/1.1/).
 * Same-origin; cookies carry the admin session.
 *
 * - Request bodies (plain objects) are sent as `{ data: { type, attributes, relationships } }`
 *   with `Content-Type: application/vnd.api+json`. The type defaults to the last
 *   non-id path segment; pass `type` (and `relationships`) where the route needs them.
 * - JSON:API responses are deserialized to plain objects (attributes + relationship
 *   ids + resolved included resources), so hooks and components keep using the
 *   plain types from @openstatuspage/shared.
 * - JSON:API error documents become an ApiError whose body keeps the former shape
 *   `{ error, message, issues }` (issues carry field paths for the forms).
 */
import {
  deserializeDocument,
  deserializePage,
  errorIssues,
  inferResourceType,
  isDataDocument,
  isErrorDocument,
  JSONAPI_MEDIA_TYPE,
  toQueryParams,
  toRequestDocument,
  type ApiError as ApiErrorBody,
  type DataDocument,
  type DeserializedDocument,
  type ErrorObject,
  type ListParams,
  type Paginated,
} from '@openstatuspage/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody | null,
    /** JSON:API error objects of the response (empty for other error bodies). */
    public readonly errors: ErrorObject[] = [],
  ) {
    super(body?.message ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  /** Extra request headers (e.g. the subscription manage token). */
  headers?: Record<string, string>;
  /** JSON:API type of the request body (default: inferred from the path). */
  type?: string;
  /** `id` of the resource in the request body (PATCH). */
  id?: string;
  /** Plain fields sent as relationships, mapped to the related type: `{ serviceIds: 'services' }`. */
  relationships?: Record<string, string>;
  /** fetch cache mode (e.g. 'no-cache' to revalidate a cacheable public response). */
  cache?: RequestCache;
}

function buildUrl(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  // Brackets of page[number] / filter[x] stay readable (valid in a query component).
  const qs = params.toString().replace(/%5B/g, '[').replace(/%5D/g, ']');
  return qs ? `${path}?${qs}` : path;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Maps an error response body to the ApiError body the UI uses. */
export function toApiErrorBody(status: number, data: unknown): { body: ApiErrorBody | null; errors: ErrorObject[] } {
  if (isErrorDocument(data)) {
    const errors = data.errors;
    const first = errors[0];
    const issues = errorIssues(errors);
    return {
      body: {
        error: first?.code ?? `http_${status}`,
        message: first?.detail ?? first?.title ?? `Request failed with status ${status}`,
        ...(issues.length > 0 ? { issues } : {}),
      },
      errors,
    };
  }
  return { body: isPlainObject(data) ? (data as unknown as ApiErrorBody) : null, errors: [] };
}

interface RawResponse {
  status: number;
  data: unknown;
}

async function send(method: string, path: string, body?: unknown, query?: Query, options?: RequestOptions): Promise<RawResponse> {
  const payload = isPlainObject(body)
    ? toRequestDocument(options?.type ?? inferResourceType(path), body, { id: options?.id, relationships: options?.relationships })
    : body;
  const res = await fetch(buildUrl(path, query), {
    method,
    credentials: 'same-origin',
    ...(options?.cache ? { cache: options.cache } : {}),
    headers: {
      accept: JSONAPI_MEDIA_TYPE,
      ...options?.headers,
      // Required by the server for cookie-authenticated mutations (CSRF protection).
      'x-requested-with': 'openstatuspage',
      ...(payload !== undefined ? { 'content-type': isPlainObject(body) ? JSONAPI_MEDIA_TYPE : 'application/json' } : {}),
    },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  if (res.status === 204) return { status: 204, data: undefined };
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const { body: errorBody, errors } = toApiErrorBody(res.status, data);
    throw new ApiError(res.status, errorBody, errors);
  }
  return { status: res.status, data };
}

/**
 * Result of a request: the deserialized primary data of a JSON:API data document,
 * the `meta` of a meta-only document, or the body as-is (non JSON:API responses).
 */
function result<T>(data: unknown): T {
  if (isJsonApi(data) && isDataDocument(data)) return deserializeDocument<T>(data).data;
  if (isJsonApi(data) && isPlainObject(data.meta)) return data.meta as T;
  return data as T;
}

/** The server marks every JSON:API document with the top-level `jsonapi` member. */
const isJsonApi = (data: unknown): data is Record<string, unknown> => isPlainObject(data) && isPlainObject(data.jsonapi);

async function request<T>(method: string, path: string, body?: unknown, query?: Query, options?: RequestOptions): Promise<T> {
  return result<T>((await send(method, path, body, query, options)).data);
}

function asDataDocument(path: string, data: unknown): DataDocument {
  if (!isJsonApi(data) || !isDataDocument(data)) throw new Error(`${path} did not return a JSON:API document`);
  return data;
}

export const api = {
  get: <T>(path: string, query?: Query, options?: RequestOptions) => request<T>('GET', path, undefined, query, options),
  /** GET with the whole deserialized document (data, meta, links, included). */
  getDocument: async <T>(path: string, query?: Query, options?: RequestOptions): Promise<DeserializedDocument<T>> =>
    deserializeDocument<T>(asDataDocument(path, (await send('GET', path, undefined, query, options)).data)),
  /** GET of the raw JSON:API data document (deserialized by the caller). */
  document: async (path: string, query?: Query, options?: RequestOptions): Promise<DataDocument> =>
    asDataDocument(path, (await send('GET', path, undefined, query, options)).data),
  /** GET of a paginated collection: `{ items, total, page, pageSize }`. */
  getPage: async <T>(path: string, params: ListParams = {}, options?: RequestOptions): Promise<Paginated<T>> =>
    deserializePage<T>(asDataDocument(path, (await send('GET', path, undefined, toQueryParams(params), options)).data)),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST', path, body, undefined, options),
  patch: <T>(path: string, body: unknown, options?: RequestOptions) => request<T>('PATCH', path, body, undefined, options),
  delete: <T = void>(path: string, options?: RequestOptions) => request<T>('DELETE', path, undefined, undefined, options),
};

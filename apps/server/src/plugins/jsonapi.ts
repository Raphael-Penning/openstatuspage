/**
 * JSON:API 1.1 request handling.
 *
 * Global (registered once by buildApp):
 * - a body parser for `application/vnd.api+json`;
 * - content negotiation for JSON:API routes (415 for unsupported Content-Type
 *   media type parameters or a non JSON:API body, 406 for an Accept header whose
 *   JSON:API media types all carry unsupported parameters);
 * - unwrapping of request documents: route handlers receive the flattened
 *   resource (`data.attributes` + relationship ids, see flattenResource) as
 *   `req.body`, so they keep validating plain inputs with zod.
 *
 * Route groups opt in with {@link useJsonApi} inside their plugin scope:
 *
 *   await app.register(async (scope) => {
 *     useJsonApi(scope);                       // every route in this scope
 *     scope.post('/api/x', { config: { jsonapi: { type: 'things' } } }, handler);
 *   });
 */
import {
  JSONAPI_MEDIA_TYPE,
  flattenResource,
  type ErrorObject,
  type NewResourceObject,
} from '@openstatuspage/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, invalidParameter } from '../lib/errors.js';
import { errorDocument } from '../lib/jsonapi.js';
import { mapError } from '../lib/jsonapi-errors.js';

export interface JsonApiRouteConfig {
  /**
   * 'jsonapi' (default): request bodies must be JSON:API documents.
   * 'native': the route receives payloads dictated by external systems
   * (ingest/webhooks); only the response is JSON:API.
   */
  requestBody?: 'jsonapi' | 'native';
  /** Expected `data.type` of the request document; another type is answered with 409. */
  type?: string;
  /**
   * The handler reads the `include` parameter (parseInclude/parseListQuery). On
   * other routes `include` is answered with 400 `unsupported_include` (JSON:API 1.1).
   */
  include?: boolean;
  /**
   * A `POST` action on an existing resource (e.g. confirm): the request document
   * may name that resource in `data.id`, which must match the `:id` URL parameter.
   * Elsewhere a `POST` with `data.id` is answered with 403 (no client-generated ids).
   */
  allowId?: boolean;
  /** The handler reads the `sort` parameter; on other routes `sort` is answered with 400 `unsupported_sort`. */
  sort?: boolean;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set by useJsonApi(): the route speaks JSON:API. */
    jsonapi?: JsonApiRouteConfig;
  }
}

/** Marks every route registered in `scope` (after this call) as a JSON:API route. */
export function useJsonApi(scope: FastifyInstance, defaults: JsonApiRouteConfig = {}): void {
  scope.addHook('onRoute', (route) => {
    const config = (route.config ?? {}) as { jsonapi?: JsonApiRouteConfig };
    route.config = { ...config, jsonapi: { requestBody: 'jsonapi', ...defaults, ...config.jsonapi } } as typeof route.config;
  });
}

/** Route options of a handler that reads `include` (spread into the route options). */
export const withInclude = { config: { jsonapi: { include: true } } };

export function jsonApiConfig(req: FastifyRequest): JsonApiRouteConfig | undefined {
  return (req.routeOptions?.config as { jsonapi?: JsonApiRouteConfig } | undefined)?.jsonapi;
}

/** Relationship names of the request document (used to point errors at relationships). */
const requestRelationships = new WeakMap<FastifyRequest, ReadonlySet<string>>();

export const relationshipsOf = (req: FastifyRequest): ReadonlySet<string> | undefined => requestRelationships.get(req);

interface MediaType {
  essence: string;
  params: Record<string, string>;
}

/** "application/vnd.api+json; profile=x" → { essence, params }. */
function parseMediaType(value: string): MediaType {
  const [type = '', ...rest] = value.split(';');
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    params[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }
  return { essence: type.trim().toLowerCase(), params };
}

/** Only `profile` is supported; `ext` (no extensions are implemented) and others are not. */
const supportedParams = (m: MediaType) => Object.keys(m.params).every((k) => k === 'profile');

/** Accept entries split at commas outside of quoted strings. */
function splitAccept(header: string): string[] {
  return header.match(/(?:[^,"]|"[^"]*")+/g)?.map((s) => s.trim()) ?? [];
}

const hasBody = (req: FastifyRequest) =>
  req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;

function negotiate(req: FastifyRequest, reply: FastifyReply, config: JsonApiRouteConfig): void {
  const accept = req.headers.accept;
  if (accept) {
    const entries = splitAccept(accept)
      .map((e) => parseMediaType(e))
      // q is an Accept parameter, not a media type parameter.
      .map((m) => {
        const { q: _q, ...params } = m.params;
        return { ...m, params };
      })
      .filter((m) => m.essence === JSONAPI_MEDIA_TYPE);
    if (entries.length > 0 && !entries.some(supportedParams)) {
      throw new HttpError(406, 'not_acceptable', `${JSONAPI_MEDIA_TYPE} is only available without media type parameters`, undefined, {
        source: { header: 'Accept' },
      });
    }
  }
  if (config.requestBody !== 'native' && hasBody(req)) {
    const contentType = parseMediaType(String(req.headers['content-type'] ?? ''));
    if (contentType.essence !== JSONAPI_MEDIA_TYPE) {
      throw new HttpError(415, 'unsupported_media_type', `Request bodies must use ${JSONAPI_MEDIA_TYPE}`, undefined, {
        source: { header: 'Content-Type' },
      });
    }
    if (!supportedParams(contentType)) {
      throw new HttpError(415, 'unsupported_media_type', 'Unsupported media type parameters in Content-Type', undefined, {
        source: { header: 'Content-Type' },
      });
    }
  }
  reply.type(JSONAPI_MEDIA_TYPE);
}

/**
 * `include` and `sort` on a route that does not support them: 400 (JSON:API 1.1
 * says an endpoint MUST answer 400 to parameters it does not support).
 */
function checkQuery(req: FastifyRequest, config: JsonApiRouteConfig): void {
  const query = (req.query ?? {}) as Record<string, unknown>;
  if (!config.include && query.include !== undefined) {
    throw invalidParameter('include', 'This endpoint does not support the include parameter', 'unsupported_include');
  }
  if (!config.sort && query.sort !== undefined) {
    throw invalidParameter('sort', 'This endpoint does not support the sort parameter', 'unsupported_sort');
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const invalidDocument = (detail: string, pointer: string) =>
  new HttpError(400, 'invalid_document', detail, undefined, { source: { pointer } });

/** Replaces a JSON:API request document by the flattened resource. */
function unwrap(req: FastifyRequest, config: JsonApiRouteConfig): void {
  const body = req.body;
  if (!isObject(body) || !('data' in body)) {
    throw invalidDocument('The request document must contain a "data" member', '');
  }
  const data = body.data;
  if (!isObject(data) || typeof data.type !== 'string' || data.type === '') {
    throw invalidDocument('"data" must be a resource object with a "type"', '/data');
  }
  if (data.attributes !== undefined && !isObject(data.attributes)) {
    throw invalidDocument('"attributes" must be an object', '/data/attributes');
  }
  if (data.relationships !== undefined && !isObject(data.relationships)) {
    throw invalidDocument('"relationships" must be an object', '/data/relationships');
  }
  if (config.type && data.type !== config.type) {
    throw new HttpError(409, 'type_mismatch', `Expected a resource of type "${config.type}"`, undefined, {
      source: { pointer: '/data/type' },
    });
  }
  if (req.method === 'POST' && data.id !== undefined && !config.allowId) {
    throw new HttpError(403, 'client_id_unsupported', 'Client-generated ids are not supported', undefined, {
      source: { pointer: '/data/id' },
    });
  }
  const paramId = (req.params as Record<string, unknown> | undefined)?.id;
  if (typeof paramId === 'string' && data.id !== undefined && data.id !== paramId) {
    throw new HttpError(409, 'id_mismatch', 'data.id does not match the URL', undefined, { source: { pointer: '/data/id' } });
  }
  requestRelationships.set(req, new Set(Object.keys((data.relationships as object | undefined) ?? {})));
  req.body = flattenResource(data as unknown as NewResourceObject);
}

/**
 * Native request bodies (ingest/webhooks) are no JSON:API documents: their
 * validation errors point into the body as sent ("/checks/0/state").
 */
function nativePointer(error: ErrorObject): ErrorObject {
  const pointer = error.source?.pointer;
  if (pointer === undefined || !pointer.startsWith('/data')) return error;
  const rest = pointer.startsWith('/data/attributes') ? pointer.slice('/data/attributes'.length) : pointer.slice('/data'.length);
  return { ...error, source: { ...error.source, pointer: rest } };
}

/** Error handler body for JSON:API routes: maps `err` and sends the error document. */
export function sendJsonApiError(err: unknown, req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const mapped = mapError(err, relationshipsOf(req));
  const { status } = mapped;
  const errors = jsonApiConfig(req)?.requestBody === 'native' ? mapped.errors.map(nativePointer) : mapped.errors;
  if (status >= 500) req.log.error({ err }, 'request failed');
  return reply.status(status).type(JSONAPI_MEDIA_TYPE).send(errorDocument(errors));
}

const isJsonApiContent = (req: FastifyRequest) =>
  parseMediaType(String(req.headers['content-type'] ?? '')).essence === JSONAPI_MEDIA_TYPE;

/** Global JSON:API request handling; call once on the root instance before the routes. */
export function registerJsonApi(app: FastifyInstance): void {
  app.addContentTypeParser(JSONAPI_MEDIA_TYPE, { parseAs: 'string' }, app.getDefaultJsonParser('error', 'error'));

  app.addHook('onRequest', async (req, reply) => {
    const config = jsonApiConfig(req);
    if (!config) return;
    negotiate(req, reply, config);
    checkQuery(req, config);
  });

  app.addHook('preValidation', async (req) => {
    const config = jsonApiConfig(req);
    if (!config || config.requestBody === 'native') return;
    if (isJsonApiContent(req) && req.body !== undefined) unwrap(req, config);
  });

  // Fastify appends "; charset=utf-8" to serialized JSON; JSON:API forbids other parameters.
  app.addHook('onSend', async (_req, reply, payload) => {
    const type = reply.getHeader('content-type');
    if (typeof type === 'string' && type !== JSONAPI_MEDIA_TYPE && type.startsWith(JSONAPI_MEDIA_TYPE)) {
      reply.header('content-type', JSONAPI_MEDIA_TYPE);
    }
    return payload;
  });
}

/**
 * JSON:API 1.1 serializer helpers: resource objects, relationships, compound
 * documents, collections with pagination links and the 201/204 reply helpers.
 *
 * Routes build documents explicitly (no automatic mapping of database rows):
 *
 *   const res = resource('incidents', inc.id, attrs, {
 *     relationships: { locations: toMany('locations', inc.locationIds) },
 *     links: { self: `/api/public/incidents/${inc.id}` },
 *   });
 *   return document(res, { included, links: { self: selfLink(req) } });
 */
import {
  JSONAPI_MEDIA_TYPE,
  JSONAPI_VERSION,
  type DataDocument,
  type ErrorObject,
  type JsonApiLinks,
  type JsonApiMeta,
  type MetaDocument,
  type RelationshipObject,
  type ResourceIdentifier,
  type ResourceObject,
} from '@openstatuspage/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

export { JSONAPI_MEDIA_TYPE };

export const JSONAPI_OBJECT = Object.freeze({ version: JSONAPI_VERSION });

export interface ResourceOptions {
  relationships?: Record<string, RelationshipObject>;
  links?: JsonApiLinks;
  meta?: JsonApiMeta;
}

/**
 * Resource object. `attributes` must not contain `id` or `type` (they are removed);
 * foreign keys belong in `relationships` (see {@link toOne}/{@link toMany}).
 */
export function resource<A extends object>(
  type: string,
  id: string,
  attributes: A,
  options: ResourceOptions = {},
): ResourceObject<Omit<A, 'id' | 'type'>> {
  const { id: _id, type: _type, ...attrs } = attributes as A & { id?: unknown; type?: unknown };
  const out: ResourceObject<Omit<A, 'id' | 'type'>> = { type, id, attributes: attrs as Omit<A, 'id' | 'type'> };
  if (options.relationships && Object.keys(options.relationships).length > 0) out.relationships = options.relationships;
  if (options.links) out.links = options.links;
  if (options.meta) out.meta = options.meta;
  return out;
}

export const identifier = (type: string, id: string): ResourceIdentifier => ({ type, id });

/** To-one relationship; `null` id → `{ data: null }`. */
export function toOne(type: string, id: string | null | undefined, links?: JsonApiLinks): RelationshipObject {
  return { data: id ? identifier(type, id) : null, ...(links ? { links } : {}) };
}

/** To-many relationship (resource linkage in the given order, duplicates removed). */
export function toMany(type: string, ids: Iterable<string>, links?: JsonApiLinks): RelationshipObject {
  return { data: [...new Set(ids)].map((id) => identifier(type, id)), ...(links ? { links } : {}) };
}

const keyOf = (r: { type: string; id: string }) => `${r.type}\u0000${r.id}`;

/** Collects the resources of a compound document; every type/id pair is kept once (first wins). */
export class Included {
  private readonly items = new Map<string, ResourceObject>();

  add(...resources: ResourceObject[]): this {
    for (const r of resources) if (!this.items.has(keyOf(r))) this.items.set(keyOf(r), r);
    return this;
  }

  has(type: string, id: string): boolean {
    return this.items.has(keyOf({ type, id }));
  }

  get size(): number {
    return this.items.size;
  }

  toArray(): ResourceObject[] {
    return [...this.items.values()];
  }
}

export interface DocumentOptions {
  included?: Included | ResourceObject[];
  meta?: JsonApiMeta;
  links?: JsonApiLinks;
}

/**
 * Top-level data document. Included resources that are also primary data are
 * dropped (a compound document holds each resource once).
 */
export function document<D extends ResourceObject | ResourceObject[] | null>(
  data: D,
  options: DocumentOptions = {},
): DataDocument<D> {
  const doc: DataDocument<D> = { jsonapi: JSONAPI_OBJECT, data };
  if (options.links) doc.links = options.links;
  if (options.meta) doc.meta = options.meta;
  if (options.included) {
    const primary: ResourceObject[] = Array.isArray(data) ? data : data ? [data as ResourceObject] : [];
    const seen = new Set(primary.map(keyOf));
    const list = options.included instanceof Included ? options.included.toArray() : options.included;
    const included = list.filter((r) => !seen.has(keyOf(r)) && Boolean(seen.add(keyOf(r))));
    if (included.length > 0) doc.included = included;
  }
  return doc;
}

/** Document without primary data (e.g. the result of an action endpoint). */
export function metaDocument(meta: JsonApiMeta, links?: JsonApiLinks): MetaDocument {
  return { jsonapi: JSONAPI_OBJECT, meta, ...(links ? { links } : {}) };
}

export function errorDocument(errors: ErrorObject[]): { jsonapi: typeof JSONAPI_OBJECT; errors: ErrorObject[] } {
  return { jsonapi: JSONAPI_OBJECT, errors };
}

/** Request path + query as sent by the client (relative URI-reference for `links.self`). */
export function selfLink(req: FastifyRequest): string {
  return req.url;
}

/** 201 Created with a Location header and the document of the new resource. */
export function created<D extends DataDocument>(reply: FastifyReply, doc: D, location: string): D {
  reply.code(201).header('location', location);
  return doc;
}

/** 204 No Content (DELETE, actions without a result). Return the result from the handler. */
export function noContent(reply: FastifyReply): FastifyReply {
  return reply.code(204).send();
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export interface PageParams {
  /** 1-based page number. */
  number: number;
  size: number;
}

/** Builds `path?query` with `page[number]` replaced; other parameters keep their order. */
function pageUrl(path: string, query: Record<string, unknown>, number: number, size: number): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k === 'page[number]' || k === 'page[size]' || v === undefined) continue;
    for (const value of Array.isArray(v) ? v : [v]) params.append(k, String(value));
  }
  params.set('page[number]', String(number));
  params.set('page[size]', String(size));
  // Keep the brackets readable (they are allowed in a query component).
  return `${path}?${params.toString().replace(/%5B/g, '[').replace(/%5D/g, ']')}`;
}

/** `self`, `first`, `prev`, `next`, `last` links of a page (prev/next null at the ends). */
export function paginationLinks(req: FastifyRequest, page: PageParams, total: number): JsonApiLinks {
  const path = req.url.split('?')[0] ?? req.url;
  const query = (req.query ?? {}) as Record<string, unknown>;
  const last = Math.max(1, Math.ceil(total / page.size));
  return {
    self: pageUrl(path, query, page.number, page.size),
    first: pageUrl(path, query, 1, page.size),
    prev: page.number > 1 ? pageUrl(path, query, Math.min(page.number - 1, last), page.size) : null,
    next: page.number < last ? pageUrl(path, query, page.number + 1, page.size) : null,
    last: pageUrl(path, query, last, page.size),
  };
}

export interface CollectionOptions extends DocumentOptions {
  /** Paginates the document: `meta.total`, `meta.page` and the pagination links. */
  page?: PageParams;
  total?: number;
}

/**
 * Collection document. With `page` + `total`: `meta: { total, page: { number, size } }`
 * and first/prev/next/last links. Without: `meta.total` is the number of resources.
 */
export function collection(req: FastifyRequest, data: ResourceObject[], options: CollectionOptions = {}): DataDocument<ResourceObject[]> {
  const total = options.total ?? data.length;
  const meta: JsonApiMeta = { ...options.meta, total };
  if (options.page) meta.page = { number: options.page.number, size: options.page.size };
  const links = options.page
    ? { ...paginationLinks(req, options.page, total), ...options.links }
    : { self: selfLink(req), ...options.links };
  return document(data, { included: options.included, meta, links });
}

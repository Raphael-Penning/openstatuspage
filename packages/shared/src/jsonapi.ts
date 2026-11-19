/**
 * JSON:API 1.1 (https://jsonapi.org/format/1.1/) document types and helpers
 * shared by the server (serializing) and the web client (deserializing).
 *
 * Conventions of this project:
 * - `type` is the kebab-case plural (services, incident-updates, ...), `id` a string.
 * - Attributes keep the camelCase field names of the plain objects.
 * - Relationships flatten to `<name>Id` (to-one) or `<singular>Ids` (to-many) on the
 *   plain object, see {@link relationshipKey}. When the related resources are part of
 *   the document (`included` or primary data), the plain object also carries them
 *   under the relationship name.
 */
import type { Paginated } from './schemas.js';

export const JSONAPI_MEDIA_TYPE = 'application/vnd.api+json';
export const JSONAPI_VERSION = '1.1';

export type JsonApiMeta = Record<string, unknown>;

export interface JsonApiLinkObject {
  href: string;
  rel?: string;
  title?: string;
  type?: string;
  hreflang?: string | string[];
  meta?: JsonApiMeta;
}
export type JsonApiLink = string | JsonApiLinkObject | null;

export interface JsonApiLinks {
  self?: JsonApiLink;
  related?: JsonApiLink;
  first?: JsonApiLink;
  prev?: JsonApiLink;
  next?: JsonApiLink;
  last?: JsonApiLink;
  [name: string]: JsonApiLink | undefined;
}

export interface ResourceIdentifier {
  type: string;
  id: string;
  meta?: JsonApiMeta;
}

export interface RelationshipObject {
  data?: ResourceIdentifier | ResourceIdentifier[] | null;
  links?: JsonApiLinks;
  meta?: JsonApiMeta;
}

export interface ResourceObject<A extends object = Record<string, unknown>> {
  type: string;
  id: string;
  attributes?: A;
  relationships?: Record<string, RelationshipObject>;
  links?: JsonApiLinks;
  meta?: JsonApiMeta;
}

/** Resource object in a request body (`id` is optional on create). */
export interface NewResourceObject<A extends object = Record<string, unknown>> {
  type: string;
  id?: string;
  attributes?: A;
  relationships?: Record<string, RelationshipObject>;
  meta?: JsonApiMeta;
}

export interface JsonApiObject {
  version?: string;
  ext?: string[];
  profile?: string[];
  meta?: JsonApiMeta;
}

export interface ErrorSource {
  /** JSON Pointer to the value in the request document, e.g. "/data/attributes/name". */
  pointer?: string;
  /** Name of the query parameter that caused the error. */
  parameter?: string;
  /** Name of the request header that caused the error. */
  header?: string;
}

export interface ErrorObject {
  id?: string;
  links?: JsonApiLinks;
  /** HTTP status code as a string. */
  status?: string;
  /** Application specific, stable error code (snake_case). */
  code?: string;
  title?: string;
  detail?: string;
  source?: ErrorSource;
  meta?: JsonApiMeta;
}

export type PrimaryData = ResourceObject | ResourceObject[] | ResourceIdentifier | ResourceIdentifier[] | null;

export interface DataDocument<D extends PrimaryData = PrimaryData> {
  jsonapi?: JsonApiObject;
  data: D;
  included?: ResourceObject[];
  meta?: JsonApiMeta;
  links?: JsonApiLinks;
}

export interface MetaDocument {
  jsonapi?: JsonApiObject;
  meta: JsonApiMeta;
  links?: JsonApiLinks;
}

export interface ErrorDocument {
  jsonapi?: JsonApiObject;
  errors: ErrorObject[];
  meta?: JsonApiMeta;
  links?: JsonApiLinks;
}

export type JsonApiDocument = DataDocument | MetaDocument | ErrorDocument;

/** Request document for create/update (POST collection, PATCH resource, action bodies). */
export interface RequestDocument<A extends object = Record<string, unknown>> {
  data: NewResourceObject<A>;
  meta?: JsonApiMeta;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

function singular(name: string): string {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  if (name.endsWith('s')) return name.slice(0, -1);
  return name;
}

function plural(name: string): string {
  if (name.endsWith('y')) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

/**
 * Key of a relationship on the plain object: `group` (to-one) → `groupId`,
 * `services` (to-many) → `serviceIds`, `activeIncidents` → `activeIncidentIds`.
 */
export function relationshipKey(name: string, many: boolean): string {
  return many ? `${singular(name)}Ids` : `${name}Id`;
}

/**
 * Inverse of {@link relationshipKey}: `serviceIds` → `{ name: 'services', many: true }`,
 * `groupId` → `{ name: 'group', many: false }`. null when the key is no relationship key.
 */
export function relationshipNameForKey(key: string): { name: string; many: boolean } | null {
  if (/.Ids$/.test(key)) return { name: plural(key.slice(0, -3)), many: true };
  if (/.Id$/.test(key)) return { name: key.slice(0, -2), many: false };
  return null;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isErrorDocument(doc: unknown): doc is ErrorDocument {
  return isObject(doc) && Array.isArray(doc.errors);
}

export function isDataDocument(doc: unknown): doc is DataDocument {
  return isObject(doc) && 'data' in doc;
}

// ---------------------------------------------------------------------------
// Building request documents (client side)
// ---------------------------------------------------------------------------

export interface ToResourceOptions {
  id?: string;
  /**
   * Plain fields to send as relationships, mapped to the related resource type:
   * `{ serviceIds: 'services', groupId: 'service-groups' }`. The relationship name
   * follows {@link relationshipNameForKey}. Other fields become attributes.
   */
  relationships?: Record<string, string>;
}

const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;

/**
 * Fallback resource type for a request body, derived from the URL: the last path
 * segment that is not an id. `/api/admin/services/<uuid>` → "services",
 * `/api/admin/incidents/<uuid>/updates` → "updates". Pass the type explicitly
 * where the route checks it (sub-resources, actions).
 */
export function inferResourceType(url: string): string {
  const segments = (url.split(/[?#]/)[0] ?? '')
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]!;
    if (!ID_SEGMENT.test(s) && s !== 'api') return s;
  }
  return 'resources';
}

/** Wraps a plain object as a request document: `{ data: { type, attributes, relationships } }`. */
export function toRequestDocument<A extends object>(
  type: string,
  values: A | undefined,
  options: ToResourceOptions = {},
): RequestDocument {
  const attributes: Record<string, unknown> = {};
  const relationships: Record<string, RelationshipObject> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    const relatedType = options.relationships?.[key];
    const rel = relatedType ? relationshipNameForKey(key) : null;
    if (!relatedType || !rel) {
      if (value !== undefined) attributes[key] = value;
      continue;
    }
    if (value === undefined) continue;
    if (rel.many) {
      const ids = Array.isArray(value) ? (value as unknown[]) : [];
      relationships[rel.name] = { data: ids.map((id) => ({ type: relatedType, id: String(id) })) };
    } else {
      relationships[rel.name] = { data: value === null ? null : { type: relatedType, id: String(value) } };
    }
  }
  const data: NewResourceObject = { type, attributes };
  if (options.id !== undefined) data.id = options.id;
  if (Object.keys(relationships).length > 0) data.relationships = relationships;
  return { data };
}

/**
 * Flattens a resource object of a request body into the plain input object the
 * route handlers validate: attributes plus relationship ids (see {@link relationshipKey}).
 */
export function flattenResource(resource: NewResourceObject): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(isObject(resource.attributes) ? resource.attributes : {}) };
  for (const [name, rel] of Object.entries(isObject(resource.relationships) ? resource.relationships : {})) {
    if (!isObject(rel) || !('data' in rel)) continue;
    const data = rel.data;
    if (Array.isArray(data)) out[relationshipKey(name, true)] = data.map((r) => r?.id);
    else out[relationshipKey(name, false)] = data === null ? null : (data as ResourceIdentifier | undefined)?.id;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deserializing response documents (client side)
// ---------------------------------------------------------------------------

/** Plain object of a resource: `id` + attributes + relationship ids (+ resolved relations). */
export type PlainResource = { id: string } & Record<string, unknown>;

export interface DeserializedDocument<T> {
  data: T;
  meta: JsonApiMeta;
  links: JsonApiLinks;
  /** Every resource of `included`, deserialized, in document order. */
  included: PlainResource[];
}

const keyOf = (type: string, id: string) => `${type}\u0000${id}`;

class Resolver {
  private readonly index = new Map<string, ResourceObject>();

  constructor(doc: DataDocument) {
    const primary = Array.isArray(doc.data) ? doc.data : doc.data ? [doc.data] : [];
    for (const res of [...primary, ...(doc.included ?? [])]) {
      // Resource identifiers (no attributes/relationships) cannot be resolved.
      if (isObject(res) && ('attributes' in res || 'relationships' in res)) {
        this.index.set(keyOf(res.type, res.id), res as ResourceObject);
      }
    }
  }

  /**
   * Builds the plain object. Related resources found in the document are resolved
   * recursively; a resource already being resolved further up is left out (ids only),
   * so the result is always a tree without cycles.
   */
  plain(res: ResourceObject, stack: Set<string> = new Set()): PlainResource {
    const key = keyOf(res.type, res.id);
    const out: PlainResource = { ...(res.attributes ?? {}), id: res.id };
    const nextStack = new Set(stack).add(key);
    for (const [name, rel] of Object.entries(res.relationships ?? {})) {
      if (!rel || !('data' in rel) || rel.data === undefined) continue;
      const data = rel.data;
      if (Array.isArray(data)) {
        out[relationshipKey(name, true)] = data.map((r) => r.id);
        const related = data.map((r) => this.index.get(keyOf(r.type, r.id)));
        if (related.every((r) => r !== undefined && !nextStack.has(keyOf(r.type, r.id)))) {
          out[name] = (related as ResourceObject[]).map((r) => this.plain(r, nextStack));
        }
      } else if (data === null) {
        out[relationshipKey(name, false)] = null;
      } else {
        out[relationshipKey(name, false)] = data.id;
        const related = this.index.get(keyOf(data.type, data.id));
        if (related && !nextStack.has(keyOf(related.type, related.id))) out[name] = this.plain(related, nextStack);
      }
    }
    return out;
  }

  resolve(data: PrimaryData): unknown {
    if (data === null) return null;
    if (Array.isArray(data)) return data.map((r) => this.plain(r as ResourceObject));
    return this.plain(data as ResourceObject);
  }
}

/**
 * Deserializes a data document into plain objects (see {@link PlainResource}).
 * Collections become arrays. Also returns the top-level meta, links and included.
 */
export function deserializeDocument<T = unknown>(doc: DataDocument): DeserializedDocument<T> {
  const resolver = new Resolver(doc);
  return {
    data: resolver.resolve(doc.data) as T,
    meta: doc.meta ?? {},
    links: doc.links ?? {},
    included: (doc.included ?? []).map((r) => resolver.plain(r)),
  };
}

/** Shortcut for {@link deserializeDocument}: only the primary data. */
export function deserialize<T = unknown>(doc: DataDocument): T {
  return deserializeDocument<T>(doc).data;
}

/**
 * Collection document → `Paginated<T>` (`{ items, total, page, pageSize }`). Reads
 * `meta.total` and `meta.page.{number,size}` (as written by the server's pagination helper).
 */
export function deserializePage<T = PlainResource>(doc: DataDocument): Paginated<T> {
  const { data, meta } = deserializeDocument<T[]>(doc);
  const items = Array.isArray(data) ? data : [];
  const page = isObject(meta.page) ? meta.page : {};
  return {
    items,
    total: typeof meta.total === 'number' ? meta.total : items.length,
    page: typeof page.number === 'number' ? page.number : 1,
    pageSize: typeof page.size === 'number' ? page.size : items.length,
  };
}

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

export interface ListParams {
  page?: { number?: number; size?: number };
  filter?: Record<string, string | number | boolean | null | undefined>;
  /** Fields, "-" prefix for descending. */
  sort?: string[];
  include?: string[];
}

/**
 * Builds JSON:API query parameters: `page[number]`, `page[size]`, `filter[x]`, `sort`, `include`.
 * Empty values are left out.
 */
export function toQueryParams(params: ListParams): Record<string, string> {
  const out: Record<string, string> = {};
  if (params.page?.number !== undefined) out['page[number]'] = String(params.page.number);
  if (params.page?.size !== undefined) out['page[size]'] = String(params.page.size);
  for (const [name, value] of Object.entries(params.filter ?? {})) {
    if (value !== undefined && value !== null && value !== '') out[`filter[${name}]`] = String(value);
  }
  if (params.sort?.length) out.sort = params.sort.join(',');
  if (params.include?.length) out.include = params.include.join(',');
  return out;
}

// ---------------------------------------------------------------------------
// Errors (client side)
// ---------------------------------------------------------------------------

/** A zod-like issue derived from a JSON:API error (what the UI forms consume). */
export interface ErrorIssue {
  /** Field path in the plain input object; empty for errors without a field pointer. */
  path: (string | number)[];
  message: string;
  code?: string;
  /** Further issue details from the error's `meta` (e.g. `minimum`, `line`). */
  [detail: string]: unknown;
}

const segment = (p: string): string | number => (/^\d+$/.test(p) ? Number(p) : p);

/**
 * Maps an error source pointer to the field path of the plain input object:
 * "/data/attributes/checks/0/checkId" → ["checks", 0, "checkId"],
 * "/data/relationships/services" → ["serviceIds"]. null for other pointers.
 */
export function pointerToPath(pointer: string): (string | number)[] | null {
  const parts = pointer
    .split('/')
    .slice(1)
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts[0] !== 'data') return null;
  if (parts[1] === 'attributes') return parts.slice(2).map(segment);
  if (parts[1] === 'relationships' && parts[2]) {
    // "/data/relationships/services/data/2" → ["serviceIds", 2]; plural names are to-many.
    const name = parts[2];
    const rest = parts.slice(3).filter((p, i) => !(i === 0 && p === 'data'));
    return [relationshipKey(name, name.endsWith('s')), ...rest.map(segment)];
  }
  return [];
}

/**
 * Field issues of an error document: every error with a `/data...` pointer or with
 * issue details in `meta`. For validation errors the zod issue code is the error `code`.
 */
export function errorIssues(errors: ErrorObject[]): ErrorIssue[] {
  const out: ErrorIssue[] = [];
  for (const e of errors) {
    const path = e.source?.pointer !== undefined ? pointerToPath(e.source.pointer) : null;
    const hasMeta = e.meta !== undefined && Object.keys(e.meta).length > 0;
    if (!path && !hasMeta) continue;
    out.push({ ...(e.meta ?? {}), path: path ?? [], message: e.detail ?? e.title ?? '', code: e.code });
  }
  return out;
}

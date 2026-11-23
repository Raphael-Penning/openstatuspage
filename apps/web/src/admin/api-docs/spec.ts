/**
 * Reading the OpenAPI 3.1 document of GET /api/openapi.json for the API
 * documentation page: operations grouped by tag, `$ref` resolution, example
 * request bodies from the schemas and the same-origin URL of a "try it" request.
 * Only what the server's document uses (server/src/openapi) is supported.
 */

export type Schema = {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  additionalProperties?: boolean | Schema;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  examples?: unknown[];
  example?: unknown;
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  contentMediaType?: string;
};

export interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  description?: string;
  required?: boolean;
  schema?: Schema;
  example?: unknown;
}

export interface MediaType {
  schema?: Schema;
  example?: unknown;
}

export interface ResponseObject {
  $ref?: string;
  description?: string;
  headers?: Record<string, { description?: string }>;
  content?: Record<string, MediaType>;
}

export interface OperationObject {
  operationId: string;
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: { description?: string; required?: boolean; content: Record<string, MediaType> };
  responses: Record<string, ResponseObject>;
  security?: Record<string, string[]>[];
  'x-required-role'?: 'editor' | 'admin';
  'x-rate-limit'?: { max: number; window: string; per: string };
}

export interface SecurityScheme {
  type: 'apiKey' | 'http';
  in?: 'header' | 'query' | 'cookie';
  name?: string;
  scheme?: string;
  description?: string;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  tags?: { name: string; description?: string }[];
  paths: Record<string, Record<string, OperationObject>>;
  components?: {
    schemas?: Record<string, Schema>;
    responses?: Record<string, ResponseObject>;
    securitySchemes?: Record<string, SecurityScheme>;
  };
}

export const METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const;
export type HttpMethod = (typeof METHODS)[number];

export interface DocOperation {
  method: HttpMethod;
  path: string;
  operation: OperationObject;
}

export interface TagGroup {
  name: string;
  description?: string;
  operations: DocOperation[];
}

/** Operations by tag, in the order of `tags` (untagged ones last). */
export function groupByTag(doc: OpenApiDocument): TagGroup[] {
  const groups = new Map<string, TagGroup>();
  for (const tag of doc.tags ?? []) groups.set(tag.name, { name: tag.name, description: tag.description, operations: [] });
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const name = operation.tags?.[0] ?? 'Other';
      if (!groups.has(name)) groups.set(name, { name, operations: [] });
      groups.get(name)!.operations.push({ method, path, operation });
    }
  }
  return [...groups.values()].filter((g) => g.operations.length > 0);
}

/** Case-insensitive match on method, path, summary, operationId and tag. */
export function matchesQuery(op: DocOperation, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const text = `${op.method} ${op.path} ${op.operation.summary ?? ''} ${op.operation.operationId} ${op.operation.tags?.join(' ') ?? ''}`.toLowerCase();
  return q.split(/\s+/).every((word) => text.includes(word));
}

/** The name of a local `$ref` (`#/components/schemas/ServiceInput` → `ServiceInput`). */
export const refName = (ref: string) => ref.slice(ref.lastIndexOf('/') + 1);

/** Resolves a local `#/components/...` reference; unknown references stay as they are. */
export function resolve<T extends { $ref?: string }>(doc: OpenApiDocument, value: T): T {
  let current: T = value;
  for (let i = 0; i < 10 && current.$ref; i++) {
    const parts = current.$ref.replace(/^#\//, '').split('/');
    let target: unknown = doc;
    for (const part of parts) target = (target as Record<string, unknown> | undefined)?.[part];
    if (!target || typeof target !== 'object') return current;
    current = target as T;
  }
  return current;
}

/** Short type text: `string`, `integer | null`, `array<string>`, `ServiceInput`. */
export function typeLabel(doc: OpenApiDocument, schema: Schema): string {
  if (schema.$ref) return refName(schema.$ref);
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return variants.map((s) => typeLabel(doc, s)).join(' | ');
  if (schema.allOf) return schema.allOf.map((s) => typeLabel(doc, s)).join(' & ');
  const type = Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type;
  if (type === 'array' && schema.items) return `array<${typeLabel(doc, schema.items)}>`;
  return type ?? 'any';
}

/** Constraints of a schema as short phrases (`1–120 characters`, `one of: a, b`). */
export function constraints(schema: Schema): string[] {
  const list: string[] = [];
  if (schema.enum) list.push(`enum: ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  if (schema.format) list.push(`format: ${schema.format}`);
  if (schema.pattern) list.push(`pattern: ${schema.pattern}`);
  if (schema.minLength !== undefined || schema.maxLength !== undefined) list.push(`length: ${schema.minLength ?? 0}–${schema.maxLength ?? '∞'}`);
  if (isBound(schema.minimum) || isBound(schema.maximum)) list.push(`range: ${isBound(schema.minimum) ? schema.minimum : '−∞'}–${isBound(schema.maximum) ? schema.maximum : '∞'}`);
  if (schema.minItems !== undefined || schema.maxItems !== undefined) list.push(`items: ${schema.minItems ?? 0}–${schema.maxItems ?? '∞'}`);
  if (schema.default !== undefined) list.push(`default: ${JSON.stringify(schema.default)}`);
  return list;
}

/** zod writes the safe integer range as bounds of every integer: not worth showing. */
const isBound = (n: number | undefined): n is number => n !== undefined && Math.abs(n) < Number.MAX_SAFE_INTEGER;

/**
 * An example value for `schema`: its example or default, else the first enum
 * value, else a placeholder of its type. Objects get their required properties.
 */
export function exampleOf(doc: OpenApiDocument, schema: Schema | undefined, depth = 0): unknown {
  if (!schema || depth > 8) return null;
  if (schema.$ref) return exampleOf(doc, resolve(doc, schema), depth + 1);
  if (schema.example !== undefined) return schema.example;
  if (schema.examples?.length) return schema.examples[0];
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s) => exampleOf(doc, s, depth + 1) as object));
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants) return exampleOf(doc, variants.find((s) => s.type !== 'null') ?? variants[0], depth + 1);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'object': {
      const result: Record<string, unknown> = {};
      for (const name of schema.required ?? []) result[name] = exampleOf(doc, schema.properties?.[name], depth + 1);
      return result;
    }
    case 'array':
      return [];
    case 'integer':
    case 'number':
      return schema.minimum !== undefined && isBound(schema.minimum) ? schema.minimum : 0;
    case 'boolean':
      return false;
    case 'string':
      if (schema.format === 'date-time') return '2026-01-01T00:00:00.000Z';
      if (schema.format === 'uri') return 'https://example.com';
      if (schema.format === 'email') return 'someone@example.com';
      return '';
    default:
      return null;
  }
}

/** The request body to start the "try it" form with: the documented example or one built from the schema. */
export function exampleBody(doc: OpenApiDocument, media: MediaType | undefined): string {
  if (!media) return '';
  const value = media.example !== undefined ? media.example : exampleOf(doc, media.schema);
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}

/**
 * Why a path parameter value cannot be sent: empty, or `.`/`..` (the URL would
 * point at another route after normalisation). Null when it is fine.
 */
export function pathValueProblem(value: string | undefined): 'empty' | 'dot' | null {
  if (value === undefined || value === '') return 'empty';
  if (value === '.' || value === '..') return 'dot';
  return null;
}

/**
 * The URL of a request to this instance: path parameters filled in (encoded),
 * empty query values left out. Throws for a path that would leave the origin
 * and for path parameter values that pathValueProblem refuses.
 */
export function requestUrl(path: string, pathValues: Record<string, string>, query: Record<string, string>, origin: string): string {
  const filled = path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const value = pathValues[name];
    if (pathValueProblem(value)) throw new Error(`Invalid value for the path parameter ${name}`);
    return encodeURIComponent(value!);
  });
  const url = new URL(filled, origin);
  if (url.origin !== origin || !filled.startsWith('/') || filled.startsWith('//')) throw new Error('Only requests to this instance are allowed');
  for (const [name, value] of Object.entries(query)) if (value !== '') url.searchParams.append(name, value);
  // Brackets of page[number] / filter[x] stay readable, as the web client sends them.
  return `${url.pathname}${url.search.replace(/%5B/g, '[').replace(/%5D/g, ']')}`;
}

/** Security schemes of an operation that need a value typed in (headers and query tokens, bearer tokens). */
export function credentialInputs(doc: OpenApiDocument, op: OperationObject): { scheme: string; definition: SecurityScheme }[] {
  // Signed-in users already send the cookie (and the page adds the CSRF header).
  if (op.security?.some((req) => 'sessionCookie' in req)) return [];
  const names = [...new Set((op.security ?? []).flatMap((req) => Object.keys(req)))];
  const schemes = doc.components?.securitySchemes ?? {};
  // Of alternatives, the first one is enough (ingest: bearer token rather than ?token=).
  const first = names.find((name) => schemes[name]);
  return first ? [{ scheme: first, definition: schemes[first]! }] : [];
}

/** Whether the documentation page can send this request itself (not for redirects and raw uploads). */
export function canTry(op: OperationObject): boolean {
  if (Object.keys(op.responses).some((status) => status === '302' || status === '303')) return false;
  const content = op.requestBody?.content ?? {};
  return !Object.keys(content).some((type) => type === 'application/octet-stream');
}

export const isMutating = (method: HttpMethod) => method !== 'get';

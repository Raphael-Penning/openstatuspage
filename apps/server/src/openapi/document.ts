/**
 * Builds the OpenAPI 3.1 document of the HTTP API from the declarations in
 * operations.ts and the zod schemas of packages/shared (z.toJSONSchema).
 *
 * Two scopes:
 * - `full`: every operation (docs/openapi.json, signed-in users on admin and all instances);
 * - `public`: what an instance with APP_ROLE=public serves (no /api/auth, /api/admin,
 *   /api/ingest) and what anonymous clients get everywhere. Only the components those
 *   operations reference are kept.
 *
 * The document is deterministic (no dates, no server version, relative server URL),
 * so the committed docs/openapi.json can be compared with a fresh build.
 */
import { JSONAPI_MEDIA_TYPE } from '@openstatuspage/shared';
import { z } from 'zod';
import { OPERATIONS, TAGS, type Access, type Operation, type Param, type RequestBody, type ResponseSpec } from './operations.js';
import { SCHEMAS } from './schemas.js';

export type OpenApiScope = 'full' | 'public';
type Json = Record<string, unknown>;

/** Version of this description (not of the server, which only the management API reveals). */
export const API_DESCRIPTION_VERSION = '1';

/** Routes outside /api/auth, /api/admin and /api/ingest: served by every role with the public API. */
export function isPublicOperation(op: Pick<Operation, 'path'>): boolean {
  return !/^\/api\/(auth|admin|ingest)(\/|$)/.test(op.path);
}

/** `/api/admin/services/:id` → `/api/admin/services/{id}`. */
export const openApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

const ref = (kind: 'schemas' | 'responses' | 'parameters', name: string) => ({ $ref: `#/components/${kind}/${name}` });

/** `GET /api/admin/services/:id/history` → `getAdminServicesByIdHistory`. */
export function operationId(op: Pick<Operation, 'method' | 'path'>): string {
  const words = op.path
    .replace(/^\/api\//, '/')
    .split(/[/.\-_]/)
    .filter(Boolean)
    .map((part) => (part.startsWith(':') ? `By${cap(part.slice(1))}` : cap(part)));
  return op.method.toLowerCase() + words.join('');
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------- schemas

function toJsonSchema(schema: z.ZodType): Json {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }) as Json;
  delete json.$schema;
  return json;
}

/** The same schema with nothing required (PATCH): top level and each branch of a union. */
function partial(schema: Json): Json {
  const copy: Json = { ...schema };
  delete copy.required;
  for (const key of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(copy[key])) copy[key] = (copy[key] as Json[]).map(partial);
  }
  return copy;
}

const JSONAPI_SCHEMAS: Record<string, Json> = {
  JsonApiObject: {
    type: 'object',
    properties: { version: { const: '1.1' } },
    required: ['version'],
  },
  Links: {
    type: 'object',
    description: 'Relative URLs (`self`, `first`, `prev`, `next`, `last`); `null` at the ends of a collection.',
    additionalProperties: { type: ['string', 'null'] },
  },
  ResourceIdentifier: {
    type: 'object',
    properties: { type: { type: 'string' }, id: { type: 'string' } },
    required: ['type', 'id'],
  },
  Relationship: {
    type: 'object',
    properties: {
      data: {
        anyOf: [{ type: 'null' }, ref('schemas', 'ResourceIdentifier'), { type: 'array', items: ref('schemas', 'ResourceIdentifier') }],
      },
      links: ref('schemas', 'Links'),
      meta: { type: 'object' },
    },
  },
  Resource: {
    type: 'object',
    description: 'A resource object. `attributes` use the camelCase names of the types in packages/shared/src/schemas.ts.',
    properties: {
      type: { type: 'string', description: 'kebab-case plural, e.g. `services`, `incident-updates`.' },
      id: { type: 'string' },
      attributes: { type: 'object' },
      relationships: { type: 'object', additionalProperties: ref('schemas', 'Relationship') },
      links: ref('schemas', 'Links'),
      meta: { type: 'object' },
    },
    required: ['type', 'id'],
  },
  ResourceDocument: {
    type: 'object',
    properties: {
      jsonapi: ref('schemas', 'JsonApiObject'),
      data: ref('schemas', 'Resource'),
      included: { type: 'array', items: ref('schemas', 'Resource') },
      links: ref('schemas', 'Links'),
      meta: { type: 'object' },
    },
    required: ['jsonapi', 'data'],
  },
  CollectionDocument: {
    type: 'object',
    properties: {
      jsonapi: ref('schemas', 'JsonApiObject'),
      data: { type: 'array', items: ref('schemas', 'Resource') },
      included: { type: 'array', items: ref('schemas', 'Resource') },
      links: ref('schemas', 'Links'),
      meta: {
        type: 'object',
        description: '`total`; paginated collections also `page: { number, size }`.',
        properties: {
          total: { type: 'integer' },
          page: { type: 'object', properties: { number: { type: 'integer' }, size: { type: 'integer' } } },
        },
      },
    },
    required: ['jsonapi', 'data'],
  },
  MetaDocument: {
    type: 'object',
    properties: { jsonapi: ref('schemas', 'JsonApiObject'), meta: { type: 'object' } },
    required: ['jsonapi', 'meta'],
  },
  ErrorObject: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'The HTTP status as a string.' },
      code: { type: 'string', description: 'Stable snake_case code (`not_found`, `invalid_parameter`, a zod issue code, ...).' },
      title: { type: 'string' },
      detail: { type: 'string' },
      source: {
        type: 'object',
        properties: { pointer: { type: 'string' }, parameter: { type: 'string' }, header: { type: 'string' } },
      },
      meta: { type: 'object' },
    },
    required: ['status', 'code', 'title'],
  },
  ErrorDocument: {
    type: 'object',
    properties: { jsonapi: ref('schemas', 'JsonApiObject'), errors: { type: 'array', items: ref('schemas', 'ErrorObject') } },
    required: ['jsonapi', 'errors'],
  },
};

// ---------------------------------------------------------------------------- errors

interface ErrorSpec {
  name: string;
  description: string;
  example: Json;
}

const errorExample = (status: string, code: string, title: string, detail: string, extra: Json = {}) => ({
  jsonapi: { version: '1.1' },
  errors: [{ status, code, title, detail, ...extra }],
});

/** Error answers by status, with examples from docs/api.md. */
const ERRORS: Record<number, ErrorSpec> = {
  400: {
    name: 'BadRequest',
    description: 'Invalid request: one error per validation issue (`source.pointer`), bad query parameters (`source.parameter`), `invalid_document`, `unsupported_include`, `unsupported_sort`, `unknown_relationship`.',
    example: errorExample('400', 'too_small', 'Invalid request', 'Too small: expected string to have >=1 characters', {
      source: { pointer: '/data/attributes/name' },
      meta: { origin: 'string', minimum: 1, inclusive: true },
    }),
  },
  401: {
    name: 'Unauthorized',
    description: 'Missing or invalid credentials.',
    example: errorExample('401', 'unauthorized', 'Unauthorized', 'Authentication required'),
  },
  403: {
    name: 'Forbidden',
    description: 'The role is not enough, or a cookie-authenticated mutating request lacks `X-Requested-With: openstatuspage`; `client_id_unsupported` for a `data.id` in a create request.',
    example: errorExample('403', 'forbidden', 'Forbidden', 'Missing x-requested-with header'),
  },
  404: {
    name: 'NotFound',
    description: 'Unknown resource, or a wrong token (tokens are never told apart from unknown ids).',
    example: errorExample('404', 'not_found', 'Not Found', 'Service not found'),
  },
  406: {
    name: 'NotAcceptable',
    description: 'Every `application/vnd.api+json` entry in `Accept` carries media type parameters.',
    example: errorExample('406', 'not_acceptable', 'Not Acceptable', 'application/vnd.api+json is only available without media type parameters', {
      source: { header: 'Accept' },
    }),
  },
  409: {
    name: 'Conflict',
    description: '`type_mismatch` (another `data.type`), `id_mismatch` (`data.id` differs from the URL) or a conflict with the stored data.',
    example: errorExample('409', 'id_mismatch', 'Conflict', 'data.id does not match the URL', { source: { pointer: '/data/id' } }),
  },
  413: {
    name: 'PayloadTooLarge',
    description: 'The body is larger than the endpoint accepts.',
    example: errorExample('413', 'payload_too_large', 'Payload Too Large', 'Request body is too large'),
  },
  415: {
    name: 'UnsupportedMediaType',
    description: 'The body does not use the media type of the endpoint, or carries media type parameters other than `profile`.',
    example: errorExample('415', 'unsupported_media_type', 'Unsupported Media Type', 'Request bodies must use application/vnd.api+json', {
      source: { header: 'Content-Type' },
    }),
  },
  429: {
    name: 'TooManyRequests',
    description: 'Rate limit exceeded; `Retry-After` says when to try again.',
    example: errorExample('429', 'rate_limited', 'Too Many Requests', 'Rate limit exceeded, retry in 42 seconds'),
  },
};

function errorResponse(status: number): Json {
  const spec = ERRORS[status]!;
  return {
    description: spec.description,
    ...(status === 429 ? { headers: { 'Retry-After': { description: 'Seconds to wait.', schema: { type: 'integer' } } } } : {}),
    content: { [JSONAPI_MEDIA_TYPE]: { schema: ref('schemas', 'ErrorDocument'), example: spec.example } },
  };
}

const TOKEN_ACCESS = new Set<Access>(['subscriptionToken', 'subscriptionTokenQuery', 'privatePageToken']);
const MUTATING = new Set(['POST', 'PATCH', 'DELETE']);

/** The error statuses an operation can answer with, from its declaration. */
export function errorStatuses(op: Operation): number[] {
  const jsonapi = op.jsonapi !== false;
  const statuses = new Set<number>(op.errors ?? []);
  if (jsonapi || op.request || op.query || op.filters) statuses.add(400);
  if (['editor', 'admin', 'session', 'ingest'].includes(op.access)) statuses.add(401);
  if (op.access === 'editor' || op.access === 'admin' || (op.access === 'session' && MUTATING.has(op.method))) statuses.add(403);
  if (op.pathParams || TOKEN_ACCESS.has(op.access)) statuses.add(404);
  if (jsonapi) statuses.add(406);
  if (op.request?.kind === 'resource') {
    statuses.add(409);
    statuses.add(415);
  }
  if (op.request) statuses.add(413);
  if (op.request?.kind === 'binary') statuses.add(415);
  if (op.rateLimit || op.access === 'privatePageToken') statuses.add(429);
  return [...statuses].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------- security

const SECURITY_SCHEMES: Record<string, Json> = {
  sessionCookie: {
    type: 'apiKey',
    in: 'cookie',
    name: 'osp_session',
    description: 'Session cookie set by `POST /api/auth/login` or single sign-on (httpOnly, SameSite=Lax).',
  },
  csrfHeader: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Requested-With',
    description: 'CSRF protection: cookie-authenticated mutating requests must send `X-Requested-With: openstatuspage`. Not needed with an API token.',
  },
  apiToken: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'osp_…',
    description: 'API token of the management UI (Administration → API tokens), with the role `editor` or `admin`.',
  },
  ingestToken: {
    type: 'http',
    scheme: 'bearer',
    description: 'Ingest token of a monitoring source (shown once on create or rotate).',
  },
  ingestTokenQuery: {
    type: 'apiKey',
    in: 'query',
    name: 'token',
    description: 'The ingest token as `?token=` for systems that cannot set headers (redacted in the request log).',
  },
  subscriptionToken: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Subscription-Token',
    description: 'Manage token of a subscription (from the manage link).',
  },
  subscriptionTokenQuery: {
    type: 'apiKey',
    in: 'query',
    name: 'token',
    description: 'Manage token of a subscription in the unsubscribe links of emails.',
  },
  privatePageToken: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Private-Page-Token',
    description: 'Token of a private page (from its link `/p/<token>`).',
  },
};

function security(op: Operation, scope: OpenApiScope): Json[] | undefined {
  const mutating = MUTATING.has(op.method);
  const session = mutating ? { sessionCookie: [], csrfHeader: [] } : { sessionCookie: [] };
  switch (op.access) {
    case 'public':
      // Optional credentials: `{}` allows anonymous requests.
      return op.optionalAuth && scope === 'full' ? [{}, session, { apiToken: [] }] : undefined;
    case 'anonymous':
      return undefined;
    case 'subscriptionToken':
    case 'subscriptionTokenQuery':
    case 'privatePageToken':
      return [{ [op.access]: [] }];
    case 'session':
      return [session];
    case 'editor':
    case 'admin':
      return [session, { apiToken: [] }];
    case 'ingest':
      return [{ ingestToken: [] }, { ingestTokenQuery: [] }];
  }
}

// ---------------------------------------------------------------------------- operations

function parameter(name: string, location: 'path' | 'query', param: Omit<Param, 'name'>): Json {
  return {
    name,
    in: location,
    ...(param.description ? { description: param.description } : {}),
    ...(location === 'path' || param.required ? { required: true } : {}),
    schema: param.schema,
    ...(param.example !== undefined ? { example: param.example } : {}),
  };
}

function parameters(op: Operation): Json[] {
  const list: Json[] = [];
  for (const [name, schema] of Object.entries(op.pathParams ?? {})) {
    const { description, ...rest } = schema;
    list.push(parameter(name, 'path', { schema: rest, description: description as string | undefined }));
  }
  if (op.include) {
    list.push(
      parameter('include', 'query', {
        description: `Comma-separated related resources to include: ${op.include.paths.map((p) => `\`${p}\``).join(', ')}. Default: ${
          op.include.default.length ? op.include.default.map((p) => `\`${p}\``).join(', ') : 'none'
        }. An empty value includes nothing.`,
        schema: { type: 'string' },
      }),
    );
  }
  if (op.page) {
    list.push(parameter('page[number]', 'query', { description: 'Page, 1-based.', schema: { type: 'integer', minimum: 1, default: 1 } }));
    list.push(
      parameter('page[size]', 'query', {
        description: 'Resources per page.',
        schema: { type: 'integer', minimum: 1, maximum: op.page.maxSize, default: op.page.defaultSize },
      }),
    );
  }
  for (const f of op.filters ?? []) list.push(parameter(`filter[${f.name}]`, 'query', f));
  for (const q of op.query ?? []) list.push(parameter(q.name, 'query', q));
  return list;
}

/** Relationship names ending in "s" are to-many (`services`), others to-one (`group`). */
function relationshipSchema(name: string, type: string): Json {
  const identifier = { type: 'object', properties: { type: { const: type }, id: { type: 'string' } }, required: ['type', 'id'] };
  const data = name.endsWith('s') ? { type: 'array', items: identifier } : { anyOf: [identifier, { type: 'null' }] };
  return { type: 'object', properties: { data }, required: ['data'] };
}

function requestBody(request: RequestBody, schemaName: (name: string, partial: boolean) => string): Json {
  switch (request.kind) {
    case 'resource': {
      const data: Json = {
        type: 'object',
        properties: {
          type: request.enforced === false ? { type: 'string', examples: [request.type] } : { const: request.type },
          ...(request.allowId ? { id: { type: 'string', description: 'Must match the id in the URL.' } } : {}),
          attributes: ref('schemas', schemaName(request.schema, Boolean(request.partial))),
          ...(request.relationships
            ? {
                relationships: {
                  type: 'object',
                  description: 'The server also accepts the foreign keys as attributes (`groupId`, `locationIds`, `serviceIds`).',
                  properties: Object.fromEntries(Object.entries(request.relationships).map(([name, type]) => [name, relationshipSchema(name, type)])),
                  additionalProperties: false,
                },
              }
            : {}),
        },
        required: ['type'],
      };
      return {
        required: true,
        content: {
          [JSONAPI_MEDIA_TYPE]: {
            schema: { type: 'object', properties: { data }, required: ['data'] },
            ...(request.example ? { example: request.example } : {}),
          },
        },
      };
    }
    case 'native': {
      const schema = request.schema ? ref('schemas', schemaName(request.schema, false)) : { type: 'object' };
      return {
        description: request.description,
        required: request.required ?? true,
        content: Object.fromEntries(
          request.contentTypes.map((type) => [type, { schema, ...(request.example !== undefined && type === 'application/json' ? { example: request.example } : {}) }]),
        ),
      };
    }
    case 'binary':
      return {
        description: request.description,
        required: true,
        content: { [request.contentType]: { schema: { type: 'string', contentMediaType: request.contentType } } },
      };
  }
}

/** `{ data: { type: <type> } }` on top of a document schema. */
const typedData = (document: string, data: Json): Json => ({
  allOf: [ref('schemas', document), { type: 'object', properties: { data } }],
});

const attributesNote = (name?: string) => (name ? ` Attributes: \`${name}\` (packages/shared/src/schemas.ts).` : '');

function successResponses(response: ResponseSpec): Record<string, Json> {
  switch (response.kind) {
    case 'resource': {
      const status = response.status ?? 200;
      const content = {
        [JSONAPI_MEDIA_TYPE]: {
          schema: typedData('ResourceDocument', { type: 'object', properties: { type: { const: response.type } } }),
          ...(response.example !== undefined ? { example: response.example } : {}),
        },
      };
      return {
        ...(response.existing && status !== 200 ? { '200': { description: response.existing + attributesNote(response.attributes), content } } : {}),
        [String(status)]: {
          description: response.description + attributesNote(response.attributes),
          ...(status === 201 || status === 202 ? { headers: { Location: { description: 'URL of the resource.', schema: { type: 'string' } } } } : {}),
          content,
        },
      };
    }
    case 'collection':
      return {
        '200': {
          description: response.description + attributesNote(response.attributes),
          content: {
            [JSONAPI_MEDIA_TYPE]: {
              schema: typedData('CollectionDocument', {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { type: response.types.length === 1 ? { const: response.types[0] } : { enum: response.types } },
                },
              }),
            },
          },
        },
      };
    case 'meta':
      return {
        [String(response.status ?? 200)]: {
          description: response.description,
          content: {
            [JSONAPI_MEDIA_TYPE]: {
              schema: response.meta
                ? { allOf: [ref('schemas', 'MetaDocument'), { type: 'object', properties: { meta: response.meta } }] }
                : ref('schemas', 'MetaDocument'),
              ...(response.example !== undefined ? { example: response.example } : {}),
            },
          },
        },
      };
    case 'noContent':
      return { '204': { description: response.description } };
    case 'redirect':
      return {
        [String(response.status)]: {
          description: response.description,
          headers: { Location: { description: 'Where to go.', schema: { type: 'string' } } },
        },
      };
    case 'other':
      return {
        '200': {
          description: response.description,
          ...(response.notModified ? { headers: { ETag: { description: 'Validator for `If-None-Match`.', schema: { type: 'string' } } } } : {}),
          content: Object.fromEntries(
            response.contentTypes.map((type) => [
              type,
              { schema: response.schema ?? { type: 'string' }, ...(response.example !== undefined ? { example: response.example } : {}) },
            ]),
          ),
        },
        ...(response.notModified ? { '304': { description: 'Not modified (`If-None-Match` matched the `ETag`).' } } : {}),
      };
  }
}

function describe(op: Operation): string | undefined {
  const notes: string[] = [];
  if (op.description) notes.push(op.description);
  if (op.access === 'admin') notes.push('**Admin only** (role `admin`).');
  if (op.access === 'editor') notes.push('Role `editor` or `admin`.');
  if (op.access === 'session') notes.push('Signed-in person only (session cookie; API tokens are refused).');
  if (op.rateLimit) notes.push(`Rate limit: ${op.rateLimit.max} requests per minute and ${op.rateLimit.per}.`);
  if (op.access === 'privatePageToken') notes.push('Rate limited per client, shared with the private pages themselves.');
  if (op.bodyLimit) notes.push(`Bodies up to ${Math.round(op.bodyLimit / 1024 / 1024)} MiB.`);
  return notes.length ? notes.join('\n\n') : undefined;
}

function operationObject(op: Operation, scope: OpenApiScope, schemaName: (name: string, partial: boolean) => string): Json {
  const params = parameters(op);
  const sec = security(op, scope);
  const responses: Record<string, Json> = { ...successResponses(op.response) };
  for (const status of errorStatuses(op)) responses[String(status)] = ref('responses', ERRORS[status]!.name);
  const description = describe(op);
  return {
    operationId: operationId(op),
    tags: [op.tag],
    summary: op.summary,
    ...(description ? { description } : {}),
    ...(params.length ? { parameters: params } : {}),
    ...(op.request ? { requestBody: requestBody(op.request, schemaName) } : {}),
    responses,
    ...(sec ? { security: sec } : {}),
    ...(op.access === 'admin' || op.access === 'editor' ? { 'x-required-role': op.access } : {}),
    ...(op.rateLimit ? { 'x-rate-limit': { max: op.rateLimit.max, window: op.rateLimit.window, per: op.rateLimit.per } } : {}),
    ...(op.jsonapi === false ? { 'x-jsonapi': false } : {}),
  };
}

// ---------------------------------------------------------------------------- document

const DESCRIPTION = {
  full: [
    'HTTP API of OpenStatusPage, a self-hosted status page. Follows [JSON:API 1.1](https://jsonapi.org/format/1.1/): every JSON:API answer is `application/vnd.api+json` with `"jsonapi": { "version": "1.1" }`; request bodies must use that media type. A few endpoints keep other formats (health, feeds, images, OIDC redirects) and say so.',
    'Errors are always JSON:API error documents. Collections take `page[number]`/`page[size]` and the `filter[...]` parameters listed per operation; `include` only where listed; `sort` nowhere (`400`). Ids are generated by the server.',
    'Authentication: the management API takes the session cookie (with `X-Requested-With: openstatuspage` on mutating requests) or an API token (`Authorization: Bearer osp_…`). Operations list the role they need (`x-required-role`).',
    'The reference with examples is docs/api.md in the repository.',
  ].join('\n\n'),
  public: [
    'The public part of the HTTP API of OpenStatusPage: the read API of the status page, private pages, subscriptions, feeds and images. Follows [JSON:API 1.1](https://jsonapi.org/format/1.1/); errors are always JSON:API error documents.',
    'Signed-in users of the management UI get the whole API description from the same URL on a management instance.',
  ].join('\n\n'),
};

export interface OpenApiDocument extends Json {
  openapi: string;
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json>; responses: Record<string, Json>; securitySchemes: Record<string, Json> };
}

export function operationsFor(scope: OpenApiScope): Operation[] {
  return OPERATIONS.filter((op) => scope === 'full' || isPublicOperation(op));
}

export function buildOpenApiDocument(scope: OpenApiScope = 'full'): OpenApiDocument {
  const operations = operationsFor(scope);
  const schemas: Record<string, Json> = { ...JSONAPI_SCHEMAS };
  const converted = new Map<string, Json>();
  const schemaName = (name: string, isPartial: boolean): string => {
    const zodSchema = SCHEMAS[name];
    if (!zodSchema) throw new Error(`Unknown schema ${name}`);
    let json = converted.get(name);
    if (!json) {
      json = toJsonSchema(zodSchema);
      converted.set(name, json);
    }
    const key = isPartial ? `${name}Partial` : name;
    schemas[key] ??= isPartial ? { ...partial(json), description: `${name} with every attribute optional (partial update).` } : json;
    return key;
  };

  const paths: Record<string, Record<string, Json>> = {};
  for (const op of operations) {
    const path = openApiPath(op.path);
    (paths[path] ??= {})[op.method.toLowerCase()] = operationObject(op, scope, schemaName);
  }

  const usedTags = new Set(operations.map((op) => op.tag));
  const usedStatuses = new Set(operations.flatMap(errorStatuses));
  const usedSchemes = new Set(operations.flatMap((op) => (security(op, scope) ?? []).flatMap((s) => Object.keys(s))));

  const doc: OpenApiDocument = {
    openapi: '3.1.1',
    info: {
      title: scope === 'full' ? 'OpenStatusPage API' : 'OpenStatusPage public API',
      version: API_DESCRIPTION_VERSION,
      description: DESCRIPTION[scope],
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    servers: [{ url: '/', description: 'This instance' }],
    tags: TAGS.filter((t) => usedTags.has(t.name)).map((t) => ({ name: t.name, description: t.description })),
    paths,
    components: {
      schemas: {},
      responses: Object.fromEntries(
        Object.keys(ERRORS)
          .map(Number)
          .filter((status) => usedStatuses.has(status))
          .map((status) => [ERRORS[status]!.name, errorResponse(status)]),
      ),
      securitySchemes: Object.fromEntries(Object.entries(SECURITY_SCHEMES).filter(([name]) => usedSchemes.has(name))),
    },
  };
  // Only the schemas something refers to, in a stable order.
  const used = referencedSchemas(doc, schemas);
  doc.components.schemas = Object.fromEntries([...used].sort().map((name) => [name, schemas[name]!]));
  return doc;
}

/** Names of the component schemas `doc` refers to, directly or through other schemas. */
function referencedSchemas(doc: Json, schemas: Record<string, Json>): Set<string> {
  const used = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string' && child.startsWith('#/components/schemas/')) {
        const name = child.slice('#/components/schemas/'.length);
        if (!used.has(name)) {
          used.add(name);
          visit(schemas[name]);
        }
      } else visit(child);
    }
  };
  visit(doc);
  return used;
}

/** Levels written one member per line in docs/openapi.json; deeper values stay on one line. */
const SERIALIZED_LEVELS = 5;

/**
 * The committed form (docs/openapi.json): two-space indentation down to the
 * entries of an operation field (document → paths → path → method → field →
 * entry), one line per value below that, and a final newline. Diffs stay
 * readable per operation at about half the size of a fully indented file.
 */
export function serializeOpenApiDocument(doc: OpenApiDocument): string {
  return `${layout(doc, 0)}\n`;
}

function layout(value: unknown, depth: number): string {
  const isArray = Array.isArray(value);
  const entries: [string, unknown][] =
    typeof value === 'object' && value !== null ? (isArray ? value.map((v, i) => [String(i), v]) : Object.entries(value)) : [];
  if (depth >= SERIALIZED_LEVELS || entries.length === 0) return JSON.stringify(value);
  const pad = '  '.repeat(depth + 1);
  const lines = entries.map(([key, child]) => `${pad}${isArray ? '' : `${JSON.stringify(key)}: `}${layout(child, depth + 1)}`);
  return `${isArray ? '[' : '{'}\n${lines.join(',\n')}\n${'  '.repeat(depth)}${isArray ? ']' : '}'}`;
}

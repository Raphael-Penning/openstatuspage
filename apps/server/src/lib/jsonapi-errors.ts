/**
 * Maps every error a request can end with to JSON:API error objects:
 * HttpError (app errors), ZodError (validation of plain inputs), Fastify
 * validation/content-type/body errors, rate limiting and unexpected errors.
 */
import { STATUS_CODES } from 'node:http';
import { relationshipNameForKey, type ErrorObject, type ErrorSource } from '@openstatuspage/shared';
import { ZodError } from 'zod';
import { HttpError } from './errors.js';

export interface MappedError {
  status: number;
  errors: ErrorObject[];
}

const escapePointer = (segment: PropertyKey) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * JSON Pointer into the request document for a path of the flattened input:
 * ["name"] → "/data/attributes/name", [] → "/data". Keys that came from a
 * relationship of the request (`relationships` holds its names) point there:
 * ["serviceIds", 2] → "/data/relationships/services/data/2", ["groupId"] → "/data/relationships/group".
 */
export function pointerFor(path: readonly PropertyKey[], relationships?: ReadonlySet<string>): string {
  if (path.length === 0) return '/data';
  const [first, ...rest] = path;
  const rel = typeof first === 'string' ? relationshipNameForKey(first) : null;
  if (rel && relationships?.has(rel.name) && (rel.many ? rest.length <= 1 : rest.length === 0)) {
    return `/data/relationships/${escapePointer(rel.name)}${rest.length ? `/data/${escapePointer(rest[0]!)}` : ''}`;
  }
  return `/data/attributes/${path.map(escapePointer).join('/')}`;
}

export const statusTitle = (status: number): string => STATUS_CODES[status] ?? 'Error';

interface IssueLike {
  path?: readonly PropertyKey[];
  message?: string;
  code?: string;
  [key: string]: unknown;
}

function isIssueList(value: unknown): value is IssueLike[] {
  return Array.isArray(value) && value.every((i) => typeof i === 'object' && i !== null);
}

/** Issue details that go to `meta` (everything except path/message/code/input). */
function issueMeta(issue: IssueLike): Record<string, unknown> | undefined {
  const { path: _p, message: _m, code: _c, input: _i, ...rest } = issue;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** One error per issue. Issues with a path point into the request body. */
export function issuesToErrors(
  status: number,
  code: string,
  issues: IssueLike[],
  fallbackDetail: string,
  relationships?: ReadonlySet<string>,
): ErrorObject[] {
  if (issues.length === 0) return [{ status: String(status), code, title: statusTitle(status), detail: fallbackDetail }];
  return issues.map((issue) => {
    const error: ErrorObject = {
      status: String(status),
      code: issue.code ?? code,
      title: status === 400 ? 'Invalid request' : statusTitle(status),
      detail: issue.message ?? fallbackDetail,
    };
    if (Array.isArray(issue.path)) error.source = { pointer: pointerFor(issue.path, relationships) };
    const meta = issueMeta(issue);
    if (meta) error.meta = meta;
    return error;
  });
}

interface FastifyLikeError {
  statusCode?: number;
  code?: string;
  message?: string;
  validation?: { instancePath?: string; message?: string; params?: Record<string, unknown> }[];
  validationContext?: string;
}

function fastifyValidationErrors(err: FastifyLikeError, relationships?: ReadonlySet<string>): ErrorObject[] {
  return (err.validation ?? []).map((v) => {
    const segments = (v.instancePath ?? '').split('/').filter(Boolean);
    const missing = typeof v.params?.missingProperty === 'string' ? v.params.missingProperty : undefined;
    if (missing) segments.push(missing);
    let source: ErrorSource;
    if (err.validationContext === 'querystring') source = { parameter: segments[0] ?? '' };
    else if (err.validationContext === 'headers') source = { header: segments[0] ?? '' };
    else if (err.validationContext === 'params') source = { parameter: segments[0] ?? '' };
    else source = { pointer: pointerFor(segments, relationships) };
    return {
      status: '400',
      code: 'validation_error',
      title: 'Invalid request',
      detail: v.message ?? 'Invalid value',
      source,
    };
  });
}

/**
 * Fastify body/content-type errors with stable codes and neutral details (the
 * framework's own codes and messages name internals and the wrong media type).
 */
const FASTIFY_ERRORS: Record<string, { status: number; code: string; detail: string }> = {
  FST_ERR_CTP_INVALID_JSON_BODY: { status: 400, code: 'invalid_json', detail: 'The request body is not valid JSON' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: 'empty_body', detail: 'The request body is empty' },
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'payload_too_large', detail: 'The request body is too large' },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: {
    status: 400,
    code: 'invalid_content_length',
    detail: 'The Content-Length header does not match the request body',
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: 'unsupported_media_type', detail: 'Unsupported Content-Type' },
  FST_ERR_CTP_EMPTY_TYPE: { status: 415, code: 'unsupported_media_type', detail: 'The Content-Type header is empty' },
  FST_ERR_CTP_INVALID_TYPE: { status: 415, code: 'unsupported_media_type', detail: 'Unsupported Content-Type' },
};

/**
 * Maps any thrown value to a status code and JSON:API error objects.
 * `relationships`: names of the relationships in the request document (for pointers).
 */
export function mapError(err: unknown, relationships?: ReadonlySet<string>): MappedError {
  if (err instanceof HttpError) {
    const status = err.statusCode;
    if (isIssueList(err.issues) && err.issues.length > 0) {
      return { status, errors: issuesToErrors(status, err.code, err.issues, err.message, relationships) };
    }
    const error: ErrorObject = { status: String(status), code: err.code, title: statusTitle(status), detail: err.message };
    if (err.source) error.source = err.source;
    const meta = err.issues !== undefined ? { ...err.meta, issues: err.issues } : err.meta;
    if (meta) error.meta = meta;
    return { status, errors: [error] };
  }
  if (err instanceof ZodError) {
    return { status: 400, errors: issuesToErrors(400, 'validation_error', err.issues as unknown as IssueLike[], 'Invalid request', relationships) };
  }
  const e = (err ?? {}) as FastifyLikeError;
  if (Array.isArray(e.validation)) return { status: 400, errors: fastifyValidationErrors(e, relationships) };
  const known = typeof e.code === 'string' ? FASTIFY_ERRORS[e.code] : undefined;
  if (known) {
    const error: ErrorObject = { status: String(known.status), code: known.code, title: statusTitle(known.status), detail: known.detail };
    if (known.status === 415) error.source = { header: 'Content-Type' };
    return { status: known.status, errors: [error] };
  }
  const status = typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
  if (status >= 500) {
    return {
      status,
      errors: [{ status: String(status), code: 'internal_error', title: statusTitle(status), detail: 'Internal server error' }],
    };
  }
  const code =
    status === 429 ? 'rate_limited' : typeof e.code === 'string' && e.code ? e.code.toLowerCase() : 'request_error';
  return { status, errors: [{ status: String(status), code, title: statusTitle(status), detail: e.message ?? statusTitle(status) }] };
}

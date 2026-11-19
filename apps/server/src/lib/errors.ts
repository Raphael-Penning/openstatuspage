import type { ErrorSource } from '@openstatuspage/shared';

export interface HttpErrorOptions {
  /** Where the problem is in the request (JSON:API `source`). */
  source?: ErrorSource;
  /** Extra, non-standard details (JSON:API `meta`). */
  meta?: Record<string, unknown>;
}

/** Error with an HTTP status code. Thrown from services, mapped by the error handler. */
export class HttpError extends Error {
  public readonly source?: ErrorSource;
  public readonly meta?: Record<string, unknown>;

  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    /** Issues (zod-like `{ path, message, ... }`); each becomes one JSON:API error. */
    public readonly issues?: unknown,
    options: HttpErrorOptions = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.source = options.source;
    this.meta = options.meta;
  }
}

export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, issues?: unknown) =>
  new HttpError(400, 'bad_request', message, issues);
/** 400 for a bad query parameter (JSON:API `source.parameter`). */
export const invalidParameter = (parameter: string, message: string, code = 'invalid_parameter') =>
  new HttpError(400, code, message, undefined, { source: { parameter } });
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Insufficient permissions') => new HttpError(403, 'forbidden', message);

/** Whether a database error is a unique constraint violation (PostgreSQL 23505, SQLite UNIQUE). */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === '23505' || e.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  return typeof e.message === 'string' && e.message.includes('UNIQUE constraint failed');
}

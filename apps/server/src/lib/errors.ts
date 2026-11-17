/** Error with an HTTP status code. Thrown from services, mapped by the error handler. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, issues?: unknown) =>
  new HttpError(400, 'bad_request', message, issues);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Insufficient permissions') => new HttpError(403, 'forbidden', message);

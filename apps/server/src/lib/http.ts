/**
 * Small helpers shared by route modules: request parsing (JSON:API pagination,
 * filters and sorting live in jsonapi-query.ts).
 */
import { zId } from '@openstatuspage/shared';
import { z } from 'zod';

/** `:id` route parameter. */
export const IdParams = z.object({ id: zId });

/** Query string boolean (`true`/`1`/`yes`). */
export const zQueryBool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

/** Parses `data` with `schema`; a ZodError is turned into a 400 by the error handler. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  return schema.parse(data ?? {});
}

/** Removes duplicates while keeping the first occurrence order. */
export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

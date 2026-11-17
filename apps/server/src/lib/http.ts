/**
 * Small helpers shared by route modules: request parsing and pagination.
 */
import { zId, type Paginated } from '@openstatuspage/shared';
import { z } from 'zod';

/** `:id` route parameter. */
export const IdParams = z.object({ id: zId });

/** `page` / `pageSize` query parameters (1-based, max 100 per page). */
export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof PageQuery>;

/** Query string boolean (`true`/`1`/`yes`). */
export const zQueryBool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

/** Parses `data` with `schema`; a ZodError is turned into a 400 by the error handler. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  return schema.parse(data ?? {});
}

export function offsetOf(q: PageQuery): number {
  return (q.page - 1) * q.pageSize;
}

export function paginated<T>(items: T[], total: number, q: PageQuery): Paginated<T> {
  return { items, total, page: q.page, pageSize: q.pageSize };
}

/** Removes duplicates while keeping the first occurrence order. */
export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

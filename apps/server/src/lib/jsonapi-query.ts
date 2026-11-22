/**
 * JSON:API query parameters: `page[number]`/`page[size]`, `filter[name]`, `sort`
 * and `include`. Invalid values are answered with 400 and `source.parameter`.
 *
 *   const q = parseListQuery(req.query, {
 *     filter: { type: z.enum(['incident', 'maintenance']).optional() },
 *     sort: { allowed: ['date', 'title'], default: ['-date'] },
 *     include: { allowed: ['updates'], default: ['updates'] },
 *   });
 *   q.page.offset; q.filter.type; q.sort; q.include.has('updates');
 */
import { z } from 'zod';
import { invalidParameter } from './errors.js';
import type { PageParams } from './jsonapi.js';

type Query = Record<string, unknown>;

/**
 * Reads `name[key]` parameters (flat keys as Fastify parses them, or a nested object)
 * into an object without prototype, so `filter[constructor]` or `filter[__proto__]`
 * are plain keys like any other.
 */
function family(query: Query, name: string): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  const nested = query[name];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) Object.assign(out, nested);
  const prefix = `${name}[`;
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith(prefix) && key.endsWith(']')) out[key.slice(prefix.length, -1)] = value;
  }
  return out;
}

function single(parameter: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalidParameter(parameter, `${parameter} must be given once`);
  return value;
}

export interface PageOptions {
  defaultSize?: number;
  maxSize?: number;
}

export interface PageQuery extends PageParams {
  /** Rows to skip: (number - 1) * size. */
  offset: number;
}

/** `page[number]` (1-based, default 1) and `page[size]` (default 20, max 100). */
export function parsePage(query: Query, options: PageOptions = {}): PageQuery {
  const { defaultSize = 20, maxSize = 100 } = options;
  const page = family(query, 'page');
  const read = (key: string, fallback: number, max: number): number => {
    const parameter = `page[${key}]`;
    const raw = single(parameter, page[key]);
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(raw)) throw invalidParameter(parameter, `${parameter} must be a positive integer`);
    const n = Number(raw);
    if (n < 1 || n > max) throw invalidParameter(parameter, `${parameter} must be between 1 and ${max}`);
    return n;
  };
  const number = read('number', 1, 1_000_000);
  const size = read('size', defaultSize, maxSize);
  return { number, size, offset: (number - 1) * size };
}

/**
 * `filter[name]` parameters validated by a zod shape. Unknown filter names are rejected.
 * Values arrive as strings; use z.coerce / z.enum / zQueryBool in the shape.
 */
export function parseFilter<S extends z.ZodRawShape>(query: Query, shape: S): z.output<z.ZodObject<S>> {
  const values = family(query, 'filter');
  for (const name of Object.keys(values)) {
    // Own names only: inherited ones (constructor, toString) are unknown filters too.
    if (!Object.hasOwn(shape, name)) throw invalidParameter(`filter[${name}]`, `Unknown filter "${name}"`);
  }
  const result = z.object(shape).safeParse(values);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const name = String(issue.path[0] ?? '');
    throw invalidParameter(name ? `filter[${name}]` : 'filter', issue.message);
  }
  return result.data;
}

export interface SortField {
  field: string;
  desc: boolean;
}

/** `sort=-date,title` → [{ field: 'date', desc: true }, { field: 'title', desc: false }]. */
export function parseSort(query: Query, allowed: readonly string[], fallback: readonly string[] = []): SortField[] {
  const raw = single('sort', query.sort);
  const list = raw === undefined || raw === '' ? fallback : raw.split(',');
  return list.map((entry) => {
    const desc = entry.startsWith('-');
    const field = desc ? entry.slice(1) : entry;
    if (!allowed.includes(field)) throw invalidParameter('sort', `Sorting by "${field}" is not supported`, 'unsupported_sort');
    return { field, desc };
  });
}

/**
 * `include=updates,services` → Set. Without the parameter the defaults are included
 * (the spec allows that); with it exactly the requested paths. Unsupported paths → 400.
 */
export function parseInclude(query: Query, allowed: readonly string[], fallback: readonly string[] = []): Set<string> {
  const raw = single('include', query.include);
  if (raw === undefined) return new Set(fallback);
  const paths = raw.split(',').filter((p) => p !== '');
  for (const path of paths) {
    if (!allowed.includes(path)) {
      throw invalidParameter('include', `Including "${path}" is not supported`, 'unsupported_include');
    }
  }
  return new Set(paths);
}

export interface ListQueryOptions<S extends z.ZodRawShape> {
  page?: PageOptions;
  filter?: S;
  sort?: { allowed: readonly string[]; default?: readonly string[] };
  include?: { allowed: readonly string[]; default?: readonly string[] };
}

export interface ListQuery<F> {
  page: PageQuery;
  filter: F;
  sort: SortField[];
  include: Set<string>;
}

/** All list parameters at once. Filters/sort/include not configured are rejected when given. */
export function parseListQuery<S extends z.ZodRawShape = Record<never, never>>(
  query: unknown,
  options: ListQueryOptions<S> = {},
): ListQuery<z.output<z.ZodObject<S>>> {
  const q = (query ?? {}) as Query;
  return {
    page: parsePage(q, options.page),
    filter: parseFilter(q, options.filter ?? ({} as S)),
    sort: parseSort(q, options.sort?.allowed ?? [], options.sort?.default),
    include: parseInclude(q, options.include?.allowed ?? [], options.include?.default),
  };
}

/**
 * Maps zod issues (from client-side safeParse or a server 400 response) to
 * field-level error messages. Pure and framework independent.
 */

/** The subset of a zod issue the UI relies on (works for client and server issues). */
export interface IssueLike {
  code?: string;
  path?: readonly PropertyKey[];
  message?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  origin?: string;
  format?: string;
  expected?: string;
  input?: unknown;
}

/** i18n key (in the admin namespace) plus interpolation values. */
export interface ErrorMessage {
  key: string;
  values?: Record<string, unknown>;
}

/** Field path -> message. Paths are dot-joined ("config.baseUrl", "checks.0.checkId"). */
export type FieldErrors = Record<string, ErrorMessage>;

export function pathKey(path: readonly PropertyKey[] | undefined): string {
  return (path ?? []).map((p) => String(p)).join('.');
}

function isIssue(value: unknown): value is IssueLike {
  return typeof value === 'object' && value !== null && ('path' in value || 'code' in value);
}

/** Translates one issue into a localizable message. */
export function issueMessage(issue: IssueLike): ErrorMessage {
  switch (issue.code) {
    case 'too_small':
      if (issue.origin === 'string' && Number(issue.minimum) <= 1) return { key: 'validation.required' };
      if (issue.origin === 'string') return { key: 'validation.minLength', values: { min: Number(issue.minimum) } };
      if (issue.origin === 'array') return { key: 'validation.minItems', values: { min: Number(issue.minimum) } };
      return { key: 'validation.min', values: { min: Number(issue.minimum) } };
    case 'too_big':
      if (issue.origin === 'string') return { key: 'validation.maxLength', values: { max: Number(issue.maximum) } };
      if (issue.origin === 'array') return { key: 'validation.maxItems', values: { max: Number(issue.maximum) } };
      return { key: 'validation.max', values: { max: Number(issue.maximum) } };
    case 'invalid_format':
      if (issue.format === 'email') return { key: 'validation.email' };
      if (issue.format === 'url') return { key: 'validation.url' };
      if (issue.format === 'datetime') return { key: 'validation.datetime' };
      return { key: 'validation.format' };
    case 'invalid_type':
      if (issue.input === undefined || issue.input === null || /received (undefined|null)/.test(issue.message ?? '')) {
        return { key: 'validation.required' };
      }
      if (issue.expected === 'number') return { key: 'validation.number' };
      return { key: 'validation.invalid' };
    case 'invalid_value':
      return { key: 'validation.invalid' };
    case 'custom':
      if (pathKey(issue.path) === 'scheduledEnd') return { key: 'validation.endAfterStart' };
      if (pathKey(issue.path) === 'endsAt') {
        return /days/.test(issue.message ?? '') ? { key: 'validation.rangeTooLong' } : { key: 'validation.endAfterStart' };
      }
      return { key: 'validation.invalid' };
    default:
      return { key: 'validation.invalid' };
  }
}

/**
 * Converts issues into field errors. Only the first issue per field is kept.
 * Issues without a path are stored under "" (form-level error).
 */
export function issuesToFieldErrors(issues: unknown): FieldErrors {
  const out: FieldErrors = {};
  if (!Array.isArray(issues)) return out;
  for (const raw of issues) {
    if (!isIssue(raw)) continue;
    const key = pathKey(raw.path);
    if (!(key in out)) out[key] = issueMessage(raw);
  }
  return out;
}

/** Returns the error for `field` or for the closest nested path below it (e.g. "config" -> "config.baseUrl"). */
export function errorFor(errors: FieldErrors, field: string): ErrorMessage | undefined {
  if (errors[field]) return errors[field];
  const prefix = `${field}.`;
  for (const [k, v] of Object.entries(errors)) if (k.startsWith(prefix)) return v;
  return undefined;
}

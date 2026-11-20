/**
 * Shared parts of the HTML form handlers (forms/*.ts): the form body, the
 * cross-site check, local return paths and the preference cookies.
 *
 * The forms post application/x-www-form-urlencoded to paths outside /api, so
 * the JSON:API stays JSON:API and every public page works without JavaScript.
 * They carry no cookie that could be abused (the subscription token travels in
 * the form), but a cross-site page could still make a visitor's browser post:
 * browsers say where a request comes from (Sec-Fetch-Site, Origin), and every
 * form handler rejects what does not come from this site.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Fields of a form body: every value of a name, in order. */
export type FormFields = Map<string, string[]>;

/** Largest form body (a long service selection is far below). */
export const FORM_BODY_LIMIT = 64 * 1024;

/** Parses form-urlencoded bodies into FormFields (scope of the form routes only). */
export function registerFormBody(scope: FastifyInstance): void {
  scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: FORM_BODY_LIMIT }, (_req, body, done) => {
    const fields: FormFields = new Map();
    for (const [name, value] of new URLSearchParams(body as string)) {
      const list = fields.get(name);
      if (list) list.push(value);
      else fields.set(name, [value]);
    }
    done(null, fields);
  });
}

/** The parsed body of a form request (empty for any other content type). */
export function formFields(req: FastifyRequest): FormFields {
  return req.body instanceof Map ? (req.body as FormFields) : new Map();
}

export const field = (fields: FormFields, name: string): string => fields.get(name)?.[0] ?? '';
export const fieldList = (fields: FormFields, name: string, max = 500): string[] => (fields.get(name) ?? []).slice(0, max);

function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Whether a request comes from another site. Browsers send Sec-Fetch-Site (all
 * current ones) or at least Origin on a form post; only this site's own pages
 * (same origin, or the origin of PUBLIC_BASE_URL behind a proxy) pass. A request
 * without either header does not come from a browser page and cannot be forged
 * through one.
 */
export function isCrossSite(req: FastifyRequest, publicBaseUrl: string): boolean {
  const site = header(req, 'sec-fetch-site');
  if (site) return site !== 'same-origin';
  const origin = header(req, 'origin');
  if (origin === undefined) return false;
  const allowed = new Set([`${req.protocol}://${req.host}`]);
  try {
    allowed.add(new URL(publicBaseUrl).origin);
  } catch {
    // no usable base URL: the request's own origin only
  }
  return !allowed.has(origin);
}

/** 403 page for a rejected cross-site form post. */
export function rejectCrossSite(reply: FastifyReply): FastifyReply {
  return reply
    .status(403)
    .header('Cache-Control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(
      '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<meta name="robots" content="noindex"><title>Form rejected</title>' +
        '<main><h1>Form rejected</h1><p>This form was sent from another website, so it was not processed. ' +
        'Open the page on this site and send the form again.</p><p><a href="/">Back to the status page</a></p></main></html>',
    );
}

/**
 * A path on this site to send the visitor back to: starts with one slash and
 * has no scheme, host or control characters (no open redirect). Anything else is "/".
 */
export function localPath(value: string | undefined): string {
  if (!value || value.length > 2048) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return '/';
  return value;
}

const YEAR_SECONDS = 365 * 24 * 60 * 60;

/** Preference cookie (language, theme) as the browser writes it (apps/web/src/lib/languages.ts). */
export function preferenceCookie(req: FastifyRequest, name: string, value: string): string {
  const secure = req.protocol === 'https' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${YEAR_SECONDS}; SameSite=Lax${secure}`;
}

/** Removes a preference cookie (the attributes match {@link preferenceCookie}). */
export function clearPreferenceCookie(req: FastifyRequest, name: string): string {
  const secure = req.protocol === 'https' ? '; Secure' : '';
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

/** Post/Redirect/Get: 303 to a page of this site; never stored by caches. */
export function seeOther(reply: FastifyReply, location: string): FastifyReply {
  return reply.header('Cache-Control', 'no-store').redirect(location, 303);
}

/** `path` with query parameters (undefined values are left out). */
export function withQuery(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, v);
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

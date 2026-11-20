/**
 * Visitor preferences without JavaScript (the header controls of the public
 * pages are plain links and forms; with JavaScript the browser sets the same
 * cookies itself and skips these requests):
 *
 *   POST /preferences/theme      theme=system|light|dark&return=/path   → cookie osp-theme, 303 back
 *   GET  /preferences/language?lang=de&return=/path                      → cookie osp-lang, 303 back
 *
 * The language is a link (one per language), so it is a GET; it only sets a
 * cookie and never answers with content. Requests from other sites are sent
 * back without a cookie (nobody can switch a visitor's language from outside).
 */
import { FORM_PATHS, LANG_COOKIE, PAGE_LANGUAGES, RETURN_QUERY, THEME_COOKIE } from '@openstatuspage/shared';
import type { FastifyInstance } from 'fastify';
import { field, formFields, isCrossSite, localPath, preferenceCookie, rejectCrossSite, seeOther } from './http.js';

const THEMES = new Set(['system', 'light', 'dark']);
const LANGUAGES = new Set<string>(PAGE_LANGUAGES);

export function registerPreferenceForms(scope: FastifyInstance): void {
  const { config } = scope.ctx;

  scope.post(FORM_PATHS.theme, async (req, reply) => {
    if (isCrossSite(req, config.PUBLIC_BASE_URL)) return rejectCrossSite(reply);
    const fields = formFields(req);
    const theme = field(fields, 'theme');
    const back = localPath(field(fields, RETURN_QUERY));
    if (THEMES.has(theme)) reply.header('Set-Cookie', preferenceCookie(req, THEME_COOKIE, theme));
    return seeOther(reply, back);
  });

  scope.get(FORM_PATHS.language, async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const lang = typeof query.lang === 'string' ? query.lang : '';
    const back = localPath(typeof query[RETURN_QUERY] === 'string' ? (query[RETURN_QUERY] as string) : undefined);
    if (LANGUAGES.has(lang) && !isCrossSite(req, config.PUBLIC_BASE_URL)) {
      reply.header('Set-Cookie', preferenceCookie(req, LANG_COOKIE, lang));
    }
    // A redirect, never a page of its own: search engines keep to the pages it leads to.
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    return seeOther(reply, back);
  });
}

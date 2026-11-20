/**
 * Visitor preferences without JavaScript (the header controls of the public
 * pages are plain links and forms; with JavaScript the browser sets the same
 * cookies itself and skips these requests):
 *
 *   POST /preferences/theme      theme=system|light|dark&return=/path   → cookie osp-theme, 303 back
 *   GET  /preferences/language?lang=de&return=/path                      → cookie osp-lang, 303 back
 *   POST /preferences/language   lang=de&return=/path                       → the same
 *   POST /preferences/analytics  analytics=off|on&return=/path                → cookie osp-analytics=off (or
 *                                                                              removed), 303 back
 *
 * The language is a link (one per language), so it is a GET; it only sets a
 * cookie and never answers with content. Requests from other sites are sent
 * back without a cookie (nobody can switch a visitor's language from outside).
 * Personal pages (subscription links with a token) post the same fields
 * instead: their return path carries the token, which must not end up in a URL
 * (logs, proxies, browser history).
 *
 * The analytics choice is a form in the footer (shown when analytics is on): with
 * the cookie set, rendered pages carry no analytics script (ssr/pages.ts keeps
 * them apart in its cache). With JavaScript the footer also tells the tracker of
 * the current page to stop (localStorage `umami.disabled`) before the form posts.
 */
import { ANALYTICS_COOKIE, ANALYTICS_OFF, FORM_PATHS, LANG_COOKIE, PAGE_LANGUAGES, RETURN_QUERY, THEME_COOKIE } from '@openstatuspage/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  clearPreferenceCookie,
  field,
  formFields,
  isCrossSite,
  localPath,
  preferenceCookie,
  rejectCrossSite,
  seeOther,
} from './http.js';

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

  scope.post(FORM_PATHS.analytics, async (req, reply) => {
    if (isCrossSite(req, config.PUBLIC_BASE_URL)) return rejectCrossSite(reply);
    const fields = formFields(req);
    const choice = field(fields, 'analytics');
    if (choice === 'off') reply.header('Set-Cookie', preferenceCookie(req, ANALYTICS_COOKIE, ANALYTICS_OFF));
    else if (choice === 'on') reply.header('Set-Cookie', clearPreferenceCookie(req, ANALYTICS_COOKIE));
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    return seeOther(reply, localPath(field(fields, RETURN_QUERY)));
  });

  const setLanguage = (req: FastifyRequest, reply: FastifyReply, lang: string, back: string) => {
    if (LANGUAGES.has(lang) && !isCrossSite(req, config.PUBLIC_BASE_URL)) {
      reply.header('Set-Cookie', preferenceCookie(req, LANG_COOKIE, lang));
    }
    // A redirect, never a page of its own: search engines keep to the pages it leads to.
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    return seeOther(reply, localPath(back));
  };

  scope.get(FORM_PATHS.language, async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const text = (name: string) => (typeof query[name] === 'string' ? (query[name] as string) : '');
    return setLanguage(req, reply, text('lang'), text(RETURN_QUERY));
  });

  scope.post(FORM_PATHS.language, async (req, reply) => {
    const fields = formFields(req);
    return setLanguage(req, reply, field(fields, 'lang'), field(fields, RETURN_QUERY));
  });
}

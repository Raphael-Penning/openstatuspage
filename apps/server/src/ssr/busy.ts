/**
 * The answer of a public page when the server is too busy to render it and has
 * no earlier version of it (ssr/pages.ts): 503 with Retry-After and a tiny,
 * static page that works without JavaScript. Never stored, never indexed.
 */
import { LANG_COOKIE, LANG_QUERY, PAGE_LANGUAGES } from '@openstatuspage/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Seconds a client should wait before asking again. */
export const BUSY_RETRY_SECONDS = 5;

const TEXT = {
  en: {
    title: 'Temporarily busy',
    message: 'Many people are viewing this status page right now, so this page cannot be shown at the moment.',
    retry: 'Please try again in a few seconds.',
    link: 'Try again',
  },
  de: {
    title: 'Vorübergehend ausgelastet',
    message: 'Gerade rufen sehr viele Menschen diese Statusseite auf, deshalb kann diese Seite im Moment nicht angezeigt werden.',
    retry: 'Bitte versuche es in ein paar Sekunden erneut.',
    link: 'Erneut versuchen',
  },
} satisfies Record<(typeof PAGE_LANGUAGES)[number], Record<string, string>>;

type Lang = keyof typeof TEXT;

const isLang = (value: string | null | undefined): value is Lang => !!value && Object.hasOwn(TEXT, value);

/**
 * Language of the request in the order the pages use (`?lang=`, the language
 * cookie, the first supported Accept-Language entry), English otherwise. The
 * page default of the settings is not read: that would need the database.
 */
export function busyLanguage(url: string, cookie: string | undefined, acceptLanguage: string | undefined): Lang {
  const query = new URLSearchParams(url.split('?')[1]?.split('#')[0] ?? '').get(LANG_QUERY);
  if (isLang(query)) return query;
  const fromCookie = cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${LANG_COOKIE}=`))
    ?.slice(LANG_COOKIE.length + 1);
  if (isLang(fromCookie)) return fromCookie;
  for (const part of (acceptLanguage ?? '').split(',').slice(0, 20)) {
    const [tag = '', ...params] = part.split(';');
    if (params.some((p) => /^\s*q=0(\.0*)?\s*$/.test(p))) continue;
    const code = tag.trim().split(/[-_]/)[0]!.toLowerCase();
    if (isLang(code)) return code;
  }
  return 'en';
}

/** The page: no scripts, no external files, the system's colors in both themes. */
export function busyPage(lang: Lang): string {
  const t = TEXT[lang];
  return (
    `<!doctype html><html lang="${lang}" dir="ltr"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex">' +
    `<title>${t.title}</title>` +
    '<style>body{font-family:system-ui,sans-serif;line-height:1.5;margin:0;padding:2rem 1rem}main{max-width:36rem;margin:0 auto}</style>' +
    `</head><body><main><h1>${t.title}</h1><p>${t.message}</p><p>${t.retry}</p>` +
    // An empty href is this page (its URL is not echoed into the response).
    `<p><a href="">${t.link}</a></p></main></body></html>`
  );
}

/** Answers 503 with the busy page. */
export async function sendBusy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = (name: string) => {
    const v = req.headers[name];
    return Array.isArray(v) ? v.join(', ') : v;
  };
  const lang = busyLanguage(req.url, header('cookie'), header('accept-language'));
  await reply
    .status(503)
    .header('Retry-After', String(BUSY_RETRY_SECONDS))
    .header('Cache-Control', 'no-store')
    .header('X-Robots-Tag', 'noindex')
    .header('Vary', 'Accept-Language, Cookie')
    .type('text/html; charset=utf-8')
    .send(busyPage(lang));
}

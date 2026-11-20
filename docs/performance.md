# Performance and Lighthouse

The public status page aims for 100 in every Lighthouse category (performance,
accessibility, best practices, SEO) on mobile and desktop, and passes every
audit of the "Agentic Browsing" category. This page lists what gets it there,
how to measure it and the latest results.

## What keeps the pages fast

- **Server-side rendering** ([architecture.md](architecture.md#server-side-rendering)):
  the first paint needs no JavaScript. The largest contentful paint is text in
  the HTML, so it equals the first contentful paint.
- **Compression without runtime cost for files.** The web build writes a Brotli
  (`.br`, quality 11) and a gzip (`.gz`, level 9) copy of every compressible file
  (`apps/web/tools/precompress.ts`); the server sends the copy the browser
  accepts (`@fastify/static` with `preCompressed`, `Vary: Accept-Encoding`).
  Rendered pages are gzip-compressed once per render and kept compressed in the
  render cache, so a cached page costs no CPU per request (`ssr/pages.ts`). The
  overview shrinks from about 125 kB to 9 kB on the wire.
- **Caching.** Files in `/assets/` have a content hash in their name and are sent
  with `Cache-Control: public, max-age=31536000, immutable`; other files
  (`favicon.svg`, `world-map.svg`) for a day; pages for 10 s (`ETag`,
  `stale-while-revalidate`).
- **Little JavaScript on the critical path.** The public pages load React, React
  Router, TanStack Query, i18next and the page code (about 175 kB with gzip, less with Brotli),
  all as module preloads, so nothing blocks the first paint. Not part of it:
  the management UI and its translations (`lib/i18n-admin.ts` loads with the
  management UI), the input schemas and zod (`public/utils/schemas.ts`, loaded
  by the subscription forms after hydration) and the interactive world map
  (loaded after hydration; the server draws a static map in its place).
- **One small stylesheet** (49 kB, 9 kB compressed) and system fonts: no web
  fonts, no font swap, no layout shift from late fonts.
- **No layout shift.** Placeholders have the size of what replaces them (map,
  subscription pages before hydration). Lighthouse measures a cumulative layout
  shift of at most 0.005.

## Security headers

Pages are sent with a Content-Security-Policy (scripts only from the own origin,
no `eval`, no plugins, no `<base>`; see
[security-model.md](security-model.md#browser-security-headers)),
`Cross-Origin-Opener-Policy: same-origin`, a `Permissions-Policy` that turns off
camera, microphone, geolocation, payment and USB, `X-Content-Type-Options:
nosniff` and a `Referrer-Policy`. HSTS is left to the TLS-terminating reverse
proxy, which knows whether the site is HTTPS-only.

## Measuring

`scripts/lighthouse.mjs` runs Lighthouse (through `npx`, nothing is installed
into the repository) against a running instance and prints the scores per page
and form factor plus every audit below its full score. It needs a Chrome binary,
for example Chrome for Testing or `chrome-headless-shell`:

```bash
npx @puppeteer/browsers install chrome-headless-shell@stable --path /tmp/browsers
pnpm build
pnpm db:seed                       # fictional demo data
PUBLIC_BASE_URL=http://localhost:3000 pnpm start
CHROME_PATH=/tmp/browsers/chrome-headless-shell/<platform>-<version>/<dir>/chrome-headless-shell \
  node scripts/lighthouse.mjs --base-url http://localhost:3000
```

Options: `--preset mobile|desktop|both`, `--pages /,/services,…` (default: the
overview, services, the first service and incident from the sitemaps, history
and subscribe), `--out <dir>` for the JSON reports, `--lighthouse <version>`.
The exit code is 1 when a category is below 100 or an agentic browsing audit
fails.

Locally the server answers in a few milliseconds, so the performance score
mostly reflects the page itself: Lighthouse simulates a slow 4G connection and a
slower CPU (mobile) from the measured transfer sizes. On a real host the
server's distance to the visitor adds to the first paint.

## Results

Lighthouse 13.6.0, chrome-headless-shell 158, production build, demo seed,
`APP_ROLE=all` on SQLite (both presets, default throttling). Every page scored
100 in performance, accessibility, best practices, SEO and agentic browsing:

| Page | Mobile FCP / LCP | Desktop FCP / LCP | CLS | Transfer |
| --- | --- | --- | --- | --- |
| `/` (overview) | 0.8 s | 0.2 s | 0.002 | 170 KiB |
| `/services` | 0.8 s | 0.2 s | 0 | 169 KiB |
| `/services/cdn` | 0.8 s | 0.2 s | 0 | 168 KiB |
| `/history` | 0.8 s | 0.2 s | 0 | 170 KiB |
| `/incidents/{id}` | 0.8 s | 0.2 s | 0.005 | 170 KiB |
| `/subscribe` | 0.8 s | 0.2 s | 0 | 167 KiB |

Total blocking time was 0 ms everywhere. The same pages on `APP_ROLE=public`
(PostgreSQL, the restricted `osp_public` login) also scored 100 in every
category. Before the compression, caching and bundle changes the pages
transferred 915 KiB and the mobile first paint took 1.5 s (still a performance
score of 100, with "render-blocking requests" and "unused JavaScript" flagged).

Agentic browsing: the accessibility tree audit passes, `/llms.txt` is valid
(see [architecture.md](architecture.md#search-engines-and-ai-agents)). The WebMCP
audits and the ARD manifest audit are not applicable: the pages register no
WebMCP tools and the site publishes no ARD manifest.

What remains in the diagnostics (no effect on the scores): the stylesheet is
render-blocking (about 120 ms in the mobile simulation; inlining it would add
it to every page instead of caching it once), and Lighthouse counts about
74 KiB of the page JavaScript as unused on a single page (code of the other
pages and of the hydration path).

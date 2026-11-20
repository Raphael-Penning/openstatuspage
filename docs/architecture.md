# Architecture

```
apps/
  server/   Fastify API, status engine, monitoring adapters, background worker
  web/      React: public status page (/, server-rendered and hydrated) and management UI (/admin, SPA)
packages/
  shared/   zod schemas, API types and status vocabulary used by both apps
docker/     Dockerfile
deploy/     compose/ (Docker Compose, release assets) and kubernetes/ manifests
docs/       documentation
```

In production a single Node process serves the API, the server-rendered public
pages and the built management SPA.

## Privacy model

The core promise: **customers see services, never infrastructure.**

- Internal objects (monitoring sources, checks, hosts, outputs, credentials) are
  only readable through `/api/admin/*`.
- `/api/public/*` serializers are written explicitly per field; never return DB rows
  directly. Public responses must not reveal check counts or names.
- Monitoring credentials are encrypted at rest (AES-256-GCM, key derived from `SECRET_KEY`)
  and masked in admin responses.
- Ingest tokens and session/API tokens are stored as SHA-256 hashes only.
- Subscription tokens are not stored at all (HMAC of `SUBSCRIPTION_TOKEN_KEY`, default `SECRET_KEY`, and a salt).

## Status model

```
monitoring system ──(poll / push)──► adapter ──► IngestService ──► monitor_checks
                                                                       │
           check bundles: weighted vote of member checks ──► bundle check
           (BundleService, rules in bundle-rules.ts)          (also a monitor_check)
                                                                       │
             service_checks (link + mapping per check) ◄───────────────┘
                                │
                                ▼
 StatusEngine: monitor status (aggregation: worst | quorum)
               + manual mode / manual status
               + maintenance in progress  → "maintenance" replaces the base status
               + unresolved public incidents → worst status wins
                                │
                                ▼
         services.current_status + service_status_history (uptime bars)
                                │
                                ▼
       locations: override ?? worst status of their public services
```

Rules live in `apps/server/src/services/status-rules.ts` (pure, unit tested);
`StatusEngine` loads data and persists results. Every code path that changes an
input of a service must call `ctx.engine.recompute(serviceIds)`.

History corrections (status overrides for a past range, retroactive maintenance)
are a layer over `service_status_history`: they are applied when uptime is
computed (`services/history-corrections.ts`), never written into the history.
See [api.md](api.md#history-corrections).

Uptime bars use UTC days. A day counts only the time that was observed
(a service created today is judged by the time since its creation);
`degraded` and `maintenance` count as up.

Service status values, ordered by severity:
`operational < maintenance < degraded < partial_outage < major_outage`.

Each link between a service and a check maps the check state to a service status:
`warning → degraded`, `critical → major_outage`, `unknown → ignored` by default;
every mapping can be changed or disabled per link. This is how public services are
"built" from internal checks.

## Database

Kysely with one portable schema for SQLite and PostgreSQL:
text IDs (UUID), ISO-8601 UTC text timestamps, integer booleans, JSON as text.
Migrations are TypeScript files registered in `apps/server/src/db/migrations/index.ts`
and run automatically on start.

## Email notifications

```
admin request (incident/maintenance, notify = true)   scheduler / reminder task
                │  after the DB transaction                    │
                ▼                                              ▼
      NotificationService: recipients (confirmed; all services or an affected
      public service) → localized mail per subscriber → email_outbox (pending)
                                        │
                                        ▼
      delivery task (every 10 s, batches of 50) ──► Mailer (smtp | log | none)
          failure: retry after 1 min, 5 min, 15 min, 1 h; failed after 5 attempts
```

- Code: `apps/server/src/mail/` (transports, templates) and
  `apps/server/src/services/{notifications,subscriptions}.ts`; routes in
  `routes/subscriptions.ts` (public) and `routes/admin/subscribers.ts`.
- Fan-out only enqueues rows; it never sends inside the request, and errors are
  logged without failing the admin request.
- Only public incidents/maintenance notify, and mails list public services only.
- Subscription tokens are derived with HMAC-SHA256 from `SUBSCRIPTION_TOKEN_KEY` (default `SECRET_KEY`) and a per
  subscriber salt; they are never stored. Deleting a subscriber cascades to its
  services and queued mails.
- Rows are claimed before sending (conditional update of `next_attempt_at`), so two
  workers never send the same row; on PostgreSQL the `email-delivery` task also runs
  under a lease (see [Several instances](#several-instances)). Delivery is at least
  once: a worker that dies after the SMTP server accepted a mail but before marking
  the row sent leaves it to be sent again after the claim expires (10 minutes).

## Background worker

`Worker` (in-process interval tasks) runs:

- maintenance transitions (auto start/complete) every 30 s, notifying subscribers
- one poll task per enabled pull-capable monitoring source
- `bundle-evaluation`: re-evaluates every check bundle each minute, so members
  whose results become stale stop counting
- session cleanup (hourly)
- `email-delivery`: sends due outbox mails every 10 s
- `maintenance-reminders`: queues reminders every minute
- `notification-cleanup` (hourly): deletes unconfirmed subscriptions after 7 days and
  sent/failed mails after 30 days
- `history-import-cleanup` (every 5 min): fails import jobs without progress for
  15 minutes (e.g. after a restart) and discards previews older than 24 hours
- `poller-sync` (every 30 s, on every instance): re-reads the monitoring sources
  and updates this instance's poll tasks
- `task-lease-cleanup` (hourly, PostgreSQL only): removes leases unused for 7 days

History import jobs themselves run as one-off jobs in the process that received
the request (also with `WORKER_ENABLED=false`).

## Check history and history import

```
ingest / bundle vote ──state change──► monitor_check_history (source = live)
                                                  ▲
importer (Kuma Socket.IO, Icinga DB SQL,          │ only into periods without live rows
openITCockpit API, CSV) ──► history_import_intervals ──preview──► confirm ──┐
                                                                            ▼
      replay (history-replay.ts): check history → link mappings, aggregation,
      bundle votes, maintenance, incidents → service_status_history (source = import),
      only inside the service's gaps
```

- `monitor_check_history` keeps state intervals per check; the open row
  (`ended_at = null`) is the current state.
- Imports never touch `live` rows and replace earlier `import` rows inside their
  range, so re-runs are idempotent. Service statuses from CSV files are stored
  as `import_explicit` and kept by later imports (precedence live > explicit >
  replayed).
- Applying plans and writes in one transaction under a global lock
  (`pg_advisory_xact_lock` on PostgreSQL, the write lock on SQLite), so imports
  of different sources feeding the same service never interleave.
- Code: `apps/server/src/importers/` (one importer per source type, CSV parser,
  minimal Socket.IO client), `services/history-import*.ts` (jobs, planning),
  `services/history-replay.ts` (pure, unit tested).

## Several instances

On PostgreSQL any number of instances may share one database, including several
with background tasks (`APP_ROLE=worker` or `all`). SQLite is limited to one
instance. What keeps them consistent:

| Concern | Mechanism |
| --- | --- |
| Periodic tasks (maintenance transitions, reminders, mail delivery, bundle evaluation, cleanups) | Lease per task in `task_leases` (`lib/task-leases.ts`): one instance runs a task at a time, and a scheduled run happens once per interval in the whole deployment |
| Polling | Lease `poll:<source id>` per source: every worker schedules every source, one of them polls it per interval; manual polls ("poll now") take the same lease and report when another instance is polling |
| Mail sending | Lease on `email-delivery` plus the per-row claim in `email_outbox`; reminders and automatic maintenance transitions are claimed with conditional updates, so no event is announced twice |
| Bundle evaluation | In-process queue plus `pg_advisory_xact_lock` while evaluating and storing (`db/locks.ts`) |
| Service status and its history | `pg_advisory_xact_lock` around each recompute, so concurrent recomputes never open two history segments |
| History import apply | `pg_advisory_xact_lock`; at most one active job per source (unique index) |
| Schema migrations | Kysely's migration lock (several instances may start at once) |
| Sessions, API tokens, OIDC login state | Database rows and a cookie signed with `SECRET_KEY`: any instance can serve any request (same `SECRET_KEY` everywhere) |
| Caches | No server-side caches of status data; public API responses carry `Cache-Control: max-age=30` |
| Rate limits | Counted in memory per instance (see below) |

Leases (`task_leases`) store the owner, `locked_until` and `last_started_at` in
milliseconds from the database clock. A claim is one `INSERT ... ON CONFLICT DO
UPDATE ... WHERE` statement: it succeeds when the lease is free (or expired) and,
for a scheduled run, when the last start lies at least one interval back (minus a
small tolerance, at most 2 s, for timers firing at different moments). The holder
renews the lease every 20 s and frees it when done; the lease of an instance that
died expires after 60 s. Leases hold no connection, so a busy pool cannot deadlock
on them. An edited monitoring source is polled once right away: the claim also
succeeds when the source changed after the last poll started.

History import jobs (fetch, apply) run in the admin instance that received the
request; the cleanup task of any worker fails a job whose `updated_at` stopped
moving for 15 minutes, e.g. because that instance stopped. A `public` instance
runs no tasks and never touches `task_leases`.

Advisory locks are transaction-scoped: the work runs in a transaction that takes
`pg_advisory_xact_lock(key)` first and uses only that transaction's connection.
Keys are listed in `db/locks.ts`. On SQLite these paths run unchanged, without a
transaction.

**Rate limits** (`@fastify/rate-limit`, ingest token buckets) are kept in the
memory of each instance. With several instances behind a load balancer a client
can reach up to *n* times the configured limit. That is accepted rather than
adding a shared store: the limits protect the login and the subscription forms
against brute force and floods, and a factor of the number of instances (usually
two or three) keeps them effective. If you need exact limits, route each client to
one instance (sticky sessions by client IP at the proxy) or enforce them at the
proxy.

Tests: `apps/server/test-pg/multi-instance.test.ts` starts two worker instances
against one PostgreSQL database and checks that polls, mails and status history are
not duplicated. It is part of the PostgreSQL suite (`pnpm --filter
@openstatuspage/server test:pg`) and runs when `PG_TEST_URL` is set (a server whose
user may create databases, e.g. a throwaway `postgres:17-alpine` container).

## Deployment roles

`APP_ROLE` (`apps/server/src/role.ts`) decides per instance which route modules
are registered (`routes/index.ts`), which web files are served (`web-assets.ts`),
whether migrations run or the instance waits for the schema, and whether the
background tasks start (`startup.ts`). `all` keeps the single-process behaviour;
`public`, `admin` and `worker` split it across instances on PostgreSQL (see
[configuration.md](configuration.md#split-deployment)). A worker re-reads the
monitoring sources every 30 s (`poller-sync`) so changes made on an admin
instance reach its pollers. Several `worker` instances may run side by side
(see [Several instances](#several-instances)).

On PostgreSQL a public instance connects as the restricted role `DB_PUBLIC_ROLE`
with `search_path=osp_public` (`db/index.ts`): migration `0007_public_role`
creates views of the public rows and columns there, row level security policies
and `SECURITY DEFINER` functions for the subscription flow
(`services/subscription-flow.ts` calls them instead of the subscriber tables).
Instances that migrate run `osp_grant_public_role()` on start
(`db/public-role.ts`). Mails queued by those functions carry no content; the
worker renders them (`NotificationService`). See
[security-model.md](security-model.md).

## Server-side rendering

The public pages are rendered on the server and hydrated in the browser, so
they work without JavaScript and search engines get the content in the HTML.
The management UI (`/admin`) stays a client-rendered SPA and is sent with
`X-Robots-Tag: noindex, nofollow`.

```
request /incidents/42 ─▶ app.ts (not-found handler, client route, not /admin)
  └─ ssr/pages.ts      render cache? ── hit ─▶ 200/404 + ETag
       └─ dist/.ssr/entry-server.mjs  render()          (imported on first use)
            ├─ settings → language (cookie, ?lang=, Accept-Language, default), theme
            ├─ handle.prefetch of the matched routes (public/routes.tsx)
            │    └─ publicQueries.*(get)  ─▶ ssr/source.ts ─▶ PublicDocuments  (in-process)
            ├─ renderToString(StaticRouterProvider)  + usePageHead() collected
            └─ dehydrate(QueryClient) ─▶ <script type="application/json" id="osp-state">
  └─ public.html template: <html lang dir data-theme>, head, markup, state block
browser: main-public.tsx ─▶ hydrate.tsx: same language/theme/clock, hydrate(), hydrateRoot()
```

- **One data path.** `publicQueries` (`apps/web/src/public/hooks/queries.ts`)
  builds the query options of every public page for a document source: HTTP in
  the browser, the server's own document builders
  (`services/public-documents.ts`, which the `/api/public` routes use as well)
  during rendering. Keys and deserialization are therefore identical, and the
  dehydrated state is exactly what the hooks expect. "Not found" answers are
  dehydrated too, so a 404 page hydrates into the same state.
- **Route loaders.** Each public route lists the queries of its first render in
  `handle.prefetch` (`public/routes.tsx`, types in `public/loaders.ts`). The
  settings query always runs first.
- **Page head.** Every page calls `usePageHead({ title, description, canonical,
  robots, status, home, breadcrumbs, article })` (`public/head.tsx`). The server writes the result
  into `<head>` and uses `status` as the HTTP status (404 for unknown pages,
  services, incidents and maintenance windows); in the browser the same store
  keeps `document.head` in sync after navigations. URLs are absolute with
  `PUBLIC_BASE_URL`. See [Search engines and AI agents](#search-engines-and-ai-agents).
- **Deterministic first render.** The server renders against its render time,
  in UTC and with ICU-free formatting (`neutral` in `public/utils/time.ts`:
  ISO dates, 24-hour times, SI-style durations, country codes); the theme comes
  from the `osp-theme` cookie or the page default. Hydration repeats exactly
  that (`useHydrated()` and `SsrProvider` in `lib/ssr.tsx`), then the browser
  switches to the visitor's clock, time zone and localized formats. The
  interactive world map loads lazily after hydration; until then (and without
  JavaScript) the static map of the server stands in at the same size.
  `apps/web/src/ssr.test.tsx` hydrates every page in jsdom and fails on any
  hydration warning.
- **Language.** `osp-lang` cookie (set by the language switcher), then `?lang=`,
  then `Accept-Language`, then the page default (`lib/languages.ts`). The browser
  switches to the server's language before hydrating.
- **Caching.** A rendered page is kept for 5 s per URL, language and theme input
  (`cacheKey` of the bundle; at most 16 pages and 1 MiB, one render per key at a
  time, at most two renders at once) and sent with a weak `ETag`, `Vary:
  Accept-Language, Cookie` and `Cache-Control: public, max-age=10,
  stale-while-revalidate=60` (`private, no-store` for the personal subscription
  links). If-None-Match answers 304.
- **Failure.** A render error or a missing bundle is logged and the plain
  client-rendered entry page is sent instead; the page still works. The same
  happens at once when more than 32 pages wait for a render (a flood of distinct
  URLs cannot queue without bound).
- **Accent color.** The configured accent and its contrast-safe variants for
  both themes go into a `<style>` in the head (`public/utils/accent.ts`), so the
  page has its colors before (and without) hydration.
- **Build.** `pnpm --filter @openstatuspage/web build` runs `vite build` (the
  two client entries) and `vite build --ssr src/entry-server.tsx --outDir
  dist/.ssr`: one self-contained, minified, ASCII-only ES module with every
  dependency bundled (the image has no `node_modules` for the web client) and
  `renderToString` only (not the streaming renderer). The public route tree only:
  `entry-server.tsx` must never import `./admin`. Neither `.vite/` nor `.ssr/`
  is ever served as a file. The client build also writes `/world-map.svg`, the
  country shapes of the static map (`apps/web/tools/world-map.ts`).

### Without JavaScript

Every public page is fully usable without JavaScript; scripts only enhance it
(no page load for a filter, live updates every 60 s, the interactive map, the
visitor's time zone). The rules:

- **Controls are links and forms.** Every filter, range and toggle lives in the
  URL, so the server renders its result: history filters are a GET form
  (`type`, `service`, `location`, `month`) and its pages links (`page`), the
  service search a GET form (`q`) and the status counters links (`status`),
  "all upcoming maintenance" a link (`upcoming=all`). Submit buttons that only
  browsers without JavaScript need are inside `<noscript>` (`NoScript`), so
  hydration moves nothing; with JavaScript every change applies at once.
- **Disclosures are `<details>`.** The subscribe menu, the language menu, the
  collapsible service groups and the daily uptime table open without scripts.
  With JavaScript the `Disclosure` component also closes them on Escape and on
  a click outside.
- **Tooltips have a visible equivalent.** The days of an uptime bar are listed in
  a table on the service page; the world map's markers are drawn on the server
  (`StaticWorldMap`: the country shapes of `/world-map.svg` as a CSS mask in the
  theme color, the markers with the fixed projection of
  `public/utils/map-projection.ts`); the location list below it has every
  location with its status.
- **Preferences.** The theme switcher is a form posting to `/preferences/theme`
  and the language switcher links to `/preferences/language?lang=…`; both set
  their cookie and redirect back (`forms/preferences.ts`). The `system` theme
  follows `prefers-color-scheme` in CSS. Times are in UTC until hydration, so the
  time zone toggle is a label until then. Every page lists its other languages
  as `hreflang` alternates (`?lang=xx`, `x-default` without).
- **Forms post to form handlers** outside `/api` (`apps/server/src/forms/`,
  `application/x-www-form-urlencoded`, paths in `FORM_PATHS` of
  `@openstatuspage/shared`): `/subscribe`, `/subscription/confirm`,
  `/subscription/manage`, `/subscription/unsubscribe`. They use the same
  subscription flow and rate limits as the JSON:API, and Post/Redirect/Get: a
  success redirects (`303`) to a page that shows the outcome from a query flag
  (`?sent=1`, `?saved=1`, `?confirmed=1`, `?unsubscribed=1`, `?error=invalid`).
  Invalid input is answered with the page itself (`422`, `SsrPages.sendForm`):
  the server renders it with the submitted values and errors (`SsrFormState`,
  carried into hydration by the state block), with an error summary and the
  error in the title. Without the render bundle the answer is a redirect with
  `?error=<code>`. Requests from other sites are rejected (`Sec-Fetch-Site`,
  `Origin`; see [security-model.md](security-model.md#html-forms)). With
  JavaScript the same forms post to the JSON:API instead.
- **Links in emails carry the token in the query**, so the server can render the
  confirm and manage pages (the route loader reads the subscription through the
  in-process source). Confirming takes one click on a form, so a mail scanner
  that opens the link confirms nothing. Links of older emails with the token in
  the URL fragment keep working with JavaScript.
- **No live updates without JavaScript**, and no `<meta http-equiv="refresh">`
  (it would move the reader's focus and position): the overview says when the
  status was last updated, a reload shows the current one.
- `apps/server/test/nojs-pages.test.ts` fetches every page and checks that each
  control is a link or a form with its action, method and field names, and that
  no button, field or tab stop depends on a script.

## Search engines and AI agents

The public page describes itself for search engines, link previews and AI
agents. Everything is built from the page settings and public data only.

- **Page head** (`apps/web/src/public/head.tsx`, `seo.ts`; the element list is
  `headElements()` in `packages/shared/src/ssr.ts`, used by the server's HTML and
  the browser's DOM alike):
  - `<title>` "Page · Site" (the overview: the site name), a description of at
    most 160 characters (the service description, the latest incident update,
    the maintenance description, else a generated sentence; the overview uses
    the page description of the settings),
  - `robots`: `index, follow`; `noindex` for 404 pages and the subscription
    links (confirm, manage, unsubscribe), which have no canonical URL either,
  - `canonical`: the path without query; `?lang=xx` is kept, because every
    language version is a page of its own. The `hreflang` alternates list
    `?lang=xx` for every language and the plain path (language from cookie,
    `Accept-Language` or the page default) as `x-default`. A service's
    canonical path is its slug.
  - Open Graph and Twitter card (`summary`): site name, title, description, URL,
    `og:locale` (`en_US`, `de_DE`) with the other languages as alternates, and
    the logo of the settings as image (no image tags without a logo);
    `theme-color` is the accent color.
- **JSON-LD** (schema.org), only on indexable pages: `WebSite` and
  `Organization` (name, URL, logo) on the overview, `BreadcrumbList` on every
  other page, `Article` on incident and maintenance pages (headline,
  `datePublished` = start of the incident / creation of the maintenance window,
  `dateModified`, author and publisher = the organization). No `Event` markup:
  an outage is not an event anybody attends. Escaped with `scriptJson`.
- **Discovery files** (`apps/server/src/routes/discovery.ts`, data from
  `services/site-index.ts`; registered before the web client, never rendered):

  | Path | Roles | Content |
  | --- | --- | --- |
  | `/robots.txt` | public, all | `Allow: /`, `Disallow: /api/`, `/admin`, `/subscription/`, `/preferences/`, `Sitemap:` |
  | `/robots.txt` | admin | `Disallow: /` (a preview, not the status page) |
  | `/sitemap.xml` | public, all | sitemap index of the files below |
  | `/sitemap-pages.xml` | public, all | overview, services, history, locations and subscribe (when switched on) |
  | `/sitemap-incidents-N.xml` | public, all | public incidents, then public maintenance windows, with `lastmod` |
  | `/sitemap-services-N.xml` | public, all | public service pages, `lastmod` = last change or status change |
  | `/llms.txt` | public, all | [llmstxt.org](https://llmstxt.org) summary: pages, JSON:API, feeds |
  | `/llms-full.txt` | public, all | the current status as Markdown: overall status, active incidents, maintenance, services |

  A sitemap file holds at most 5,000 URLs (`SITEMAP_PAGE_SIZE`, the protocol
  allows 50,000), which keeps a response well below a megabyte. Responses are
  cached by clients and proxies (`Cache-Control`: robots 1 h, sitemaps 15 min,
  llms.txt 5 min, llms-full.txt 1 min). On PostgreSQL a public instance reads
  them through the `osp_public` views like every other public query. Admin text
  is XML-escaped in sitemaps and cannot add Markdown headings or links to the
  llms files (titles are single lines with escaped brackets, messages are block
  quotes). New form handlers outside `/api/` belong into `DISALLOWED_PATHS`.
  The web build must not contain files with these names (`@fastify/static`
  would register the same routes).

## Memory

Target: less than 100 MB resident memory (RSS) per instance. Measured with
`scripts/measure-memory.mjs` (`pnpm measure:memory`) on Node 22 (v22.23.5,
linux/arm64, the production image) against PostgreSQL 17 with the demo seed. The
script starts the production build once per role, one instance at a time, and
puts light load on it: a login and the main admin lists (admin, all), 400 public
requests with 8 in parallel (server-rendered pages of every kind in both
languages, the public API, feeds, sitemaps, llms.txt and assets) plus three
subscriptions through the API and two through the HTML form, one of them invalid
and answered with the rendered page (public, admin, all), and a monitoring source
polled every 10 s from a local fake Uptime
Kuma for 40 s (worker, all). "After load" is read after 15 s without requests.

| Role | After start | Peak under load | After load | Kernel peak (VmHWM) |
| --- | --- | --- | --- | --- |
| public | 76 MB | 95 MB | 83 MB | 97 MB |
| admin | 84 MB | 105 MB | 92 MB | 107 MB |
| worker | 75 MB | 76 MB | 76 MB | 90 MB |
| all | 78 MB | 104 MB | 97 MB | 108 MB |

These are the numbers with the pages working without JavaScript (forms, static
map, day tables). The build before that, measured the same way on the same day,
had public 76 / 97 / 83 MB (kernel peak 97 MB): the extra markup was paid for by
moving the layout of the uptime bar segments into the stylesheet.

Server-side rendering costs a public instance about 11 MB at the peak and 6 MB
after load (the same build without the render bundle: 76 / 83 / 74 / 83 MB). The
render bundle is imported on the first page request, so "after start" does not
include it.

What the target covers: `public` and `worker` stay below 100 MB at every
point, also at their kernel peak. `admin` and `all` stay below it after start and
at steady state, but exceed it briefly under load: up to 105 MB (admin) and
104 MB (all) in the samples, 107–108 MB at the kernel peak, mostly while a
password is checked (see below). Size memory limits for these peaks, not for the
target: the Kubernetes examples request 128 MiB and limit at 256 MiB, and
`deploy/compose/compose.split.yaml` sets the same limits.

Before `--max-opt=2` (see the runtime flags below) and without server-side
rendering the numbers were public 84 / 94 / 83 MB, admin 90 / 102 / 90 MB, worker
80 / 84 / 84 MB and all 85 / 106 / 95 MB; with server-side rendering but without
`--max-opt=2` the public instance peaked at 107 MB.

The same build and load before the changes below: public 98 / 118 / 105 MB,
admin 113 / 133 / 120 MB, worker 105 / 112 / 100 MB and all 108 / 129 / 117 MB
(after start / peak / after load).

About half of the RSS (45–50 MB) are file-backed pages of the `node` binary
itself (V8, OpenSSL, ICU). They are shared by all node processes on a host and
the kernel can drop them under memory pressure; a bare `node -e` already has
about 40 MB. The anonymous part, the instance's own memory, is 32–46 MB. Two
short peaks remain above the steady state: a password check (Argon2id with the
OWASP parameters needs 19 MiB while it runs) and the first outbound request of
a process (Node compiles the WebAssembly HTTP parser of `fetch`).

What keeps it small:

- **One bundle per role.** The server build (`apps/server/tsup.config.ts`)
  bundles and minifies the dependencies (ASCII only: V8 stores a source with one
  non-ASCII character as UTF-16), because V8 keeps the source of every loaded
  module in memory. Native modules, `pino-pretty` and `mysql2` stay external.
- **Lazy loading.** Route modules are imported per role (`routes/index.ts`); a
  worker loads neither the public nor the admin routes, a public instance loads
  no admin, auth or ingest code. Cookies and static files are registered only where
  the role needs them. nodemailer (first mail), openid-client (first OIDC login),
  argon2 (first password check), the history importers with their Socket.IO
  client (first import job) and mysql2 (Icinga DB import) are loaded on first use.
- **No ICU on hot paths.** Feeds and mails format dates without `Intl`
  (`formatUtcDateTime` in `lib/time.ts`), the public history sorts without
  `localeCompare`, and server-side rendering formats without `Intl` until
  hydration (`neutral` in `apps/web/src/public/utils/time.ts`); only i18next's
  plural rules touch ICU there. The browser reuses its `Intl` formatters
  (`public/utils/intl.ts`).
- **A small render bundle, loaded late.** The server-side rendering bundle
  (about 500 kB, ASCII only, `renderToString` without the streaming renderer,
  only the `common` and `public` translations) is imported on the first page
  request, at most two pages render at once.
- **Bounded caches.** The only response cache holds rendered public pages for
  5 s (at most 16 pages and 1 MiB, as UTF-8 bytes); there is no query cache. The rate limiter
  keeps at most 1000 clients per route (`RATE_LIMIT_KEYS`), the per-source
  limiter of the ingest endpoints 10 000 keys. The web asset policy keeps only
  the file names of the public entry, never file contents.
- **Runtime flags** in the image (`docker/Dockerfile`):

  | Setting | Value | Why |
  | --- | --- | --- |
  | `NODE_OPTIONS` | `--max-semi-space-size=1 --max-old-space-size=96` | A 1 MB young generation (Node's default grows to 16 MB per semi-space) saves about 10 MB at little GC cost for short requests. The old generation cap turns a leak into a restart instead of swapping. |
  | `MALLOC_ARENA_MAX` | `2` | glibc creates a malloc arena per thread; two arenas save several MB of fragmented native memory. |
  | `UV_THREADPOOL_SIZE` | `2` | Every libuv thread that ran an Argon2 hash keeps 2–3 MB; two threads are plenty for file reads, DNS and password checks of a status page. |
  | `node --max-opt=2` (command) | – | No TurboFan; Ignition, Sparkplug and Maglev still run. TurboFan's optimized code and compiler zones cost 10–15 MB per instance (the public instance with server-side rendering peaked at 107 MB with it), more than a status page gains in speed. NODE_OPTIONS cannot carry this V8 flag, so the image's `CMD` and `pnpm start` pass it. |

  The health check of the image uses bash instead of a second node process
  (about 40 MB every 30 s inside the container's memory limit).

Raise the cap for a large history import on an admin instance, e.g.
`NODE_OPTIONS=--max-semi-space-size=1 --max-old-space-size=256`. Without the
image, set the same variables and start with `node --max-opt=2` yourself to get
the numbers above; without them every role needs about 10–20 MB more.

To measure your own build: start a throwaway PostgreSQL, create the roles
(`deploy/postgres/roles.sql`), `pnpm -r build`, then

```sh
DATABASE_URL=postgres://owner:...@127.0.0.1:5432/osp_memory \
PUBLIC_DATABASE_URL=postgres://osp_public:...@127.0.0.1:5432/osp_memory \
MALLOC_ARENA_MAX=2 UV_THREADPOOL_SIZE=2 \
pnpm measure:memory --node-args="--max-semi-space-size=1 --max-old-space-size=96 --max-opt=2"
```

on an empty database. Use Linux (or the image) for comparable numbers: macOS
reports a larger RSS for the same process and has no `RssAnon`/`VmHWM`.

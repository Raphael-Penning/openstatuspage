# Configuration

OpenStatusPage is configured exclusively through environment variables
(see [`apps/server/src/config.ts`](../apps/server/src/config.ts)). A commented
template lives in [`.env.example`](../.env.example). A `.env` file in the working
directory or the repository root (or the file named by `ENV_FILE`) is loaded
automatically; variables already set in the environment win, empty values count
as unset. Invalid values stop the server at startup with a list of the offending
variables.

Boolean variables accept `true`/`false`, `1`/`0` and `yes`/`no`.

## Server

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `production` | `development`, `production` or `test`. `pnpm dev` uses `development`. Outside development/test `SECRET_KEY` is mandatory and logs are JSON. |
| `HOST` | `0.0.0.0` | Interface the HTTP server binds to. |
| `PORT` | `3000` | HTTP port. |
| `BASE_URL` | `http://localhost:3000` | URL of this instance, without trailing slash: the public URL of the status page, or the admin domain of an `admin` instance. Used for OIDC redirect URIs and ingest URLs, and for feed and email links unless `PUBLIC_BASE_URL` is set. When it starts with `https://` cookies are marked `Secure`; in production an `http://` URL for a host other than `localhost` logs a warning on start. |
| `PUBLIC_BASE_URL` | `BASE_URL` | Public URL of the status page, used for every link in feeds and emails (incident and maintenance pages, confirm, manage and one-click unsubscribe links). Set it on `admin` and `worker` instances of a [split deployment](#split-deployment), so mails sent from the admin domain still link to the public page. The server-rendered public pages use it for their canonical and language URLs, link previews and JSON-LD, and `robots.txt`, the sitemaps and `llms.txt` for every URL they list. |
| `TRUST_PROXY` | `false` | Behind a reverse proxy (nginx, Traefik, Caddy, ...) client IPs (rate limiting, session metadata) and the protocol are taken from `X-Forwarded-*` headers. Set the number of proxies in front of the app (`1` for a single proxy; `true` means `1`) or a comma separated list of trusted proxy addresses/CIDRs (e.g. `10.0.0.0/8,127.0.0.1`). Entries further left in `X-Forwarded-For` are set by the client and are never trusted. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `WEB_DIST_DIR` | – | Directory with the built web client. By default the server looks for `apps/web/dist`. |

The Docker image also sets `NODE_OPTIONS=--max-semi-space-size=1 --max-old-space-size=96`,
`MALLOC_ARENA_MAX=2` and `UV_THREADPOOL_SIZE=2` and starts `node --max-opt=2`, which
keep an instance below about 100 MB. Override `NODE_OPTIONS` to give a large history import more heap; see
[architecture.md](architecture.md#memory).

## Security

| Variable | Default | Description |
| --- | --- | --- |
| `SECRET_KEY` | – (development fallback) | At least 32 characters, e.g. `openssl rand -base64 48`. Encrypts monitoring credentials, the client secrets of SSO providers, admin webhook URLs, extra header values and signing secrets, and SMS provider credentials at rest (AES-256-GCM) and signs cookies. **Required unless `NODE_ENV` is `development` or `test`, or `APP_ROLE=public` with `SUBSCRIPTION_TOKEN_KEY`.** In production the published example values (the development fallback and the value in `deploy/kubernetes/secret.example.yaml`) are refused, here and for `SUBSCRIPTION_TOKEN_KEY`. Changing it makes stored monitoring credentials and SSO client secrets unreadable (they have to be re-entered; an SSO provider whose secret cannot be read answers `oidc_unavailable`). |
| `SUBSCRIPTION_TOKEN_KEY` | `SECRET_KEY` | At least 32 characters. Key of the email subscription links (confirm, manage, unsubscribe), of the webhook and SMS subscription links, and of the encrypted webhook URLs and phone numbers of visitors. A split deployment sets its own value, the same on every instance, and gives the `public` instance only this key instead of `SECRET_KEY`. Changing it invalidates links in emails already sent and makes the stored webhook URLs and phone numbers of visitors unreadable (these visitors have to subscribe again); the admin and worker instances refresh the stored token hashes on their next start. |
| `SESSION_TTL_HOURS` | `168` (7 days) | Session lifetime. The expiry slides: active sessions are extended, idle ones expire after this many hours. Range 1–2160. |
| `SESSION_MAX_AGE_HOURS` | `720` (30 days) | Absolute session lifetime, counted from the login. Active sessions are never extended past it, so everybody has to log in again (and SSO users pass the IdP checks again) at least this often. Range 1–8760, at least `SESSION_TTL_HOURS`; when unset and `SESSION_TTL_HOURS` is longer, that value is used. |

## Database

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite:./data/openstatuspage.db` | `sqlite:<path>` (use `sqlite::memory:` for throw-away instances) or `postgres://user:password@host:5432/database`. Migrations run automatically on start (except with `APP_ROLE=public`). |
| `ALLOW_UNRESTRICTED_PUBLIC_DB` | `false` | PostgreSQL, `APP_ROLE=public` only: a public instance refuses to start when its database login is not a registered public role (`DB_PUBLIC_ROLE`), because the database would not restrict it. (A registered role that may still create objects in the table schema or in `osp_public` only causes a warning.) `true` starts anyway and only logs a warning. |
| `DB_PUBLIC_ROLE` | `osp_public` | PostgreSQL only: the restricted login role of `APP_ROLE=public` instances (lower case letters, digits, `_`). Instances that migrate grant it read access to the public views and the subscription functions of schema `osp_public` on every start, once the role exists (create it with [`deploy/postgres/roles.sql`](../deploy/postgres/roles.sql)). See [security-model.md](security-model.md). |

## Initial administrator

Only used when the database contains no user at all.

| Variable | Default | Description |
| --- | --- | --- |
| `ADMIN_EMAIL` | – | E-mail of the first admin. |
| `ADMIN_PASSWORD` | – | Password of the first admin (at least 10 characters). Remove it from the environment after the first start. |

Alternatively create users with
`pnpm --filter @openstatuspage/server create-user <email> [admin|editor] [name] [--unlink-oidc]`.
The command asks for the password on a terminal; otherwise it reads the first line
of stdin or the environment variable `OSP_USER_PASSWORD`. It never takes the password
as an argument.

## Authentication

| Variable | Default | Description |
| --- | --- | --- |
| `LOCAL_LOGIN_ENABLED` | `true` | Allow e-mail/password login. Set to `false` for OIDC-only setups (make sure an OIDC user can become admin first). |
| `OIDC_ISSUER_URL` | – | Issuer URL of the OpenID Connect provider. OIDC is enabled when this and `OIDC_CLIENT_ID` are set, on the `all` and `admin` roles. |
| `OIDC_CLIENT_ID` | – | Client ID registered at the IdP. |
| `OIDC_CLIENT_SECRET` | – | Client secret. Leave empty for public clients (PKCE only). |
| `OIDC_SCOPES` | `openid email profile` | Requested scopes. Add e.g. `groups` if your IdP needs a scope for the groups claim. |
| `OIDC_LABEL` | `Single Sign-On` | Label of the SSO button on the login page. |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim that contains the user's groups or roles. Dots address nested claims, e.g. `realm_access.roles`. |
| `OIDC_ADMIN_GROUP` | – | Members of this group become `admin`. |
| `OIDC_EDITOR_GROUP` | – | Members of this group become `editor`. When unset, every account of the IdP that matches an existing user may log in. |
| `OIDC_AUTO_CREATE_USERS` | `false` | Create a local user on the first OIDC login. When `false`, users must be created by an admin first. Only enable it together with `OIDC_ADMIN_GROUP`/`OIDC_EDITOR_GROUP`, otherwise every account of the IdP becomes an editor (the server logs a warning). |

See [oidc.md](oidc.md) for IdP setup and the role mapping rules.

The `OIDC_*` variables configure one provider. Further providers (any number)
are managed in the management UI under *Administration → Single sign-on*; their
client secrets are stored encrypted with `SECRET_KEY`. The provider of the
environment is listed there read-only and keeps working unchanged.

## Deployment role

One build can run as different kinds of instances. `APP_ROLE` selects what an
instance does; see [Split deployment](#split-deployment) below.

| Variable | Default | Description |
| --- | --- | --- |
| `APP_ROLE` | `all` | `all`: everything in one process (status page, management UI and API, login, ingest, background tasks). `public`: status page, public API, feeds, email subscriptions and `/api/health` only. `admin`: management UI and API, login/OIDC, ingest endpoints, plus the public page and API (preview). `worker`: background tasks only, HTTP serves `/api/health` only. Every role except `all` requires PostgreSQL. |
| `SCHEMA_WAIT_SECONDS` | `120` | `APP_ROLE=public` never runs migrations. On start it waits up to this many seconds (0 to 3600) for the database schema to reach the version of its build, then stops with an error. |

## Background worker

| Variable | Default | Description |
| --- | --- | --- |
| `WORKER_ENABLED` | `true` for `all` and `worker`, `false` for `admin` | Runs maintenance auto start/complete, monitoring pollers, check bundle re-evaluation, email delivery, maintenance reminders and the cleanup tasks. On PostgreSQL several instances may run them: tasks are coordinated through the database, so each one runs on one instance at a time (see [architecture.md](architecture.md#several-instances)). Must not be `true` with `APP_ROLE=public` or `false` with `APP_ROLE=worker` (the server refuses to start). |

## Split deployment

With PostgreSQL the management side and the public status page can run as separate
instances, e.g. `status.admin.example.org` (internal network or VPN) and
`status.example.org` (internet):

| | `public` | `admin` | `worker` | `all` |
| --- | :---: | :---: | :---: | :---: |
| Public status page, `/api/public/*`, feeds, subscriptions | ✓ | ✓ | – | ✓ |
| Management UI (`/admin`), `/api/admin/*`, `/api/auth/*` (login, OIDC) | – | ✓ | – | ✓ |
| Ingest endpoints `/api/ingest/*` (webhooks of monitoring systems) | – | ✓ | – | ✓ |
| `/api/health` | ✓ | ✓ | ✓ | ✓ |
| Background tasks (pollers, scheduler, mail delivery, cleanup) | never | `WORKER_ENABLED=true` | ✓ | ✓ (default) |
| Runs migrations on start | never (waits) | ✓ | ✓ | ✓ |
| Creates the initial admin (`ADMIN_EMAIL`) | – | ✓ | – | ✓ |

What a `public` instance does **not** do:

- Routes that are not listed above do not exist (404), whatever headers or cookies
  a request carries; sessions and API tokens are never looked up.
- It serves `public.html`, a separate entry page of the web client that contains
  no management UI. `/admin/...` answers 404, and so do `index.html` and every
  file that only the management UI loads (the server reads the build's
  `.vite/manifest.json`; the instance refuses to start without it).
- It never connects to monitoring systems and never sends mail: confirmation and
  notification mails are queued in the database and delivered by the worker. It
  needs `MAIL_TRANSPORT` (and `SMTP_FROM`) to offer subscriptions, but no
  `SMTP_HOST` or SMTP credentials.
- It never runs migrations: start the admin or worker instance (or run
  `pnpm db:migrate`) first after an update. A public instance whose build is older
  than the database schema refuses to start.

Give the public instance its own database login, the restricted role
`DB_PUBLIC_ROLE` (default `osp_public`, created with
[`deploy/postgres/roles.sql`](../deploy/postgres/roles.sql)). It can only read
views of the public rows and columns (schema `osp_public`) and write through a
few checked functions for the email subscriptions; row level security backs this
up. A vulnerability in the public instance, or SQL injection in its code, then
cannot read subscribers, users, sessions, tokens or monitoring sources, nor change
anything. Admin and worker instances use the login that owns the tables and grant
the public role on every start. Details, scope and threat model:
[security-model.md](security-model.md).

Monitoring sources changed on an admin instance reach the worker's pollers within
30 seconds. Results pushed to the ingest endpoints go to the admin instance, so
monitoring systems need to reach the admin host, not the public one.

Each role can run as several instances (e.g. two `worker` instances for
availability, several `public` instances behind a load balancer): background tasks
and polls are coordinated through the database, and every instance can serve every
request. Set `PUBLIC_BASE_URL` to the public domain on admin and worker
instances: mails are written on the instance where an incident is created (the
admin instance), and their links must not point to the restricted admin domain.
Use the same `SUBSCRIPTION_TOKEN_KEY` everywhere and the same `SECRET_KEY` on
the admin and worker instances. Do not give the public instance `SECRET_KEY`: it
only needs `SUBSCRIPTION_TOKEN_KEY` (and logs a warning when it gets
`SECRET_KEY`). Rate limits are counted per instance
(see [Rate limits](#rate-limits)). Details: [architecture.md](architecture.md#several-instances).

SQLite is a single-file database for one instance: with SQLite only `APP_ROLE=all`
is supported.

## Monitoring

Limits for monitoring sources (see [adapters/README.md](adapters/README.md)).

| Variable | Default | Description |
| --- | --- | --- |
| `POLL_MAX_RESPONSE_MB` | `8` | Largest response body (MiB after decompression, 1 to 512) a pull adapter (Icinga 2, Uptime Kuma, openITCockpit) reads per request; larger answers fail the poll. Sized against the image's heap cap (`NODE_OPTIONS=--max-old-space-size=96`, see [architecture.md](architecture.md#memory)): raise both together, e.g. `POLL_MAX_RESPONSE_MB=32` with `--max-old-space-size=256`. History imports keep their own 50 MiB limit. |
| `POLL_MAX_VALUES` | `500000` | Most values one pull response may hold, counted before parsing (JSON objects, arrays and elements; Prometheus lines and labels). Parsing costs heap per value, many times the byte count for small values; answers with more values fail the poll. Raise it together with the heap cap. |
| `MAX_CHECKS_PER_SOURCE` | `20000` | Most checks (100 to 1000000) one monitoring source may have. A push or poll that would give a source more checks is rejected (push: `409`; poll: recorded as a failed poll) and stores nothing; updates of existing checks are always accepted. |

## Check bundles

| Variable | Default | Description |
| --- | --- | --- |
| `BUNDLE_PUSH_STALE_SECONDS` | `3600` | How long (seconds, 60 to 604800) a result of a push-only (`webhook`) source counts in a check bundle vote; older members are treated as not reporting. Pull sources count while their last successful poll (or result) is at most 3 poll intervals old, at least 5 minutes. See [adapters/README.md](adapters/README.md#check-bundles). |

## Email notifications

Subscribers receive emails about public incidents and maintenance. Subscriptions are
offered when they are enabled in the settings of the management UI **and** a
transport (`smtp` or `log`) is configured. See [notifications.md](notifications.md)
for setup examples, deliverability and troubleshooting.

| Variable | Default | Description |
| --- | --- | --- |
| `MAIL_TRANSPORT` | `smtp` when `SMTP_HOST` is set, else `none` | `smtp` sends via SMTP, `log` writes emails to the server log instead of sending them (development only: the log then contains confirmation and manage links; with `NODE_ENV=production` their tokens are logged as `[redacted]`), `none` disables email. |
| `SMTP_HOST` | – | SMTP server, e.g. `smtp.example.com`. Required for `smtp`. |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_SECURE` | `false` | `true` = implicit TLS (usually port 465). With `false` the connection is upgraded with STARTTLS when the server offers it. |
| `SMTP_USER` | – | User name for SMTP authentication. Leave empty for relays without authentication. |
| `SMTP_PASSWORD` | – | Password for SMTP authentication. |
| `SMTP_FROM` | – | Sender, e.g. `Example Status <status@example.com>`. Required for `smtp` and `log`. |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | Verify the SMTP server certificate. Only set `false` for relays with self-signed certificates inside a trusted network. |
| `MAIL_DKIM_DIR` | – | Directory with the DKIM **public** keys of the bundled mail server (`<domain>.<selector>.txt` in zone-file format, as written by `rspamadm dkim_keygen` or `opendkim-genkey`). The **Email delivery** panel then shows the SPF, DKIM and DMARC records to publish for the domain of `SMTP_FROM`. Set by the Compose files and `scripts/install.sh` when the bundled Postfix is used; mount it read-only, it must never contain private keys. |

The bundled mail server (`postfix` service) is set up by the Compose files and
`scripts/install.sh`, not by the app. These variables only steer that setup:

| Variable | Default | Used by | Description |
| --- | --- | --- | --- |
| `COMPOSE_PROFILES` | – | Compose | `mail` starts the `postfix` service. |
| `MAIL_DOMAIN` | – | Compose, `install.sh` (`--mail-domain`) | Sender domain of the bundled mail server: mails come from `status@MAIL_DOMAIN`. With Compose it also sets `SMTP_HOST=postfix`, `SMTP_FROM` and `MAIL_DKIM_DIR` unless those are set in `.env`. |
| `MAIL_HOSTNAME` | `MAIL_DOMAIN` | Compose, `install.sh` (`--mail-hostname`) | Host name in the HELO greeting; should match the PTR record of the server's address. |
| `MAIL_RELAYHOST` | – | Compose, `install.sh` (`--mail-relayhost`) | Smarthost to send through, e.g. `[smtp.example.com]:587`. Without it the server delivers directly to the recipients' servers. |
| `MAIL_RELAYHOST_USERNAME`, `MAIL_RELAYHOST_PASSWORD` | – | Compose | Login of the smarthost (Compose only; `install.sh` does not set them). |
| `MAIL_SUBNET` | `172.30.250.0/28` (split: `172.30.251.0/28`) | Compose | Subnet of the internal network between app and `postfix`. Change it when it overlaps with a network of the host. |
| `DKIM_SELECTOR` | `osp` | Compose, `install.sh` (`--dkim-selector`) | DKIM selector: the DNS name is `<selector>._domainkey.<MAIL_DOMAIN>`. |

With Docker Compose every variable goes into the `.env` next to `compose.yaml`
(`deploy/compose/.env` in a clone); the whole file reaches the container and
`docker compose up -d` applies changes. `compose.yaml` itself sets `DATABASE_URL`,
`SECRET_KEY`, `HOST` and `PORT`, and the mail variables `SMTP_HOST`, `SMTP_FROM`
and `MAIL_DKIM_DIR` when `MAIL_DOMAIN` is set; a value in `.env` for the mail
variables wins. Use `HOST_PORT` for the published address and port (default
`127.0.0.1:3000`).

`BASE_URL` must be the public URL of the status page: all links in emails use it.
Confirmation and unsubscribe links are signed with `SUBSCRIPTION_TOKEN_KEY`
(default `SECRET_KEY`); changing it invalidates links in emails already sent.

## Webhooks and SMS

Webhooks (Discord, Slack, Microsoft Teams, generic JSON) and SMS are configured in
the management UI under **Administration → Webhooks & SMS**, not with environment
variables. See [webhooks-and-sms.md](webhooks-and-sms.md) for the
events, formats, delivery and the SMS providers, and the
[guide chapter](guide/en/14-webhooks-and-sms.md) for the set-up.

- Admin secrets (webhook URLs, extra header values, generic signing secrets and SMS
  provider credentials) are encrypted with `SECRET_KEY`, like the monitoring
  credentials. Changing `SECRET_KEY` makes them unreadable; they then have to be
  entered again.
- Visitor webhook URLs and phone numbers are encrypted with a key derived from
  `SUBSCRIPTION_TOKEN_KEY`. A split deployment therefore needs the same
  `SUBSCRIPTION_TOKEN_KEY` on the `public` instance (which does not get `SECRET_KEY`)
  and on the worker.
- Messages are sent by the background task `channel-delivery`, so they need a
  running worker (`WORKER_ENABLED=true` on one instance), like the email
  notifications.
- Every outgoing request goes through the SSRF guard: https only (http only for
  admin webhooks that allow it), no private or loopback addresses, no redirects.
  Nothing has to be configured for this.

## Search engines and AI agents

Search engines and AI agents need no settings of their own. The only variable is
`PUBLIC_BASE_URL` (default `BASE_URL`): it is the address of every canonical link,
alternate language link, sitemap entry, the `Sitemap:` line of `robots.txt`, the
links of `llms.txt` and the structured data. Set it to the public address of the
status page, with `https://`, also on the admin and worker instances of a split
deployment.

Per role the app answers:

- `public` and `all`: `/robots.txt` allows the public pages and the read-only
  `/api/public/` endpoints and disallows the subscription endpoints, the rest of
  `/api/`, `/admin`, `/subscription/`, `/preferences/` and `/pulse/` (the analytics
  proxy); `/sitemap.xml` indexes the
  navigation pages, the incident and maintenance sitemaps and the service sitemaps
  (`/sitemap-services-N.xml`, at most 5,000 URLs per file); `/llms.txt` and
  `/llms-full.txt` describe the page for language models.
- `admin`: `/robots.txt` answers `Disallow: /`, and every page (the management
  UI and the preview of the public pages) carries `X-Robots-Tag: noindex,
  nofollow`, so a URL linked from elsewhere is not indexed either. No sitemap is
  served.
- Pages of the status page that do not exist (`404`) and the personal
  subscription links carry `noindex`; filtered, searched and later pages
  carry `noindex, follow`. Other spellings of a page path (`/SERVICES/`) get a
  `301` to the canonical one.

Details: [architecture.md](architecture.md#search-engines-and-ai-agents). For
operators, the guide chapter [Search engines and the public page](guide/en/12-public-page.md)
explains the sitemap submission and the proxy rules.

## Analytics

Page views of the public pages can be counted with [Umami](https://umami.is), a
self-hostable analytics server without cookies. The browser never talks to Umami:
the status page serves the tracker script and takes its events under its own
paths and forwards them, so the page's Content-Security-Policy stays
`script-src 'self'; connect-src 'self'` and the Umami server can stay internal.
Umami 2.0 or later is needed (its `script.js` and `/api/send`; Umami 1 used other
paths). Versions that answer an event with JSON and older 2.x versions that
answer the session token as plain text both work.

| Variable | Default | Description |
| --- | --- | --- |
| `UMAMI_URL` | – | Base URL of the Umami server, e.g. `https://umami.example.com` or `http://umami:3000` (http or https, no query or fragment; a path prefix is allowed). Set it on every instance that serves public pages (`all`, `public`, and `admin` for its preview). Unset: no analytics, whatever the settings say. |

The upstream is an instance setting on purpose: the management UI only chooses the
website ID and the rules below, never which host the server connects to, so a
compromised admin account cannot point a public instance at internal hosts. Turn
analytics on in **Settings → Analytics (Umami)** (attributes in
[api.md](api.md#overview-settings-and-audit-log)): website ID (the UUID Umami shows for the website),
optional domains (`data-domains`), "Respect Do Not Track and Global Privacy
Control" (on by default) and "Pass visitors' IP addresses to Umami" (off by
default). Analytics runs only when `UMAMI_URL` is set **and** it is on with a
website ID; `GET /api/public/settings` reports `analyticsEnabled: true` only then.
`GET /api/admin/settings` carries the read-only `analyticsAvailable` (whether the
instance that answers has `UMAMI_URL`), and the settings page warns while
analytics is switched on without it.

Paths (served by `all`, `public` and `admin`, only with `UMAMI_URL`; they avoid the
names blocking lists look for, and `robots.txt` disallows them):

| Path | Upstream | Behaviour |
| --- | --- | --- |
| `GET /pulse/p.js` | `UMAMI_URL/script.js` | The tracker script. Fetched at most once an hour and kept in memory (one copy, at most 64 KiB, plus its gzip copy); an expired copy keeps answering while it is refreshed or when Umami is down (retry after a minute). Without any copy the answer is an empty script (`200`, `no-store`), so pages never log an error. 404 while analytics is off. Browsers cache it for an hour. 60 requests per minute per client. |
| `POST /pulse/api/send` | `UMAMI_URL/api/send` | One tracker event. `application/json` only (else `415`), at most 16 KiB (`413`), 120 requests per minute per client (`429`), at most 8 forwarded at a time by the instance and 2 per client address (more are dropped at once with `204`, so a slow Umami holds at most 8 connections and never delays the pages), 3 s timeout. Answers Umami's JSON on success (or, for older 2.x versions, its plain-text session token when it looks like one) and `204` without content in every other case (analytics off, event dropped, Umami slow, failing or redirecting). |

What reaches Umami:

- Only events for the configured website ID. Events of the personal subscription
  pages (`/subscription/...`) are dropped. The page URL and the referrer lose
  their `#fragment` and their `token` query parameters, together with the `id`
  next to a token (a referrer on a personal page, `/p/...` or
  `/subscription/...` of any host, becomes the root of that host).
  Rendered subscription pages carry no tracker at all.
- The event with the payload fields of Umami's tracker only (`website`,
  `hostname`, `url`, `referrer`, `title`, `language`, `screen`, `name`, `data`
  without a `token` key, `tag`), the visitor's `User-Agent` and Umami's own
  `x-umami-cache` session header. Never cookies or other request headers.
  Redirects are never followed.
- With "Respect Do Not Track" on, requests with `DNT: 1` or `Sec-GPC: 1` are
  dropped, and the tracker gets `data-do-not-track`.
- The visitor's IP address only with "Pass visitors' IP addresses to Umami" on,
  as `X-Forwarded-For` (the client address as the server sees it, so set
  `TRUST_PROXY` behind a reverse proxy; a header the client sends is never
  passed on).

**Limits of the counts.** The website ID is public (it is in every page), so
anyone can send made-up page views through the proxy, as with any Umami
tracker; the per-client rate limit only slows that down. While Umami is slow,
events beyond the 8 forwarded at a time are dropped, so a few busy clients can
crowd out real page views until Umami answers again (the cap of 2 per client
address keeps any single one from taking every slot).

**Umami's location and visitor counts.** Umami looks up the country and city of
an event from the client IP address (its GeoIP database, or headers such as
`CF-IPCountry` that it trusts) and counts unique visitors per website, IP
address and user agent (with a salt that changes monthly). Without the IP
address Umami only sees the status page server: every visitor appears at the
server's location (or none), and visitors with the same browser and operating
system version count as one visitor, so visitor numbers are too low while page
views stay correct. Forwarding the IP address gives Umami the real location and
counts; whether that is allowed depends on your privacy policy (Umami stores no
IP addresses, only the derived location and a hash).

Visitors turn statistics off with **Disable statistics** in the footer (in the
"Legal" navigation, after the privacy policy): a form that posts
`analytics=off` to `/preferences/analytics` and works without JavaScript. It
sets the cookie `osp-analytics=off` (one year, `SameSite=Lax`, no other data),
after which the pages are rendered without the tracker and say "Statistics are
disabled." with **Enable statistics** to undo it (removes the cookie). The cookie
is the only source of truth: with JavaScript the footer keeps Umami's own switch
`localStorage["umami.disabled"]` in line with it (set while opted out, removed
otherwise, on every page load and on submit), so the tracker of the page that is
open stops at once, and a lost cookie never leaves the tracker silently off. To
keep your own visits out of the statistics, use the footer switch in your
browser rather than setting `umami.disabled` by hand. Rendered pages are cached
per opt-out state, and `Vary: Cookie` tells shared caches the same. The
management UI (`/admin`) never loads the tracker.

## Rate limits

- `POST /api/auth/login`: 10 requests per minute per client IP. In addition, failed
  logins are counted per account (e-mail address), whatever the client IP: after 3
  failures each further one blocks that account's login for 1, 2, 4, ... seconds, at
  most 1 minute (`429` with `Retry-After`). Each attempt counts before its password
  is checked, so attempts sent at the same moment do not get past the limit. A
  success or 15 minutes without failure resets the count.
- `GET /api/auth/oidc/login` and `/api/auth/oidc/callback`, and the same routes of each provider
  (`/api/auth/oidc/<id>/login` and `/callback`): 30 requests per minute per client IP.
- `POST /api/admin/oidc-providers/test` and `POST /api/admin/oidc-providers/<id>/test`
  (*Test configuration*): 10 requests per minute.
- `POST /api/public/subscriptions` and the form `POST /subscribe`: 5 requests per minute
  per client IP together; the other
  subscription endpoints 30 requests per minute per client IP.
- Webhook and SMS subscriptions: `POST /api/public/channel-subscriptions`, `POST /subscribe/webhook`
  and `POST /subscribe/sms` share the 5 requests per minute of the email subscribe limit;
  `POST /api/public/channel-subscriptions/confirm` allows 10 requests per minute, the
  verify form `POST /subscription/verify` 10 per minute; the manage endpoints and forms
  (`/s/:id/:token`, `/subscription/channel`) 30 per minute per client IP. The delivery
  limits (per destination and minute, for visitor webhooks and SMS) are set under
  **Visitor subscriptions and limits** in the admin UI.
- Analytics proxy: `GET /pulse/p.js` 60 and `POST /pulse/api/send` 120 requests per
  minute per client IP (see [Analytics](#analytics)).
- `POST /api/admin/uploads` (image uploads): 30 requests per minute per client IP.
- `GET /uploads/<file>` (uploaded images on the public pages): 600 requests per minute per client IP.

Behind a reverse proxy set `TRUST_PROXY` (hop count or proxy addresses), otherwise all
clients share the proxy's IP. With a hop count the server logs a warning on start: it
trusts the nearest hop whatever its address, so the app port must only be reachable
through the proxy.

The counters live in the memory of each instance. With *n* instances behind a load
balancer a client can make up to *n* times as many requests. For exact limits route
each client to one instance (sticky sessions by client IP) or limit at the proxy.

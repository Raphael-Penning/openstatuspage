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
| `BASE_URL` | `http://localhost:3000` | URL of this instance, without trailing slash: the public URL of the status page, or the admin domain of an `admin` instance. Used for OIDC redirect URIs and ingest URLs, and for feed and email links unless `PUBLIC_BASE_URL` is set. When it starts with `https://` cookies are marked `Secure`. |
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
| `SECRET_KEY` | – (development fallback) | At least 32 characters, e.g. `openssl rand -base64 48`. Encrypts monitoring credentials at rest (AES-256-GCM) and signs cookies. **Required unless `NODE_ENV` is `development` or `test`, or `APP_ROLE=public` with `SUBSCRIPTION_TOKEN_KEY`.** Changing it makes stored monitoring credentials unreadable (they have to be re-entered). |
| `SUBSCRIPTION_TOKEN_KEY` | `SECRET_KEY` | At least 32 characters. Key of the email subscription links (confirm, manage, unsubscribe). A split deployment sets its own value, the same on every instance, and gives the `public` instance only this key instead of `SECRET_KEY`. Changing it invalidates links in emails already sent; the admin and worker instances refresh the stored token hashes on their next start. |
| `SESSION_TTL_HOURS` | `168` (7 days) | Session lifetime. The expiry slides: active sessions are extended, idle ones expire after this many hours. Range 1–2160. |
| `SESSION_MAX_AGE_HOURS` | `720` (30 days) | Absolute session lifetime, counted from the login. Active sessions are never extended past it, so everybody has to log in again (and SSO users pass the IdP checks again) at least this often. Range 1–8760, at least `SESSION_TTL_HOURS`; when unset and `SESSION_TTL_HOURS` is longer, that value is used. |

## Database

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite:./data/openstatuspage.db` | `sqlite:<path>` (use `sqlite::memory:` for throw-away instances) or `postgres://user:password@host:5432/database`. Migrations run automatically on start (except with `APP_ROLE=public`). |
| `ALLOW_UNRESTRICTED_PUBLIC_DB` | `false` | PostgreSQL, `APP_ROLE=public` only: a public instance refuses to start when its database login is not a registered public role (`DB_PUBLIC_ROLE`), because the database would not restrict it. `true` starts anyway and only logs a warning. |
| `DB_PUBLIC_ROLE` | `osp_public` | PostgreSQL only: the restricted login role of `APP_ROLE=public` instances (lower case letters, digits, `_`). Instances that migrate grant it read access to the public views and the subscription functions of schema `osp_public` on every start, once the role exists (create it with [`deploy/postgres/roles.sql`](../deploy/postgres/roles.sql)). See [security-model.md](security-model.md). |

## Initial administrator

Only used when the database contains no user at all.

| Variable | Default | Description |
| --- | --- | --- |
| `ADMIN_EMAIL` | – | E-mail of the first admin. |
| `ADMIN_PASSWORD` | – | Password of the first admin (at least 10 characters). Remove it from the environment after the first start. |

Alternatively create users with
`pnpm --filter @openstatuspage/server create-user <email> <password> [admin|editor] [name]`.

## Authentication

| Variable | Default | Description |
| --- | --- | --- |
| `LOCAL_LOGIN_ENABLED` | `true` | Allow e-mail/password login. Set to `false` for OIDC-only setups (make sure an OIDC user can become admin first). |
| `OIDC_ISSUER_URL` | – | Issuer URL of the OpenID Connect provider. OIDC is enabled when this and `OIDC_CLIENT_ID` are set. |
| `OIDC_CLIENT_ID` | – | Client ID registered at the IdP. |
| `OIDC_CLIENT_SECRET` | – | Client secret. Leave empty for public clients (PKCE only). |
| `OIDC_SCOPES` | `openid email profile` | Requested scopes. Add e.g. `groups` if your IdP needs a scope for the groups claim. |
| `OIDC_LABEL` | `Single Sign-On` | Label of the SSO button on the login page. |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim that contains the user's groups or roles. Dots address nested claims, e.g. `realm_access.roles`. |
| `OIDC_ADMIN_GROUP` | – | Members of this group become `admin`. |
| `OIDC_EDITOR_GROUP` | – | Members of this group become `editor`. When unset, every account of the IdP that matches an existing user may log in. |
| `OIDC_AUTO_CREATE_USERS` | `false` | Create a local user on the first OIDC login. When `false`, users must be created by an admin first. Only enable it together with `OIDC_ADMIN_GROUP`/`OIDC_EDITOR_GROUP`, otherwise every account of the IdP becomes an editor (the server logs a warning). |

See [oidc.md](oidc.md) for IdP setup and the role mapping rules.

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
| `/api/health` (reports `role` and `worker`) | ✓ | ✓ | ✓ | ✓ |
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
| `MAIL_TRANSPORT` | `smtp` when `SMTP_HOST` is set, else `none` | `smtp` sends via SMTP, `log` writes emails to the server log instead of sending them (development only, the log then contains confirmation links), `none` disables email. |
| `SMTP_HOST` | – | SMTP server, e.g. `smtp.example.com`. Required for `smtp`. |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_SECURE` | `false` | `true` = implicit TLS (usually port 465). With `false` the connection is upgraded with STARTTLS when the server offers it. |
| `SMTP_USER` | – | User name for SMTP authentication. Leave empty for relays without authentication. |
| `SMTP_PASSWORD` | – | Password for SMTP authentication. |
| `SMTP_FROM` | – | Sender, e.g. `Example Status <status@example.com>`. Required for `smtp` and `log`. |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | Verify the SMTP server certificate. Only set `false` for relays with self-signed certificates inside a trusted network. |

With Docker Compose every variable goes into the `.env` next to `compose.yaml`
(`deploy/compose/.env` in a clone); the whole file reaches the container and
`docker compose up -d` applies changes. Only `DATABASE_URL`, `HOST` and `PORT`
are set by `compose.yaml` itself (use `HOST_PORT` for the published port).

`BASE_URL` must be the public URL of the status page: all links in emails use it.
Confirmation and unsubscribe links are signed with `SUBSCRIPTION_TOKEN_KEY`
(default `SECRET_KEY`); changing it invalidates links in emails already sent.

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
  `/api/`, `/admin`, `/subscription/` and `/preferences/`; `/sitemap.xml` indexes the
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

## Rate limits

- `POST /api/auth/login`: 10 requests per minute per client IP.
- `GET /api/auth/oidc/login` and `/api/auth/oidc/callback`: 30 requests per minute per client IP.
- `POST /api/public/subscriptions`: 5 requests per minute per client IP; the other
  subscription endpoints 30 requests per minute per client IP.

Behind a reverse proxy set `TRUST_PROXY` (hop count or proxy addresses), otherwise all
clients share the proxy's IP.

The counters live in the memory of each instance. With *n* instances behind a load
balancer a client can make up to *n* times as many requests. For exact limits route
each client to one instance (sticky sessions by client IP) or limit at the proxy.

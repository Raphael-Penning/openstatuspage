# Architecture

```
apps/
  server/   Fastify API, status engine, monitoring adapters, background worker
  web/      React SPA: public status page (/) and management UI (/admin)
packages/
  shared/   zod schemas, API types and status vocabulary used by both apps
docker/     Dockerfile
deploy/     compose/ (Docker Compose, release assets) and kubernetes/ manifests
docs/       documentation
```

In production a single Node process serves the API and the built SPA.

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

## Memory

Target: less than 100 MB resident memory (RSS) per instance. Measured with
`scripts/measure-memory.mjs` (`pnpm measure:memory`) on Node 22 (v22.23.5,
linux/arm64, the production image) against PostgreSQL 17 with the demo seed. The
script starts the production build once per role, one instance at a time, and
puts light load on it: a login and the main admin lists (admin, all), 400 public
requests with 8 in parallel plus three subscriptions (public, admin, all), and a
monitoring source polled every 10 s from a local fake Uptime Kuma for 40 s
(worker, all). "After load" is read after 15 s without requests.

| Role | After start | Peak under load | After load | Kernel peak (VmHWM) |
| --- | --- | --- | --- | --- |
| public | 84 MB | 94 MB | 83 MB | 94 MB |
| admin | 90 MB | 102 MB | 90 MB | 111 MB |
| worker | 80 MB | 84 MB | 84 MB | 92 MB |
| all | 85 MB | 106 MB | 95 MB | 110 MB |
| all (SQLite) | 95 MB | 101 MB | 101 MB | 116 MB |

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
  `localeCompare`.
- **Bounded caches.** There is no response or query cache. The rate limiter
  keeps at most 1000 clients per route (`RATE_LIMIT_KEYS`), the per-source
  limiter of the ingest endpoints 10 000 keys. The web asset policy keeps only
  the file names of the public entry, never file contents.
- **Runtime flags** in the image (`docker/Dockerfile`):

  | Setting | Value | Why |
  | --- | --- | --- |
  | `NODE_OPTIONS` | `--max-semi-space-size=1 --max-old-space-size=96` | A 1 MB young generation (Node's default grows to 16 MB per semi-space) saves about 10 MB at little GC cost for short requests. The old generation cap turns a leak into a restart instead of swapping. |
  | `MALLOC_ARENA_MAX` | `2` | glibc creates a malloc arena per thread; two arenas save several MB of fragmented native memory. |
  | `UV_THREADPOOL_SIZE` | `2` | Every libuv thread that ran an Argon2 hash keeps 2–3 MB; two threads are plenty for file reads, DNS and password checks of a status page. |

  The health check of the image uses bash instead of a second node process
  (about 40 MB every 30 s inside the container's memory limit).

Raise the cap for a large history import on an admin instance, e.g.
`NODE_OPTIONS=--max-semi-space-size=1 --max-old-space-size=256`. Without the
image, set the same variables yourself to get the numbers above; without them
every role needs about 10 MB more.

To measure your own build: start a throwaway PostgreSQL, create the roles
(`deploy/postgres/roles.sql`), `pnpm -r build`, then

```sh
DATABASE_URL=postgres://owner:...@127.0.0.1:5432/osp_memory \
PUBLIC_DATABASE_URL=postgres://osp_public:...@127.0.0.1:5432/osp_memory \
MALLOC_ARENA_MAX=2 UV_THREADPOOL_SIZE=2 \
pnpm measure:memory --node-args="--max-semi-space-size=1 --max-old-space-size=96"
```

on an empty database. Use Linux (or the image) for comparable numbers: macOS
reports a larger RSS for the same process and has no `RssAnon`/`VmHWM`.

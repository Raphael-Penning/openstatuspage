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
- Subscription tokens are not stored at all (HMAC of `SECRET_KEY` and a salt).

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
- Subscription tokens are derived with HMAC-SHA256 from `SECRET_KEY` and a per
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

Tests: `apps/server/test/multi-instance.pg.test.ts` starts two worker instances
against one PostgreSQL database and checks that polls, mails and status history are
not duplicated. It runs when `TEST_POSTGRES_URL` is set (a server whose user may
create databases, e.g. a throwaway `postgres:17-alpine` container) and is skipped
otherwise.

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

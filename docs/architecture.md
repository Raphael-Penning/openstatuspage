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
- Rows are claimed before sending (conditional update of `next_attempt_at`), so a
  second worker would not send the same mail twice; still, run one worker only.

## Background worker

`Worker` (in-process interval tasks) runs:

- maintenance transitions (auto start/complete) every 30 s, notifying subscribers
- one poll task per enabled pull-capable monitoring source
- session cleanup (hourly)
- `email-delivery`: sends due outbox mails every 10 s
- `maintenance-reminders`: queues reminders every minute
- `notification-cleanup` (hourly): deletes unconfirmed subscriptions after 7 days and
  sent/failed mails after 30 days

Set `WORKER_ENABLED=false` on extra replicas so only one instance runs these tasks.

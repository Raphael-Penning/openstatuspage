# Architecture

```
apps/
  server/   Fastify API, status engine, monitoring adapters, background worker
  web/      React SPA: public status page (/) and management UI (/admin)
packages/
  shared/   zod schemas, API types and status vocabulary used by both apps
docker/     Dockerfile and docker-compose example
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

## Background worker

`Worker` (in-process interval tasks) runs:

- maintenance transitions (auto start/complete) every 30 s
- one poll task per enabled pull-capable monitoring source
- session cleanup

Set `WORKER_ENABLED=false` on extra replicas so only one instance polls.

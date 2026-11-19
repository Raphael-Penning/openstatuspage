# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/); before 1.0 a minor release may contain
breaking changes.

## [Unreleased] (0.2.0)

### Breaking changes

- **The HTTP API speaks [JSON:API 1.1](https://jsonapi.org/format/1.1/)**
  (`application/vnd.api+json`). There is no compatibility layer for the former
  plain JSON bodies. See [docs/api.md](docs/api.md) for the conventions.
  - Responses are documents with `data` (resource objects with `type`, `id`,
    `attributes`, `relationships`), `included`, `meta` and `links`.
  - Request bodies must be sent as `{ "data": { "type", "attributes", "relationships" } }`
    with `Content-Type: application/vnd.api+json` (ingest and webhook endpoints keep
    their native payloads).
  - Errors are `{ "errors": [{ "status", "code", "title", "detail", "source" }] }`.
  - Lists use `page[number]`, `page[size]` and `filter[name]` instead of `page`,
    `pageSize` and plain filter parameters.
  - Public API: `/api/public/history` filters are `filter[type]`, `filter[service]`,
    `filter[location]` and `filter[month]`; history entries are `incidents` and
    `maintenances` resources instead of `{ type, date, incident | maintenance }`.
  - Auth: login posts a `sessions` document and answers with `sessions/current`
    (the user is included); `/api/auth/config` is `auth-configs/current`.
  - `PUT` updates became partial `PATCH` updates: `/api/admin/users/:id`,
    `/api/admin/settings` and `/api/public/subscriptions/:id`.
  - Subscribe answers `202` with `meta.accepted`; confirm returns the
    `subscriptions` resource with the `manageToken` attribute; the RFC 8058
    one-click unsubscribe answers `204`.
  - Admin lists: `/api/admin/audit-log` takes `filter[entityType]`,
    `/api/admin/subscribers` takes `filter[q]` and `filter[status]`.
  - Admin catalog (services, service groups, locations, incidents, maintenance,
    corrections): `PUT` became a partial `PATCH`; foreign keys are relationships
    (`group`, `locations`, `services`); posting an incident or maintenance update
    creates an `incident-updates` / `maintenance-updates` resource (`201`) and its
    routes are `/incidents/:incidentId/updates/:id`; corrections are filtered with
    `filter[service]`, `filter[from]`, `filter[to]` and the service history with
    `filter[from]`, `filter[to]`.
  - Monitoring: sources are `monitor-sources` resources whose kind is the attribute
    `sourceType` (formerly `type`, which JSON:API reserves), also in
    `MonitorSourceInput`; `PUT` on sources and check bundles became a partial `PATCH`;
    `/api/admin/checks` filters are `filter[source]`, `filter[q]`, `filter[state]` and
    `filter[unlinked]`, bundle candidates use `filter[sourceType]`; rotate-token, test and
    poll answer meta documents.
  - Ingest responses are meta documents (`meta: { created, updated, removed,
    stateChanges }`) instead of `{ ok: true, ... }`.
  - All error responses are JSON:API error documents, also those of the routes that
    stay outside JSON:API; former `PUT` routes answer `404`.
  - Spec checks: `include` and `sort` are answered with `400`
    (`unsupported_include`, `unsupported_sort`) on endpoints that do not support
    them; a `data.id` in a create request with `403` `client_id_unsupported`;
    relationships of an unexpected name with `400` `unknown_relationship` and
    resource linkage of the wrong type with `409` `type_mismatch`. The reorder
    actions take documents of type `orderings`. Body errors use stable codes
    (`invalid_json`, `empty_body`, `payload_too_large`).
  - `/api/public/status.json` is removed (no alias) and replaced by
    `GET /api/public/status`, a JSON:API document with a `statuses/current`
    resource: attribute `overall` and `updatedAt`; relationships `services`,
    `activeIncidents` and `activeMaintenances` (resources included). The former
    `services[].group` name is the `service-groups` relationship of each service.
  - Unchanged: `/api/health` (now also reports `role` and `worker`) and the RSS/Atom
    feeds (plain formats, documented in [docs/api.md](docs/api.md)).
  - Migrating a client: send `Content-Type: application/vnd.api+json` and wrap
    bodies in `data`; read `data.attributes` (or use `deserialize()` from
    `@openstatuspage/shared`); replace `PUT` by `PATCH`; rename list parameters
    to `page[...]`/`filter[...]`; read error details from `errors[]`.

### Added

- **Split deployment** with `APP_ROLE` (`all`, `public`, `admin`, `worker`): on
  PostgreSQL the public status page, the management side and the background worker
  can run as separate instances. A `public` instance has no management UI, login,
  admin or ingest routes, serves a separate public-only web entry (`public.html`)
  without the management UI chunks, never connects to monitoring systems or sends
  mail, and never runs migrations (it waits for the expected schema,
  `SCHEMA_WAIT_SECONDS`). See [docs/configuration.md](docs/configuration.md#split-deployment).
- **Restricted database role for the public instance** (PostgreSQL): with
  `DB_PUBLIC_ROLE` (default `osp_public`, created with `deploy/postgres/roles.sql`)
  a public instance reads only views of public rows and columns (schema
  `osp_public`) and writes only through checked `SECURITY DEFINER` functions for
  email subscriptions; row level security policies back this up. Admin and worker
  instances grant the role on every start. Subscription tokens are additionally
  stored as SHA-256 hashes so the database can check them. A public instance
  whose login is not a registered public role refuses to start
  (`ALLOW_UNRESTRICTED_PUBLIC_DB=true` only warns). `deploy/postgres/roles.sql`
  also runs the new `deploy/postgres/harden.sql`: advisory locks only for the app
  role, no large objects or temporary tables for other roles. See
  [docs/security-model.md](docs/security-model.md).
  - Upgrading on PostgreSQL: migration `0007_public_role` needs PostgreSQL 11 or
    newer (15 or newer recommended). The schema `osp_public` also needs `CREATE`
    on the database for the migrating role. Without it the upgrade still
    succeeds: the schema is left out and the log says how to add it. It is only
    needed for `APP_ROLE=public`. After `GRANT CREATE ON DATABASE <database> TO <role>`
    the next start of an admin, worker or all instance creates it. A failing
    migration now logs its cause.
- `PUBLIC_BASE_URL` (default `BASE_URL`): the public URL used for every link in
  emails and feeds. Admin and worker instances of a split deployment set it, so
  mails written on the admin instance link to the public page and its one-click
  unsubscribe endpoint instead of the admin domain.
- `SUBSCRIPTION_TOKEN_KEY` (default `SECRET_KEY`): the key of the subscription
  links. A public instance runs with this key alone, so a compromised public host
  holds neither the key of the monitoring credentials nor the one that signs the
  OIDC state cookie. The split examples give it only `SUBSCRIPTION_TOKEN_KEY`.
- `WORKER_ENABLED` defaults to `false` for `APP_ROLE=admin`; contradicting settings
  stop the server on start.
- **Several instances with background tasks** on PostgreSQL: every task (and the
  poll of every monitoring source) runs under a lease in the new `task_leases`
  table, so it runs on one instance at a time and once per interval across the
  deployment; an instance that stops is replaced within a minute. Status and
  bundle recomputes are serialised with advisory locks, and only one history
  import per source can be active, also across admin instances. Rate limits stay
  per instance. See [docs/architecture.md](docs/architecture.md#several-instances).
- `pnpm measure:memory` (`scripts/measure-memory.mjs`) measures the memory of every
  `APP_ROLE` under light load. The results are in
  [docs/architecture.md](docs/architecture.md#memory).
- Split deployment examples: [`deploy/compose/compose.split.yaml`](deploy/compose/compose.split.yaml)
  (public, admin and worker containers on one PostgreSQL database; the public role
  and the non-superuser app role `osp_app` of admin and worker are created by
  [`deploy/postgres/init-roles.sh`](deploy/postgres/init-roles.sh)) and the
  Kustomize overlay [`deploy/kubernetes/split/`](deploy/kubernetes/split/). See the
  [split deployment guide](docs/guide/en/02-installation.md#split-deployment).

### Changed

- **Less memory per instance**: about 80–100 MB instead of 100–130 MB with the
  Docker image. The server build bundles and minifies its dependencies, every role
  loads only its own routes, and nodemailer, openid-client, argon2 and the history
  importers load on first use. The image sets `NODE_OPTIONS`
  (`--max-semi-space-size=1 --max-old-space-size=96`), `MALLOC_ARENA_MAX=2` and
  `UV_THREADPOOL_SIZE=2`; raise `--max-old-space-size` for large history imports.
  Its health check no longer starts a second node process. The Kubernetes example
  requests 128 MiB (limit 256 MiB).

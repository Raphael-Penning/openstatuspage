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
- `WORKER_ENABLED` defaults to `false` for `APP_ROLE=admin`; contradicting settings
  stop the server on start.

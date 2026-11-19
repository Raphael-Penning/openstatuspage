# HTTP API

The API follows [JSON:API 1.1](https://jsonapi.org/format/1.1/) (since 0.2.0, a
breaking change; there is no compatibility layer for the former plain JSON format).
Attribute types live in [`packages/shared/src/schemas.ts`](../packages/shared/src/schemas.ts),
the JSON:API document types and helpers in
[`packages/shared/src/jsonapi.ts`](../packages/shared/src/jsonapi.ts).
Request attributes are validated with the zod schemas named below.

> The public API (`/api/public/*`) is converted. Sections below that still show
> plain bodies are being converted to the same conventions.

## Conventions

### Media type and negotiation

- Every JSON:API response is `Content-Type: application/vnd.api+json` and carries
  `"jsonapi": { "version": "1.1" }`.
- Requests with a body must send `Content-Type: application/vnd.api+json`. Any media
  type parameter other than `profile` (including `ext`: no extensions are
  implemented) is answered with `415 Unsupported Media Type`.
- When every `application/vnd.api+json` entry in `Accept` carries such parameters, the
  answer is `406 Not Acceptable`. `Accept: */*` or no `Accept` header is fine.
- Exceptions (not JSON:API): `/api/health`, `/api/public/status.json`, the RSS/Atom
  feeds, OIDC redirects and email confirmation links that redirect to HTML. Ingest
  and webhook endpoints accept the native payloads of the monitoring systems; their
  responses are JSON:API.

### Resource objects

- `type` is the kebab-case plural (`services`, `service-groups`, `incidents`,
  `incident-updates`, `maintenances`, `locations`, ...), `id` a string.
- `attributes` use the camelCase field names of the types in `schemas.ts`.
- Foreign keys are `relationships` with resource identifier objects. A to-one
  relationship `group` corresponds to the field `groupId`, a to-many relationship
  `services` to `serviceIds` (the shared deserializer flattens them that way).
- Complex value objects stay attributes (e.g. `uptime: DailyUptime[]`,
  `affectedServices` with the impact per service).
- Singletons have a stable id: `settings/site`, `summaries/current`, `sessions/current`,
  `auth-configs/current`, `overviews/current`, `notification-statuses/current`.
- Resources carry `links.self` where they can be fetched on their own; documents
  carry a top-level `links.self` (relative URLs).

### Compound documents

Related resources needed by the UI are part of the response (`included`). The
`include` query parameter selects them explicitly (comma-separated paths, empty
value for none); unsupported paths are answered with `400` and
`source.parameter = "include"`. Without `include`, the defaults listed per endpoint
are included.

### Collections

- Pagination: `page[number]` (1-based) and `page[size]` (default 20, max 100).
  Paginated documents carry `meta.total`, `meta.page = { number, size }` and
  `links.first/prev/next/last` (`prev`/`next` are `null` at the ends).
- Filters: `filter[name]=value`. Unknown filters are answered with `400`.
- Sorting: `sort=field,-other` where an endpoint lists sortable fields.
- Collections without pagination still carry `meta.total`.

### Writing

- Create: `POST` to the collection with `{ "data": { "type", "attributes", "relationships" } }`
  answers `201 Created` with a `Location` header and the new resource.
- Update: `PATCH` the resource (partial attributes). A `data.id` that differs from
  the URL or another `data.type` than the endpoint expects is answered with `409`.
- Delete: `204 No Content` without a body.
- Actions (login, logout, rotate token, test, poll, apply import, resend, confirm)
  are `POST` endpoints returning a resource document, a meta-only document
  (`{ "jsonapi": ..., "meta": { ... } }`) or `204`.

```http
POST /api/admin/services
Content-Type: application/vnd.api+json

{
  "data": {
    "type": "services",
    "attributes": { "name": "Public API", "kind": "service" },
    "relationships": {
      "group": { "data": { "type": "service-groups", "id": "1b6f…" } },
      "locations": { "data": [{ "type": "locations", "id": "9c2e…" }] }
    }
  }
}
```

### Errors

Every error status (400, 401, 403, 404, 406, 409, 415, 429, 500) uses an error document:

```json
{
  "jsonapi": { "version": "1.1" },
  "errors": [
    {
      "status": "400",
      "code": "too_small",
      "title": "Invalid request",
      "detail": "Too small: expected string to have >=1 characters",
      "source": { "pointer": "/data/attributes/name" },
      "meta": { "origin": "string", "minimum": 1 }
    }
  ]
}
```

- Validation errors produce one error per issue. `code` is the zod issue code,
  further issue details are in `meta`, `source.pointer` points into the request
  document (`/data/attributes/<field>`, or `/data/relationships/<name>` for fields
  sent as relationships). Bad query parameters use `source.parameter`.
- Other errors carry a stable snake_case `code` (`not_found`, `conflict`,
  `unauthorized`, `forbidden`, `rate_limited`, `unsupported_media_type`,
  `not_acceptable`, `invalid_document`, `type_mismatch`, `unsupported_include`, ...).
- Other conventions: timestamps are ISO-8601 UTC strings; slugs are generated from the
  name when not provided, duplicates get a numeric suffix.

## Public API (no authentication)

Only public entities are returned (`is_public = 1`). **Nothing about monitoring
sources or checks is ever exposed here**: no check names, hosts, outputs, IPs or counts.
Responses may be cached (`Cache-Control: public, max-age=30`).

| Method | Path | Primary data | Included by default |
| --- | --- | --- | --- |
| GET | `/api/public/summary` | `summaries/current`: `overall`, `emailSubscriptions`, `generatedAt`; relationships `page` (settings), `groups`, `ungrouped` (services), `activeIncidents`, `recentIncidents`, `activeMaintenances`, `upcomingMaintenances` | everything referenced (settings, groups, services incl. uptime, incidents and maintenance with their updates) |
| GET | `/api/public/settings` | `settings/site` (`PublicPageSettings`) | – |
| GET | `/api/public/services` | `services[]` in display order (grouped services in group order, then ungrouped), `meta.counts: Record<ServiceStatus, number>` | the `service-groups` |
| GET | `/api/public/services/:idOrSlug` | `services` incl. `uptime: DailyUptime[]`; relationships `incidents` (last 90 days and unresolved), `maintenances` (active and upcoming) | `include`: `incidents`, `incidents.updates`, `maintenances`, `maintenances.updates` (default: all) |
| GET | `/api/public/locations` | `locations[]` (relationship `services`), `meta.counts`; 404 when `showLocations` is disabled | – |
| GET | `/api/public/incidents/:id` | `incidents` (relationships `locations`, `updates`) | `include`: `updates` (default) |
| GET | `/api/public/maintenances/:id` | `maintenances` (relationships `locations`, `updates`) | `include`: `updates` (default) |
| GET | `/api/public/history` | heterogeneous, paginated collection of `incidents` and `maintenances`, newest first (incidents by `startedAt`, maintenance by `scheduledStart`); includes active and resolved items, excludes maintenance scheduled in the future. Filters: `filter[type]` (`all`, `incident`, `maintenance`), `filter[service]`, `filter[location]` (public ids), `filter[month]` (`YYYY-MM`) | `include`: `updates` (default) |
| GET | `/api/public/status.json` | **Not JSON:API** (stable format for third-party tools): `{ overall, updatedAt, services: [{ id, name, group, status }], activeIncidents: [{ id, title, status, impact }], activeMaintenances: [{ id, title, scheduledEnd }] }` | |
| GET | `/feed.rss`, `/feed.atom` | RSS 2.0 / Atom feed of incidents and maintenance (last 50 items) | |

Example (`GET /api/public/incidents/7d0c…`):

```json
{
  "jsonapi": { "version": "1.1" },
  "data": {
    "type": "incidents",
    "id": "7d0c…",
    "attributes": {
      "title": "Database outage",
      "status": "investigating",
      "impact": "major",
      "startedAt": "2026-11-19T08:00:00.000Z",
      "resolvedAt": null,
      "updatedAt": "2026-11-19T08:05:00.000Z",
      "affectedServices": [{ "id": "1b6f…", "name": "Public API", "status": "major_outage" }]
    },
    "relationships": {
      "locations": { "data": [{ "type": "locations", "id": "9c2e…" }] },
      "updates": { "data": [{ "type": "incident-updates", "id": "a41f…" }] }
    },
    "links": { "self": "/api/public/incidents/7d0c…" }
  },
  "included": [
    {
      "type": "incident-updates",
      "id": "a41f…",
      "attributes": { "status": "investigating", "message": "We are investigating.", "createdAt": "2026-11-19T08:05:00.000Z" }
    }
  ],
  "links": { "self": "/api/public/incidents/7d0c…" }
}
```

Example (`GET /api/public/history?filter[type]=incident&page[number]=2&page[size]=10`):

```json
{
  "jsonapi": { "version": "1.1" },
  "data": [{ "type": "incidents", "id": "…", "attributes": { "…": "…" }, "relationships": { "…": "…" } }],
  "included": [{ "type": "incident-updates", "id": "…", "attributes": { "…": "…" } }],
  "meta": { "total": 25, "page": { "number": 2, "size": 10 } },
  "links": {
    "self": "/api/public/history?filter[type]=incident&page[number]=2&page[size]=10",
    "first": "/api/public/history?filter[type]=incident&page[number]=1&page[size]=10",
    "prev": "/api/public/history?filter[type]=incident&page[number]=1&page[size]=10",
    "next": "/api/public/history?filter[type]=incident&page[number]=3&page[size]=10",
    "last": "/api/public/history?filter[type]=incident&page[number]=3&page[size]=10"
  }
}
```

Uptime (`uptime`, `uptimePercent`) is computed from the **corrected** history
(see [History corrections](#history-corrections)). A `DailyUptime` entry of a day
in which a correction marked public is in effect carries `corrected: true` and
`correctionNotes: string[]` (the public notes, possibly empty). The marker is
derived from the corrected history: where a newer correction replaces a public
one, that part no longer marks the day. The internal
reason of a correction is never returned by public endpoints.

Upcoming maintenance = `status = scheduled` and `scheduled_end > now`.
Active maintenance = `status = in_progress`.
Active incidents = `status != resolved`.

The summary attribute `emailSubscriptions` is `true` when email subscriptions are enabled in
the settings and a mail transport is configured (the page then offers the subscribe form).

## Email subscriptions (`/api/public/subscriptions`, no authentication)

Double opt-in; see [notifications.md](notifications.md). Responses are sent with
`Cache-Control: no-store`. Unknown ids and wrong tokens get the same `404`.

A subscription is a `subscriptions` resource (`PublicSubscription`): attributes
`email`, `locale`, `allServices`, `confirmed`; the selected services are the
`services` relationship (`serviceIds` on the plain object).

| Method | Path | Body / auth | Response |
| --- | --- | --- | --- |
| POST | `/api/public/subscriptions` | `subscriptions` document (`SubscribeInput`, `serviceIds` as the `services` relationship) | `202` with the meta-only document `{ "meta": { "accepted": true } }` for every valid input (new, pending or confirmed address, so addresses cannot be enumerated; also for a filled-in honeypot, see below). `404` when subscriptions are not available, `400` on invalid input or unknown/non-public services. Rate limited (5/min per IP). |
| POST | `/api/public/subscriptions/:id/confirm` | `subscriptions` document with the attribute `token` (`SubscriptionConfirmInput`, token from the confirmation link) | the subscription; only this response also has the attribute `manageToken`; idempotent |
| GET | `/api/public/subscriptions/:id` | header `X-Subscription-Token: <manageToken>` | the subscription |
| PATCH | `/api/public/subscriptions/:id` | header as above, `subscriptions` document (`SubscriptionPreferencesInput`, partial) | the subscription |
| DELETE | `/api/public/subscriptions/:id` | header as above | `204`, deletes the subscriber completely |
| POST | `/api/public/subscriptions/:id/unsubscribe?token=<manageToken>` | empty or `List-Unsubscribe=One-Click` (form encoded, not JSON:API) | `204`, deletes the subscriber (RFC 8058 one-click, used by the `List-Unsubscribe` header) |
| GET | `/api/public/subscriptions/:id/unsubscribe?token=<manageToken>` | – | not JSON:API: `303` to the manage page with the unsubscribe confirmation, `${BASE_URL}/subscription/manage?id=<id>&unsubscribe=1#token=<manageToken>` (never deletes) |

```http
POST /api/public/subscriptions
Content-Type: application/vnd.api+json

{
  "data": {
    "type": "subscriptions",
    "attributes": { "email": "jane@example.com", "locale": "en", "allServices": false },
    "relationships": { "services": { "data": [{ "type": "services", "id": "3f0c…" }] } }
  }
}
```

```http
POST /api/public/subscriptions/8d1e…/confirm
Content-Type: application/vnd.api+json

{ "data": { "type": "subscriptions", "attributes": { "token": "<confirmToken>" } } }
```

```json
{
  "jsonapi": { "version": "1.1" },
  "data": {
    "type": "subscriptions",
    "id": "8d1e…",
    "attributes": { "email": "jane@example.com", "locale": "en", "allServices": false, "confirmed": true, "manageToken": "<manageToken>" },
    "relationships": { "services": { "data": [{ "type": "services", "id": "3f0c…" }] } },
    "links": { "self": "/api/public/subscriptions/8d1e…" }
  }
}
```

Behaviour of `POST /api/public/subscriptions`:

- new address: pending subscriber, confirmation email;
- pending address: preferences unchanged, confirmation email sent again (the
  choice can be changed on the manage page after confirming);
- confirmed address: preferences unchanged, email with the manage link;
- `website` (honeypot, any string up to 500 characters) not empty: answered exactly
  like a successful subscribe (`202`, `meta.accepted`), but nothing is created and no
  email is sent. Real visitors never see the field.

The input is validated (`400`) before answering; everything that depends on the
address runs after the `202` has been sent, so the response time does not reveal
whether an address is subscribed either. At most one confirmation/manage email
per address every 10 minutes. The endpoints
other than subscribe keep working when subscriptions are disabled later, so
subscribers can always unsubscribe. Rate limit for the token endpoints: 30/min per IP.

Links in emails (web client routes). The token is in the URL fragment, so it never
reaches the server, proxies or access logs; the web client reads it from the
fragment and sends it in the request body (confirm) or the `X-Subscription-Token`
header (manage):

- confirm: `${BASE_URL}/subscription/confirm?id=<id>#token=<confirmToken>`
- manage: `${BASE_URL}/subscription/manage?id=<id>#token=<manageToken>`
- unsubscribe (email body): `${BASE_URL}/subscription/manage?id=<id>&unsubscribe=1#token=<manageToken>`

Only the RFC 8058 `List-Unsubscribe` header keeps the token in the query string
(`/api/public/subscriptions/:id/unsubscribe?token=`), since mail clients post to it
directly. The server log redacts the value of every `token` query parameter
(`token=[REDACTED]`).

## Auth (`/api/auth`)

The signed-in session is the singleton `sessions/current` (attribute `oidcEnabled`,
to-one relationship `user` to a `users` resource, which is always included). The
OIDC routes are browser redirects, not JSON:API.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/auth/config` | – | `auth-configs/current` (`AuthConfig`) |
| POST | `/api/auth/login` | `sessions` document (`LoginInput`); another type is `409` | `200` with the session document, sets cookie `osp_session` (httpOnly, sameSite=lax, secure when BASE_URL is https). Wrong credentials: `401` `invalid_credentials`. Rate limited (10/min per IP). |
| POST | `/api/auth/logout` | – | 204, clears cookie and deletes the session |
| GET | `/api/auth/session` | – | the session document or 401 |
| POST | `/api/auth/password` | `passwords` document (`ChangePasswordInput`) | 204; a wrong current password is `400` `invalid_password` |
| GET | `/api/auth/oidc/login` | – | 302 to the IdP (PKCE + state + nonce stored in a signed short-lived cookie) |
| GET | `/api/auth/oidc/callback` | – | 302 to `/admin` after login, or `/admin/login?error=<code>` |

```http
POST /api/auth/login
Content-Type: application/vnd.api+json

{ "data": { "type": "sessions", "attributes": { "email": "admin@example.com", "password": "…" } } }
```

```json
{
  "jsonapi": { "version": "1.1" },
  "data": {
    "type": "sessions",
    "id": "current",
    "attributes": { "oidcEnabled": false },
    "relationships": { "user": { "data": { "type": "users", "id": "5a7b…" } } },
    "links": { "self": "/api/auth/session" }
  },
  "included": [
    {
      "type": "users",
      "id": "5a7b…",
      "attributes": { "email": "admin@example.com", "name": "Ada", "role": "admin", "hasPassword": true, "oidcLinked": false, "createdAt": "…", "lastLoginAt": "…" },
      "links": { "self": "/api/admin/users/5a7b…" }
    }
  ],
  "links": { "self": "/api/auth/session" }
}
```

Sessions: random 32-byte token in the cookie, SHA-256 of it stored in `sessions.id`.
Expired sessions are deleted lazily and by a periodic cleanup task.

## Admin API (`/api/admin`)

Authentication: session cookie **or** `Authorization: Bearer <api token>`.
Roles: `editor` may manage incidents, maintenance, history corrections and read everything;
`admin` may additionally manage services, groups, locations, monitoring sources,
check bundles, settings, users and API tokens. Every mutating call writes an audit log entry.

Cookie-authenticated mutating requests must send the header `X-Requested-With: openstatuspage`
(simple CSRF protection; the web client always sends it). Bearer-token requests are exempt.

| Method | Path | Body | Response | Role |
| --- | --- | --- | --- | --- |
| GET | `/api/admin/overview` | – | `overviews/current`: attribute `counts: { services, incidentsActive, maintenancesActive, maintenancesUpcoming, sources, sourcesFailing, checks, checksFailing }`, relationships `services` (`services`, non-operational first) and `recentAudit` (`audit-entries`), both included; source and check counts leave out the virtual check bundle source and its checks; editors only get `incident` and `maintenance` audit entries | editor |
| GET/PATCH | `/api/admin/settings` | `settings` document (`SettingsInput`, partial: omitted attributes keep their value) | `settings/site` (`PublicPageSettings`) | GET editor, PATCH admin |
| GET | `/api/admin/locations` | – | `AdminLocation[]` | editor |
| POST | `/api/admin/locations` | `LocationInput` | `AdminLocation` (201) | admin |
| GET/PUT/DELETE | `/api/admin/locations/:id` | `LocationInput` | `AdminLocation` | GET editor, else admin |
| POST | `/api/admin/locations/reorder` | `ReorderInput` | 204 | admin |
| GET | `/api/admin/service-groups` | – | `AdminServiceGroup[]` | editor |
| POST | `/api/admin/service-groups` | `ServiceGroupInput` | `AdminServiceGroup` (201) | admin |
| GET/PUT/DELETE | `/api/admin/service-groups/:id` | `ServiceGroupInput` | `AdminServiceGroup` | GET editor, else admin |
| POST | `/api/admin/service-groups/reorder` | `ReorderInput` | 204 | admin |
| GET | `/api/admin/services` | – | `AdminService[]` | editor |
| POST | `/api/admin/services` | `ServiceInput` | `AdminService` (201) | admin |
| GET/PUT/DELETE | `/api/admin/services/:id` | `ServiceInput` | `AdminService` | GET editor, else admin |
| POST | `/api/admin/services/reorder` | `ReorderInput` (within one group) | 204 | admin |
| GET | `/api/admin/services/:id/preview` | – | `{ monitorStatus, status }` computed with the stored config (for the service builder) | editor |
| POST | `/api/admin/services/preview` | `ServiceInput` | `{ monitorStatus: ServiceStatus }` computed for an unsaved config | admin |
| GET | `/api/admin/incidents` | query `status=active\|resolved\|all`, `page`, `pageSize` | `Paginated<AdminIncident>` | editor |
| POST | `/api/admin/incidents` | `IncidentCreateInput` | `AdminIncident` (201) | editor |
| GET/PATCH/DELETE | `/api/admin/incidents/:id` | `IncidentPatchInput` | `AdminIncident` | editor |
| POST | `/api/admin/incidents/:id/updates` | `IncidentUpdateInput` | `AdminIncident` | editor |
| PATCH/DELETE | `/api/admin/incidents/:id/updates/:updateId` | `IncidentUpdateEditInput` | `AdminIncident` | editor |
| GET | `/api/admin/maintenances` | query `status=upcoming\|active\|past\|all`, `page`, `pageSize` | `Paginated<AdminMaintenance>` | editor |
| POST | `/api/admin/maintenances` | `MaintenanceCreateInput` | `AdminMaintenance` (201) | editor |
| GET/PATCH/DELETE | `/api/admin/maintenances/:id` | `MaintenancePatchInput` | `AdminMaintenance` | editor |
| POST | `/api/admin/maintenances/:id/updates` | `MaintenanceUpdateInput` | `AdminMaintenance` | editor |
| GET | `/api/admin/corrections` | query `CorrectionListQuery` (`serviceId`, `from`, `to` = overlapping the range, `page`, `pageSize`) | `Paginated<AdminCorrection>` (newest start first) | editor |
| POST | `/api/admin/corrections` | `CorrectionInput` | `AdminCorrection` (201) | editor |
| GET/PATCH/DELETE | `/api/admin/corrections/:id` | `CorrectionPatchInput` | `AdminCorrection` | editor |
| GET | `/api/admin/services/:id/history` | query `ServiceHistoryQuery` (`from`, `to`, at most 366 days) | `AdminServiceHistory` (measured and corrected segments and uptime) | editor |
| GET | `/api/admin/monitor-sources` | – | `AdminMonitorSource[]` | admin |
| POST | `/api/admin/monitor-sources` | `MonitorSourceInput` | `AdminMonitorSource & { ingestToken: string }` (201, token shown once) | admin |
| GET/PUT/DELETE | `/api/admin/monitor-sources/:id` | `MonitorSourceInput` (secrets equal to `SECRET_MASK` keep the stored value; only while type, `baseUrl` and `username` (`historyUsername` for `historyPassword`) are unchanged, otherwise 400; `icingaDbUrl` is kept regardless) | `AdminMonitorSource` | admin |
| POST | `/api/admin/monitor-sources/:id/test` | – | `MonitorSourceTestResult` | admin |
| POST | `/api/admin/monitor-sources/:id/poll` | – | `MonitorSourceTestResult` (polls now and stores the results) | admin |
| POST | `/api/admin/monitor-sources/:id/rotate-token` | – | `{ ingestToken: string }` | admin |
| GET | `/api/admin/monitor-sources/:id/history-imports` | – | `AdminHistoryImport[]` (latest 20, newest first) | admin |
| POST | `/api/admin/monitor-sources/:id/history-imports` | `HistoryImportCreateInput` (body up to ~10 MB for CSV) | `AdminHistoryImport` (202, status `fetching`) | admin |
| GET | `/api/admin/monitor-sources/:id/history-imports/:importId` | – | `AdminHistoryImport` with `progress`, `preview` (status `ready`) or `result` | admin |
| POST | `/api/admin/monitor-sources/:id/history-imports/:importId/apply` | – | `AdminHistoryImport` (202, status `applying`; 409 unless `ready`) | admin |
| POST | `/api/admin/monitor-sources/:id/history-imports/:importId/cancel` | – | `AdminHistoryImport` (aborts `fetching`, discards `ready`; 409 otherwise) | admin |
| GET | `/api/admin/checks` | query `sourceId`, `q` (search name/host/external id), `state`, `unlinked=true` | `AdminMonitorCheck[]` (`sourceType` is `bundle` for bundle checks) | editor |
| DELETE | `/api/admin/checks/:id` | – | 204 (409 for the check of a bundle: delete the bundle) | admin |
| GET | `/api/admin/check-bundles` | – | `AdminCheckBundle[]` with the live vote and per-member breakdown | admin |
| GET | `/api/admin/check-bundles/candidates` | query `type` (configurable source type) | `BundleCandidateSource[]`: checks that can become members, grouped by source | admin |
| POST | `/api/admin/check-bundles` | `CheckBundleInput` | `AdminCheckBundle` (201) | admin |
| GET/PUT/DELETE | `/api/admin/check-bundles/:id` | `CheckBundleInput` (members are replaced) | `AdminCheckBundle`; DELETE 204 removes the bundle check and its service links | admin |
| GET | `/api/admin/users` | – | collection of `users` (`AdminUser`), by name | admin |
| POST | `/api/admin/users` | `users` document (`UserCreateInput`) | the user (201, `Location`) | admin |
| GET/PATCH/DELETE | `/api/admin/users/:id` | `users` document (`UserUpdateInput`, partial) | the user; DELETE 204 (cannot delete or demote yourself / the last admin: 409) | admin |
| GET | `/api/admin/api-tokens` | – | collection of `api-tokens` (`AdminApiToken`), newest first | admin |
| POST | `/api/admin/api-tokens` | `api-tokens` document (`ApiTokenCreateInput`) | the token (201, `Location`); only this response has the attribute `token`; created with a token, the new token belongs to that token's owner | admin |
| DELETE | `/api/admin/api-tokens/:id` | – | 204 | admin |
| GET | `/api/admin/subscribers` | `page[number]`, `page[size]` (default 50), `filter[q]` (email substring), `filter[status]=all\|confirmed\|pending` | paginated `subscribers` (`AdminSubscriber`, newest first); relationship `services` with the selected services included (`name` only) | admin |
| DELETE | `/api/admin/subscribers/:id` | – | 204 (audit `subscriber.delete` with masked address) | admin |
| GET | `/api/admin/notifications/status` | – | `notification-statuses/current` (`NotificationStatus`) | admin |
| POST | `/api/admin/notifications/test` | `test-emails` document (`TestEmailInput`) | meta-only document `{ "meta": { "ok": boolean, "message": string } }`; sends immediately (not queued); 409 without transport | admin |
| POST | `/api/admin/notifications/retry-failed` | – | meta-only document `{ "meta": { "requeued": number } }` | admin |
| GET | `/api/admin/audit-log` | `page[number]`, `page[size]`, `filter[entityType]` | paginated `audit-entries` (`AuditLogEntry`, newest first); relationship `user` (the acting user, `null` for API tokens and deleted users; `userName` stays an attribute) | admin |

API tokens are revoked when their creator is deleted; admin tokens are revoked when
their creator loses the admin role.

### Side effects the server must apply

- Creating/updating/resolving incidents, changing their affected services, starting/
  completing/cancelling maintenance, editing services (mode, manual status, checks)
  and deleting checks must call `ctx.engine.recompute(serviceIds)` for every
  service that was affected **before and after** the change.
- Posting an incident update with `status = resolved` sets `resolved_at`;
  posting a non-resolved status on a resolved incident re-opens it (`resolved_at = null`).
- Maintenance update `in_progress` sets `actual_start` (if empty), `completed`/`cancelled`
  sets `actual_end`.

### Behaviour details

- `POST .../incidents/:id/updates` and `POST .../maintenances/:id/updates` return `200`
  with the full object; `DELETE .../incidents/:id/updates/:updateId` returns `204`
  (an incident keeps at least one update, deleting the last one is `409`).
- `PATCH /api/admin/incidents/:id` accepts `resolvedAt` only for resolved incidents
  (to correct the time); resolving and re-opening is done by posting an update.
- Creating a maintenance adds a first `scheduled` update with an empty message
  (clients render a localized default text). Windows that are already due are
  started/completed right away instead of on the next worker tick.
- Retroactive maintenance (`AdminMaintenance.retroactive`): a window whose end is
  not after the creation time is created directly as `completed` with
  `actualStart`/`actualEnd` = the window and `in_progress`/`completed` updates at
  those times; **no** email is queued (no announcement, reminder or transition).
  A window with `autoStart` that started at least 5 minutes before the creation
  time and has not ended is created as `in_progress` (`actualStart` = scheduled
  start, one `in_progress` update at that time); only that "in progress" email is
  queued (if `notify` and public), no announcement. Windows starting later or
  without `autoStart` behave as before. Changing the window of a retroactive
  maintenance keeps `actualStart` (and, when completed, `actualEnd`, which must
  then not be in the future) in line with it.
- `PUT` bodies are complete objects (schema defaults apply to omitted fields);
  an omitted `slug` keeps the current slug. An explicit slug that is taken is `409`.
- `PATCH /api/admin/users/:id` with `password: null` removes the local password
  (not allowed for yourself). Changing a password signs that user out everywhere.
- Mutations through API tokens are audited with `userId = null` and
  `details.apiToken = <token name>`; logins are audited as `auth.login`.
- API tokens are prefixed with `osp_`.
- `/api/public/history?locationId=` matches items linked to the location directly
  or affecting a service running there. Filters referencing non-public entities
  return an empty page.
- Check bundles: each bundle owns a check of the built-in source of type `bundle`
  (`AdminCheckBundle.checkId`) that is linked to services like any check. That
  source answers `409` to `PUT` and `rotate-token`, `400` to `test`/`poll`, `409`
  to ingest and to `DELETE` while bundles exist. Members must be existing checks
  that are not bundle checks (`400`). Voting rules: [adapters/README.md](adapters/README.md#check-bundles).
  Audit actions `check_bundle.create|update|delete`.
- History import ([adapters/README.md](adapters/README.md#history-import)):
  `HistoryImportCreateInput` = `{ from, to, onlyLinkedChecks = true, credentials?, csv? }`
  with `to` capped at now and a range of at most 731 days. `credentials`
  (`username`, `password`, `totp` for Uptime Kuma, `databaseUrl` for Icinga DB)
  are used for this import only: stored encrypted on the job until fetching
  ends, never returned; without them the values stored in the source config
  (`historyUsername`/`historyPassword`, `icingaDbUrl`, both secrets masked like
  `password`) are used, otherwise `400`. `csv` imports the file instead of
  calling the source (required for `webhook` sources); an invalid file is `400`
  with `issues: [{ line, code, params, message }]` (`code` and `params` for
  translated messages, `message` in English; codes in `HistoryCsvIssue`). One active job (`fetching`, `ready`,
  `applying`) per source, otherwise `409`; the `bundle` source answers `409`.
  Jobs run in the background (poll `GET …/:importId`); jobs without progress for
  15 minutes are marked `failed` and previews expire after 24 hours (checked
  whenever jobs are read or started, so also without a worker process).
  Applying is serialised across all sources (PostgreSQL advisory lock, SQLite
  write lock): the plan is made and written in one transaction. Preview
  `warnings` are `{ code, params, message }` (`HistoryImportWarning`); a failed
  or expired job has `errorCode` (`source`, `timeout`, `shutdown`, `interrupted`,
  `expired`, `apply_failed`) and an English `error`, redacted of secrets. Audit actions
  `history_import.start|apply|complete|cancel` (entity `monitor_source`, details
  without credentials or CSV content).
- `monitor_check_history` rows carry `source = live | import`,
  `service_status_history` rows `live | import | import_explicit` (service
  statuses from a CSV file). Imports only write into periods without `live`
  rows; they replace earlier `import` rows in their range, and
  `import_explicit` rows only where a new CSV file has service rows.
- Feed items link to `${BASE_URL}/incidents/:id` and `${BASE_URL}/maintenance/:id`.
- `notify` (default `true`) in `IncidentCreateInput`, `IncidentUpdateInput`,
  `MaintenanceCreateInput` and `MaintenanceUpdateInput` queues subscriber emails for
  that event, only for public incidents/maintenance. The maintenance stores the flag
  (`AdminMaintenance.notify`, changeable with `MaintenancePatchInput.notify`); automatic
  start/completion and the reminder only notify when it is set.
  `AdminMaintenance.reminderSentAt` is the time the reminder was queued; it is reset
  when `scheduledStart` moves later. Notification errors never fail the request.

### History corrections

The measured `service_status_history` is never changed. Whenever uptime or
history is computed (public uptime bars and percentages, the admin history
comparison), corrections are applied on top
(`apps/server/src/services/history-corrections.ts`, pure and unit tested):

1. measured segments,
2. retroactive maintenance windows (`retroactive = 1`, status `in_progress` or
   `completed`): `maintenance` from `actualStart` to `actualEnd` (or now while
   running), for its services; only **public** maintenances (`is_public = 1`),
   like the live status engine (use a status correction with status
   `maintenance` for an internal window),
3. status corrections: their `status` for `[startsAt, endsAt)`. Where corrections
   overlap, the one **created last** wins (creation times are strictly increasing).

Everything is clipped at now; corrections may also cover time without measured
data. Corrections never change the current status of a service and send no
email.

- `CorrectionInput`: `serviceIds` (≥ 1), `startsAt`, `endsAt` (after `startsAt`,
  at most 366 days later, not in the future: up to 5 minutes ahead is clamped to
  now, more is `400`), `status` (any `ServiceStatus`), `reason` (required,
  internal), `showPublic` (default `false`), `publicNote` (optional, ≤ 500).
- `PATCH` accepts any subset; the merged range is validated again. `serviceIds`
  replaces the services.
- Validation errors (`400`): `startsAt must be in the past`, `endsAt must be
  after startsAt` (also when clamping the end to now leaves an empty range),
  span longer than 366 days; the same for `POST` and `PATCH`.
- Audit: `correction.create` (services, range, status, reason, public flag and
  note), `correction.update` (`fields` plus `before` and `after` with all of
  these), `correction.delete` (services, range, status and reason).
- Deleting a service removes it from its corrections; corrections left without
  any service are deleted with it (their ids are recorded in the
  `service.delete` audit entry).
- Retroactive maintenance (`retroactive = true`) that is still running and
  whose `scheduledEnd` is moved into the past by `PATCH` is completed at once,
  with `actualEnd = scheduledEnd` and a `completed` update at that time, and
  without email.

## Ingest API (`/api/ingest`)

Monitoring systems push check results. Authentication: `Authorization: Bearer <ingest token>`
of the source (or `?token=` query parameter for systems that cannot set headers; its
value is redacted in the request log).
Responses: `{ ok: true, created, updated, removed, stateChanges }`.
`full: true` (remove checks missing from the payload) is accepted only for sources of type
`webhook` (`400` otherwise); a full push that would remove more than half of the checks linked
to services or used as bundle members is rejected with `409` and stores nothing (see docs/adapters/README.md).

| Method | Path | Body |
| --- | --- | --- |
| POST | `/api/ingest/:sourceId` | `GenericIngestPayload` (works for every source type). Numeric states: 0=ok, 1=warning, 2=critical, 3=unknown |
| POST | `/api/ingest/:sourceId/uptimekuma` | Native Uptime Kuma webhook notification payload |
| POST | `/api/ingest/:sourceId/icinga2` | Payload of the bundled Icinga 2 notification script (see docs/adapters/icinga2.md) |
| POST | `/api/ingest/:sourceId/openitcockpit` | Payload of the bundled openITCockpit notification command (see docs/adapters/openitcockpit.md) |

Rate limited per source (default 120 requests/min).

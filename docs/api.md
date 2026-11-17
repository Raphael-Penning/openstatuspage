# HTTP API

All request/response types live in [`packages/shared/src/schemas.ts`](../packages/shared/src/schemas.ts).
Input bodies are validated with the zod schemas named below; responses use the
TypeScript interfaces of the same file.

Conventions:

- JSON everywhere, timestamps are ISO-8601 UTC strings.
- Errors: `{ error: string, message: string, issues?: ZodIssue[] }` with a fitting HTTP status
  (400 validation, 401 unauthenticated, 403 forbidden, 404 not found, 409 conflict).
- `DELETE` returns `204 No Content`.
- Slugs are generated from the name when not provided; duplicates get a numeric suffix.
- Lists of an entity are returned as plain arrays unless noted as `Paginated<T>`.

## Public API (no authentication)

Only public entities are returned (`is_public = 1`). **Nothing about monitoring
sources or checks is ever exposed here**: no check names, hosts, outputs, IPs or counts.
Responses may be cached (`Cache-Control: public, max-age=30`).

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/public/summary` | `PublicSummary` (overview page: settings, overall, groups with services incl. uptime, active/recent incidents, active/upcoming maintenance) |
| GET | `/api/public/settings` | `PublicPageSettings` |
| GET | `/api/public/services` | `{ groups: PublicServiceGroup[], ungrouped: PublicService[], counts: Record<ServiceStatus, number> }` incl. uptime |
| GET | `/api/public/services/:idOrSlug` | `PublicService & { uptime: DailyUptime[], incidents: PublicIncident[] /* last 90d */, maintenances: PublicMaintenance[] /* active+upcoming */ }` |
| GET | `/api/public/locations` | `PublicLocationsResponse` (404 when `showLocations` is disabled) |
| GET | `/api/public/incidents/:id` | `PublicIncident` |
| GET | `/api/public/maintenances/:id` | `PublicMaintenance` |
| GET | `/api/public/history` | `Paginated<HistoryItem>`, query: `HistoryQuery` (type, serviceId, locationId, month, page, pageSize). Newest first; incidents sorted by `startedAt`, maintenance by `scheduledStart`. Includes active and resolved items, excludes scheduled-in-the-future maintenance. |
| GET | `/api/public/status.json` | Compact machine-readable status: `{ overall, updatedAt, services: [{ id, name, group, status }], activeIncidents: [{ id, title, status, impact }], activeMaintenances: [{ id, title, scheduledEnd }] }` |
| GET | `/feed.rss`, `/feed.atom` | RSS 2.0 / Atom feed of incidents and maintenance (last 50 items) |

Upcoming maintenance = `status = scheduled` and `scheduled_end > now`.
Active maintenance = `status = in_progress`.
Active incidents = `status != resolved`.

`PublicSummary.emailSubscriptions` is `true` when email subscriptions are enabled in
the settings and a mail transport is configured (the page then offers the subscribe form).

## Email subscriptions (`/api/public/subscriptions`, no authentication)

Double opt-in; see [notifications.md](notifications.md). Responses are sent with
`Cache-Control: no-store`. Unknown ids and wrong tokens get the same `404`.

| Method | Path | Body / auth | Response |
| --- | --- | --- | --- |
| POST | `/api/public/subscriptions` | `SubscribeInput` | `202 { ok: true }` for every valid input (new, pending or confirmed address, so addresses cannot be enumerated; also for a filled-in honeypot, see below). `404` when subscriptions are not available, `400` on invalid input or unknown/non-public `serviceIds`. Rate limited (5/min per IP). |
| POST | `/api/public/subscriptions/:id/confirm` | `SubscriptionConfirmInput` (token from the confirmation link) | `{ subscription: PublicSubscription, manageToken: string }`; idempotent |
| GET | `/api/public/subscriptions/:id` | header `X-Subscription-Token: <manageToken>` | `PublicSubscription` |
| PUT | `/api/public/subscriptions/:id` | header as above, `SubscriptionPreferencesInput` | `PublicSubscription` |
| DELETE | `/api/public/subscriptions/:id` | header as above | `204`, deletes the subscriber completely |
| POST | `/api/public/subscriptions/:id/unsubscribe?token=<manageToken>` | empty or `List-Unsubscribe=One-Click` (form encoded) | `{ ok: true }`, deletes the subscriber (RFC 8058 one-click, used by the `List-Unsubscribe` header) |
| GET | `/api/public/subscriptions/:id/unsubscribe?token=<manageToken>` | – | `303` to the manage page with the unsubscribe confirmation, `${BASE_URL}/subscription/manage?id=<id>&unsubscribe=1#token=<manageToken>` (never deletes) |

Behaviour of `POST /api/public/subscriptions`:

- new address: pending subscriber, confirmation email;
- pending address: preferences replaced, confirmation email sent again;
- confirmed address: preferences unchanged, email with the manage link;
- `website` (honeypot, any string up to 500 characters) not empty: answered exactly
  like a successful subscribe (`202 { ok: true }`), but nothing is created and no
  email is sent. Real visitors never see the field.

At most one confirmation/manage email per address every 10 minutes. The endpoints
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

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/auth/config` | – | `AuthConfig` |
| POST | `/api/auth/login` | `LoginInput` | `SessionInfo`, sets cookie `osp_session` (httpOnly, sameSite=lax, secure when BASE_URL is https). Rate limited (10/min per IP). |
| POST | `/api/auth/logout` | – | 204, clears cookie and deletes the session |
| GET | `/api/auth/session` | – | `SessionInfo` or 401 |
| POST | `/api/auth/password` | `ChangePasswordInput` | 204 |
| GET | `/api/auth/oidc/login` | – | 302 to the IdP (PKCE + state + nonce stored in a signed short-lived cookie) |
| GET | `/api/auth/oidc/callback` | – | 302 to `/admin` after login, or `/admin/login?error=<code>` |

Sessions: random 32-byte token in the cookie, SHA-256 of it stored in `sessions.id`.
Expired sessions are deleted lazily and by a periodic cleanup task.

## Admin API (`/api/admin`)

Authentication: session cookie **or** `Authorization: Bearer <api token>`.
Roles: `editor` may manage incidents, maintenance and read everything;
`admin` may additionally manage services, groups, locations, monitoring sources,
settings, users and API tokens. Every mutating call writes an audit log entry.

Cookie-authenticated mutating requests must send the header `X-Requested-With: openstatuspage`
(simple CSRF protection; the web client always sends it). Bearer-token requests are exempt.

| Method | Path | Body | Response | Role |
| --- | --- | --- | --- | --- |
| GET | `/api/admin/overview` | – | `{ counts: { services, incidentsActive, maintenancesActive, maintenancesUpcoming, sources, sourcesFailing, checks, checksFailing }, services: AdminService[] (non-operational first), recentAudit: AuditLogEntry[] }` | editor |
| GET/PUT | `/api/admin/settings` | `SettingsInput` | `PublicPageSettings` | GET editor, PUT admin |
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
| GET | `/api/admin/monitor-sources` | – | `AdminMonitorSource[]` | admin |
| POST | `/api/admin/monitor-sources` | `MonitorSourceInput` | `AdminMonitorSource & { ingestToken: string }` (201, token shown once) | admin |
| GET/PUT/DELETE | `/api/admin/monitor-sources/:id` | `MonitorSourceInput` (secrets equal to `SECRET_MASK` keep the stored value; only while type, `baseUrl` and `username` are unchanged, otherwise 400) | `AdminMonitorSource` | admin |
| POST | `/api/admin/monitor-sources/:id/test` | – | `MonitorSourceTestResult` | admin |
| POST | `/api/admin/monitor-sources/:id/poll` | – | `MonitorSourceTestResult` (polls now and stores the results) | admin |
| POST | `/api/admin/monitor-sources/:id/rotate-token` | – | `{ ingestToken: string }` | admin |
| GET | `/api/admin/checks` | query `sourceId`, `q` (search name/host/external id), `state`, `unlinked=true` | `AdminMonitorCheck[]` | editor |
| DELETE | `/api/admin/checks/:id` | – | 204 | admin |
| GET | `/api/admin/users` | – | `AdminUser[]` | admin |
| POST | `/api/admin/users` | `UserCreateInput` | `AdminUser` (201) | admin |
| GET/PUT/DELETE | `/api/admin/users/:id` | `UserUpdateInput` | `AdminUser` (cannot delete or demote yourself / the last admin) | admin |
| GET | `/api/admin/api-tokens` | – | `AdminApiToken[]` | admin |
| POST | `/api/admin/api-tokens` | `ApiTokenCreateInput` | `AdminApiToken` with `token` (201) | admin |
| DELETE | `/api/admin/api-tokens/:id` | – | 204 | admin |
| GET | `/api/admin/subscribers` | query `SubscriberListQuery` (`page`, `pageSize`, `q` email substring, `status=all\|confirmed\|pending`) | `Paginated<AdminSubscriber>` (newest first) | admin |
| DELETE | `/api/admin/subscribers/:id` | – | 204 (audit `subscriber.delete` with masked address) | admin |
| GET | `/api/admin/notifications/status` | – | `NotificationStatus` | admin |
| POST | `/api/admin/notifications/test` | `TestEmailInput` | `{ ok: boolean, message: string }`; sends immediately (not queued); 409 without transport | admin |
| POST | `/api/admin/notifications/retry-failed` | – | `{ requeued: number }` | admin |

API tokens are revoked when their creator is deleted; admin tokens are revoked when
their creator loses the admin role.
| GET | `/api/admin/audit-log` | query `page`, `pageSize`, `entityType` | `Paginated<AuditLogEntry>` | admin |

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
- `PUT` bodies are complete objects (schema defaults apply to omitted fields);
  an omitted `slug` keeps the current slug. An explicit slug that is taken is `409`.
- `PUT /api/admin/users/:id` with `password: null` removes the local password
  (not allowed for yourself). Changing a password signs that user out everywhere.
- Mutations through API tokens are audited with `userId = null` and
  `details.apiToken = <token name>`; logins are audited as `auth.login`.
- API tokens are prefixed with `osp_`.
- `/api/public/history?locationId=` matches items linked to the location directly
  or affecting a service running there. Filters referencing non-public entities
  return an empty page.
- Feed items link to `${BASE_URL}/incidents/:id` and `${BASE_URL}/maintenance/:id`.
- `notify` (default `true`) in `IncidentCreateInput`, `IncidentUpdateInput`,
  `MaintenanceCreateInput` and `MaintenanceUpdateInput` queues subscriber emails for
  that event, only for public incidents/maintenance. The maintenance stores the flag
  (`AdminMaintenance.notify`, changeable with `MaintenancePatchInput.notify`); automatic
  start/completion and the reminder only notify when it is set.
  `AdminMaintenance.reminderSentAt` is the time the reminder was queued; it is reset
  when `scheduledStart` moves later. Notification errors never fail the request.

## Ingest API (`/api/ingest`)

Monitoring systems push check results. Authentication: `Authorization: Bearer <ingest token>`
of the source (or `?token=` query parameter for systems that cannot set headers; its
value is redacted in the request log).
Responses: `{ ok: true, created, updated, removed, stateChanges }`.
`full: true` (remove checks missing from the payload) is accepted only for sources of type
`webhook` (`400` otherwise); a full push that would remove more than half of the checks linked
to services is rejected with `409` and stores nothing (see docs/adapters/README.md).

| Method | Path | Body |
| --- | --- | --- |
| POST | `/api/ingest/:sourceId` | `GenericIngestPayload` (works for every source type). Numeric states: 0=ok, 1=warning, 2=critical, 3=unknown |
| POST | `/api/ingest/:sourceId/uptimekuma` | Native Uptime Kuma webhook notification payload |
| POST | `/api/ingest/:sourceId/icinga2` | Payload of the bundled Icinga 2 notification script (see docs/adapters/icinga2.md) |
| POST | `/api/ingest/:sourceId/openitcockpit` | Payload of the bundled openITCockpit notification command (see docs/adapters/openitcockpit.md) |

Rate limited per source (default 120 requests/min).

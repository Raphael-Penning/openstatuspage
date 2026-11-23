# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/); before 1.0 a minor release may contain
breaking changes.

## [Unreleased]

### Added

- Starter template for your own theme in `contrib/themes/` (`starter.json`,
  `starter.css`): every token is set, also the optional ones, and it passes
  WCAG 2.2 AA in light and dark mode.
- Guide chapter *Creating a theme* (English and German): from the starter
  template through colours, contrast, preview, installation and troubleshooting;
  [Themes](docs/themes.md) has a quickstart that links to it.
- **Administration → Appearance** links to the new guide chapter
  *Creating a theme* in the help area.
- Visitors find the API description: the public footer links the
  machine-readable OpenAPI description (`/api/openapi.json`) as "API", also in
  `llms.txt` and in the page head (`rel="service-desc"`). The new setting
  **Publish the API description** (`publicApiDescription`, default on) turns it
  off; then the endpoint answers `404` to anonymous clients and on public
  instances, while signed-in users keep the whole API.

### Fixed

- The topic list of the help area no longer adds a second unnamed
  complementary landmark next to the navigation (axe `landmark-unique`).

## [0.4.0] - 2026-11-23

### Upgrading

- Migrations `0014` to `0017` run on start like the earlier ones; no manual
  step is needed on SQLite or PostgreSQL. Logins that are in progress during the
  upgrade end with `invalid_state`; signing in again works.
- **Docker Compose 2.23.1 or newer** is needed for the new `compose.yaml` and
  `compose.split.yaml` (inline `configs`), also when the bundled mail server
  stays off. Check `docker compose version` before `docker compose up -d`.
- Both files now always create the internal `mail` network with a fixed subnet
  (`172.30.250.0/28`, split `172.30.251.0/28`). If `up` fails with `Pool
  overlaps with other one on this address space`, because the range is in use
  or a second project runs on the same host, set a free range per project with
  `MAIL_SUBNET` in `.env`.
- The bundled mail server lets every process on the host send as
  `MAIL_DOMAIN` (the Docker host is on its network; with `install.sh` every
  local user reaches `127.0.0.1:25`). Use it on a single-tenant host only.
- **Accent color.** The accent color of the settings becomes an optional
  override of the theme's accent. Migration `0017_themes` removes it when it is
  the old default `#7c6cf2` (the default theme has the same accent), so pages
  look the same; any other accent is kept as override. `accentColor` of
  `/api/admin/settings` may now be `null`.

### Added

- **Installation without containers.** Every release attaches
  `openstatuspage-<version>-linux-x64.tar.gz` and `…-linux-arm64.tar.gz`, `.deb`
  and `.rpm` packages, `install.sh` and `SHA256SUMS`. `install.sh` installs a
  checksum-verified release with hardened systemd units (one instance or the
  split deployment, whose public instance runs as its own user), generates
  `SECRET_KEY`, can set up a local PostgreSQL with the roles of `roles.sql` and
  a send-only Postfix with OpenDKIM, and has `update`, `rollback` and
  `uninstall` (keeps data). Guide: installation without containers.
- **Bundled mail server in Docker Compose.** `compose.yaml` and
  `compose.split.yaml` have a send-only `postfix` service (profile `mail`, on
  in a new `.env` with `COMPOSE_PROFILES=mail` and `MAIL_DOMAIN`) that signs
  with a DKIM key generated on first start, is never published and relays only
  on an internal network (the app and the Docker host) for senders of
  `MAIL_DOMAIN`. `SMTP_*` still select any other server.
  Existing `.env` files are not changed: to turn the bundled server on, add
  `COMPOSE_PROFILES=mail` and `MAIL_DOMAIN`.
- **DNS records for the bundled mail server** in Settings → Email delivery and
  in `GET /api/admin/notifications/status` (`dns`): SPF, DKIM and DMARC for the
  sender domain, read from the public keys in the new `MAIL_DKIM_DIR`.
- Caddy and nginx templates in `deploy/proxy/` for one instance and the split
  deployment.
- **Content pages.** *Administration → Pages* edits the about page (`/about`),
  the legal notice (`/legal-notice`), the privacy policy (`/privacy`), the
  accessibility statement (`/accessibility`) and any number of custom pages
  (`/pages/<slug>`) in Markdown per language (English, German) with a preview.
  A standard page is either the internal page (published) or, until it is
  published, the external link of the settings as before; nothing changes on
  upgrade. Pages are rendered on the server without raw HTML, have their own
  title, description and language alternates, appear in the navigation and
  footer, the sitemap and `llms.txt`, and are read by the PostgreSQL public role
  through the view `osp_public.site_pages` (published pages only).
- **Image uploads.** The logo, the favicon and images for pages can be uploaded
  (PNG, JPEG, WebP or ICO, at most 1 MiB, checked by magic bytes; SVG is
  refused). They are stored in the database, served at
  `/uploads/<sha256>.<ext>` with immutable caching, `nosniff` and a CSP that
  allows nothing, and rendered with their width and height. The public role
  reads them through the view `osp_public.uploads`. URLs for logo and favicon
  keep working.
- **App version in the management UI**, from `GET /api/admin/instance`
  (signed-in users only).
- **Structured data**: maintenance windows as `Event` (online, on the status
  page, `EventScheduled` or `EventCancelled`), service pages as `Service`,
  content pages as `AboutPage` / `WebPage`; incident articles get the logo as
  image and the affected services as `about`. Every JSON-LD object is checked
  against schema.org and Google's required fields in the tests.
- **Public API**: `GET /api/public/pages/{slug}` returns the published content pages;
  the settings document gains `pages` (navigation and footer links) and `logoSize`.
- An uploaded image that the logo, the favicon or a content page still uses is
  not deleted (`409` naming the references); `PATCH /api/admin/pages/:id`
  merges `title`, `description` and `body` per language.
- **Webhook notifications.** Admins add team webhooks for Discord (embeds),
  Slack (Block Kit), Microsoft Teams (Adaptive Cards for the Workflows webhook)
  and generic JSON (versioned payload, HMAC-SHA256 signature with timestamp,
  optional extra headers stored encrypted), for all or selected services. They
  get the same events as the email subscribers, through a new outbox with
  retries and backoff, have a test button and a delivery log, and are disabled
  after 10 failed deliveries in a row with an email to the admins.
- **SMS notifications.** A generic SMS provider (HTTP request template with
  placeholders and presets for Twilio, Vonage, seven.io and MessageBird,
  credentials stored encrypted), on-call SMS recipients with scope, a monthly
  SMS budget that pauses public SMS and notifies the admins, and GSM-7 aware
  one-segment texts.
- **Webhook and SMS subscriptions for visitors**, with the same scope choice as
  email, through the JSON:API (`/api/public/channel-subscriptions`) and plain
  forms (`/subscribe/webhook`, `/subscribe/sms`, `/subscription/verify`,
  `/subscription/channel`). A 6-digit code in the confirmation message
  activates a subscription; every message carries a manage/unsubscribe link
  (`/s/<id>/<token>`). Off by default: Discord, Slack and Teams need the
  admin's switch (official hosts only), generic webhooks a second one, SMS an
  allowlist of countries.
- **SSRF guard for every outbound webhook and SMS request**: https only (http
  only for admin webhooks that allow it), DNS resolved once and pinned, private,
  loopback, link-local, CGNAT, multicast, metadata and IPv6 ULA ranges refused,
  no redirects, strict timeouts and size limits; plus rate limits per client,
  per destination (per webhook, per host for generic visitor webhooks; admin
  webhooks and on-call SMS never wait behind visitors) and for all subscriber
  webhooks and SMS.
- Visitors' webhook and SMS subscriptions are removed automatically only when
  the destination refused the last five messages (webhook `4xx`, a number the
  SMS provider rejects); a used-up budget, provider or network errors never
  remove anyone.
- Admin page **Webhooks & SMS** and a channel switch on the subscriber list.
- **Several SSO providers, managed in the management UI** (*Administration →
  Single sign-on*, admins only). Each OpenID Connect provider has a name,
  button order, enabled flag, issuer URL, client id, a write-only client
  secret stored encrypted with `SECRET_KEY`, scopes (PKCE S256 always on),
  auto creation of users (verified e-mail only), optional allowed e-mail
  domains and a role mapping: a claim path (`groups`, `roles`,
  `realm_access.roles`, ...) whose values grant admin, editor or no access,
  a default role (editor or no access) and whether the role is updated on
  every login or only at creation. A *Test configuration* button runs the
  discovery and shows the endpoints. Changes are written to the audit log
  (`oidc_provider.*`, never the secret). API: `/api/admin/oidc-providers`.
- The login page shows one button per enabled provider. Every provider has its
  own login and callback route (`/api/auth/oidc/<id>/login|callback`), and the
  login state is bound to the provider: a login started at one provider cannot
  be completed at another. `/api/auth/config` lists them in `oidcProviders`.
- Users are linked by `sub` per provider and can be linked to several
  providers. `create-user --unlink-oidc` removes every link.
- Providers of the management UI link an existing account through its verified
  e-mail address only with *Link existing accounts by e-mail* (`linkByEmail`,
  off by default); otherwise the login is refused with `account_not_linked`.
  The environment provider keeps linking by e-mail as in 0.3.x.
- A new issuer URL of a provider needs its client secret again and removes the
  provider's links to user accounts (audited with `previousIssuerUrl` and
  `unlinkedUsers`).
- With `LOCAL_LOGIN_ENABLED=false` and no environment provider, the last
  enabled provider cannot be disabled or deleted (`409`).
- Role changes made by the SSO role sync are written to the audit log
  (`user.update` with `previousRole` and the provider).
- Migration `0014_site_pages_uploads`.
- Migration `0015_notification_channels`: on PostgreSQL the restricted public
  role writes webhook and SMS subscriptions only through new `SECURITY DEFINER`
  functions in `osp_public` and cannot read any of the new tables.
- **OpenAPI 3.1 description of the HTTP API** at `GET /api/openapi.json` and
  in the repository as `docs/openapi.json`. It is generated from the zod
  schemas the server validates with and from a declaration of every route
  (JSON:API envelopes, parameters, status codes, rate limits, security
  schemes, required role as `x-required-role`); `pnpm openapi:generate`
  rewrites the file, and the tests fail when it is out of date or a route is
  missing. Anonymous clients and `APP_ROLE=public` instances get only the
  public part; signed-in users and API tokens on `admin` and `all` instances
  get the whole API. Answers carry an `ETag` (`304` for `If-None-Match`).
- **API documentation in the management UI** (*API*, next to *Help*, for every
  signed-in user): the endpoints by topic with a filter, parameters, schemas
  and examples, and *Try it* for requests to the own instance with the
  current session. Requests that change data need an explicit confirmation.
- **Themes** for the public page (docs/themes.md): JSON token files (colors for
  light and dark, status colors, focus ring, corner radius, system font stacks,
  density) plus optional extra CSS. Built-in themes `default`, `slate`, `forest`
  and `high-contrast`, all WCAG 2.2 AA in light and dark; a themes folder
  (`THEMES_DIR`, read on start; Compose mount, Helm `themes.*` values with a
  ConfigMap, `/etc/openstatuspage/themes` without containers); themes uploaded in
  the admin (stored in the database). Every theme can be exported as JSON.
- **Administration → Appearance**: themes with source badges and contrast
  results, a live preview in light and dark, a preview of the public page
  (`?theme=<id>`, signed-in admins only), activation, import, export, and an
  editor with color inputs and a live contrast check.
- A theme that fails WCAG 2.2 AA is only activated (or changed while active)
  after an explicit confirmation (`acceptContrastFailures`, written to the audit
  log); the API answers `409 contrast_failures` otherwise. An active theme that
  fails later without a confirmation (a folder file changed, or the accent
  override) is logged once and flagged (`contrastUnconfirmed`, a notice on
  Appearance) until an admin confirms it.
- An uploaded theme hidden by a folder theme with the same id is logged on start
  and can be deleted with `DELETE /api/admin/themes/<id>?uploadedCopy=true`.
- Extra CSS of a theme is filtered: at most 64 KB, no `@import`, `url()` only to
  `/uploads/` or relative paths without `..` or a query, no `expression()`, `javascript:`, `image-set()`
  or `<`. It is served as its own stylesheet.
- Management API `/api/admin/themes` (list, import, edit, delete, activate,
  export) and `/theme/<hash>.css` (immutable, same origin).
- Migration `0017_themes`: on PostgreSQL the restricted public role reads only
  the active theme, through the views `osp_public.active_theme` and
  `osp_public.themes`.

### Changed

- The public pages load the theme (accent included) as a hashed same-origin
  stylesheet at the end of the head instead of an inline `<style>` element;
  `/api/public/settings` carries `theme.stylesheets` and the accent in effect.
- **Maintenance windows** are marked up as `Event` in the structured data (they were
  `Article`). Incident pages stay `Article`.
- The provider of the `OIDC_*` environment variables keeps its routes, redirect
  URI and role rules and is listed read-only in the management UI (it is not
  copied into the database). Migration `0016_oidc_providers` moves the existing
  links (`users.oidc_subject`) to it.
- The mobile top bar of the management UI is a `header` landmark.

## [0.3.1] - 2026-11-22

### Upgrading

- From 0.2.x or 0.3.0 on PostgreSQL: no manual step to start. The `GRANT
  CREATE ON SCHEMA public TO <app role>` and the `harden.sql` rerun that 0.3.0
  asked for before the upgrade are no longer needed; a database where 0.3.0
  refused to start because of them starts with this version as it is.
- On PostgreSQL 14 or older (or a cluster upgraded from one) the app usually
  cannot remove `PUBLIC`'s `CREATE` on schema `public` itself: with `CREATE
  DATABASE ... OWNER <app role>` the schema `public` still belongs to the
  bootstrap superuser. Everything keeps running, but the instances that migrate
  log a warning on every start until a superuser runs the command it names once
  (typically `REVOKE CREATE ON SCHEMA public FROM PUBLIC;`).

### Changed

- **PostgreSQL: `CREATE` for the public role is taken away automatically
  instead of blocking the start.** Migration `0013_schema_create_hardening`
  and every grant on start (`osp_grant_public_role`) revoke `CREATE` on the
  table schema and on `osp_public` from `PUBLIC` and from the public role
  (`DB_PUBLIC_ROLE`) where the migrating role may (it has the schema owner's
  privileges). `PUBLIC` keeps it when the migrating role would lose its own
  `CREATE` by that. A revoke that would change nothing is not run, so repeated
  and parallel starts write nothing. Databases without a registered public role
  (`APP_ROLE=all` only) are not changed. What the migrating role may not change
  no longer stops admin, worker or public instances: the instances that
  migrate log a warning on every start with the exact command for the schema
  owner or a superuser (`pnpm db:migrate` prints it too), the public instance
  logs that its login may still create objects. A public instance refuses to
  start only when its login is not a registered public role, as before 0.3.0;
  `ALLOW_UNRESTRICTED_PUBLIC_DB` only concerns that case now.

### Security

- While the public role may still create objects in the table schema (the
  warning above), the `search_path` pinning of migration `0012` keeps them from
  taking over the functions of the public role. The role can still break those
  functions with an overload (a denial of service of the public instance), and
  admin and worker sessions have the table schema on their `search_path`, so
  run the command from the warning.

## [0.3.0] - 2026-11-22

### Upgrading from 0.2.x

Breaking changes from the security fixes; details under *Changed*.

- `create-user` no longer accepts the password as an argument: it comes from a
  hidden prompt, the first line of stdin or `OSP_USER_PASSWORD`. Change scripts
  that pass it on the command line.
- SSO auto-creates and links accounts by e-mail only when the identity
  provider sends `email_verified`. Entra ID does not by default: configure it
  to emit the claim (see [OIDC](docs/oidc.md#microsoft-entra-id)); users
  already linked by their subject are not affected.
- PostgreSQL: admin, worker and public instances refuse to start while the
  public role can `CREATE` in the table schema (also through `PUBLIC`). First
  `GRANT CREATE ON SCHEMA public TO <app role>` (the table owner), then rerun
  `deploy/postgres/harden.sql`.
- `/api/health` answers only `{"status":"ok"}`, without `role` and `worker`.
- New monitoring limits: `POLL_MAX_RESPONSE_MB` defaults to 8 MiB (was
  50 MiB), `POLL_MAX_VALUES` to 500000 and `MAX_CHECKS_PER_SOURCE` to 20000.
  Very large setups must raise them (the poll limits together with the heap
  cap).
- Private pages: page views and API requests share one
  `PRIVATE_PAGE_REQUESTS_PER_MINUTE` budget per client.
- In production the published example values of `SECRET_KEY` and
  `SUBSCRIPTION_TOKEN_KEY` are refused at startup.

### Added

- **Helm chart** in `deploy/helm/openstatuspage`, published with every release
  as `oci://ghcr.io/raphael-penning/charts/openstatuspage`. Single instance on
  external PostgreSQL or SQLite on a volume (one replica), or the split
  deployment (`split.enabled=true`: public, admin and worker with their own
  database roles and only the secrets of their role). In split mode the public
  pods reference only Secrets of their own: with `secrets.existingSecret` the
  chart requires `secrets.publicExistingSecret` (only `SUBSCRIPTION_TOKEN_KEY`)
  and refuses public Secrets that are also the private ones, so the public
  pods can never read `SECRET_KEY`, `ADMIN_*`, `SMTP_PASSWORD`,
  `OIDC_CLIENT_SECRET` or the owner `DATABASE_URL`. Hardened defaults, optional
  NetworkPolicies (SMTP, OIDC and Umami egress follow the configuration;
  monitoring egress stays off until you list the polled systems),
  HorizontalPodAutoscaler and PodDisruptionBudget, and
  a values schema that only accepts the documented settings. CI validates
  every render with a pinned kubeconform. See
  [installation](docs/guide/en/02-installation.md#kubernetes-with-helm).

### Changed

Behaviour changes from the security fixes below. Check them before you upgrade.

- **`create-user` no longer takes the password as an argument**, so it does not
  end up in the process list or shell history. Usage is
  `create-user <email> [admin|editor] [name] [--unlink-oidc]`; the password
  comes from a hidden prompt on a terminal (use `docker exec -it` or
  `kubectl exec -it`), the first line of stdin or the new environment variable
  `OSP_USER_PASSWORD`. The old form fails with an explanation, so scripts that
  used it must be changed. On an account linked to an SSO identity the command
  refuses to set a password or role unless `--unlink-oidc` is given, which also
  removes the link.
- **SSO creates and links accounts only for a verified e-mail address**
  (`email_verified` claim). Identity providers that never send the claim (for
  example Entra ID by default) can no longer auto-create or link users by
  e-mail; users already linked by their subject are not affected.
- **Password changes end sessions and revoke API tokens.** Any password change
  through `PATCH /api/admin/users/:id` (also an admin's own, and removing a
  password) revokes the API tokens that user created and signs them out
  everywhere. Changing your own password in the user menu ends all your
  sessions and sets a fresh session cookie in the same answer; your API tokens
  stay.
- **Failed logins are throttled per account** in addition to the per-IP limit:
  after 3 failures each further one blocks that account's login for 1, 2, 4 …
  seconds, at most 60 seconds (`429` with `Retry-After`). A success or 15
  minutes without a failure resets it. The counters are kept in memory per
  instance and treat unknown addresses the same way.
- **`/api/health` answers `{"status":"ok"}` only**, without `role` and
  `worker`. Probes only need the status code.
- **Startup checks**: in production the published example values of
  `SECRET_KEY` and `SUBSCRIPTION_TOKEN_KEY` are refused. A warning is logged
  when `TRUST_PROXY` is a hop count (the app port must then only be reachable
  through the proxy) and, in production, when `BASE_URL` is `http://` for a
  host other than localhost.
- **PostgreSQL: a public role that may create objects is refused.** When
  `DB_PUBLIC_ROLE` can `CREATE` in the table schema or in `osp_public`, also
  through a grant to `PUBLIC` (the default before PostgreSQL 15 and on
  clusters upgraded from such a version), granting the role fails and admin,
  worker and public instances do not start. Before you upgrade, first run
  `GRANT CREATE ON SCHEMA public TO <app role>` for the app role that owns the
  tables (`roles.sql` already does; a role that created its tables only
  through `PUBLIC`'s right would otherwise lose it, and the next `db:migrate`
  fails with "permission denied"), then rerun `deploy/postgres/harden.sql` (it
  now revokes `CREATE` on schema `public` from `PUBLIC`, which also affects
  other applications in the same database) or run
  `REVOKE CREATE ON SCHEMA <schema> FROM PUBLIC`.
  `ALLOW_UNRESTRICTED_PUBLIC_DB=true` still turns the public instance's
  refusal into a warning.
- **Stricter URL validation.** `http(s)` URLs in settings and monitoring
  sources may no longer contain a user name or password, logo and favicon
  paths follow the rules of other site paths, and Icinga DB database URLs need
  a host name and accept only `sslmode` (PostgreSQL) or `ssl` (MySQL/MariaDB)
  as query parameters, so TLS client certificates or CAs from file paths are no
  longer possible. Stored values that break these rules must be edited before
  the record can be saved again.
- **Monitoring limits** (new environment variables, see
  [configuration](docs/configuration.md#monitoring)):
  `POLL_MAX_RESPONSE_MB` now defaults to 8 MiB (was 50 MiB) and the new
  `POLL_MAX_VALUES` (default 500000) caps the values of a poll answer before it
  is parsed; very large Icinga 2 or openITCockpit setups must raise both
  together with the heap cap. The new `MAX_CHECKS_PER_SOURCE` (default 20000)
  caps the checks of one source; a push over it gets `409`, a poll over it
  fails. History imports keep their 50 MiB limit.
- **Monitoring and ingest behaviour**: turning TLS verification off on a
  source requires entering its secret again. Ingest results older than the
  stored result of a check are ignored, and result times more than 5 minutes
  ahead of the server clock are replaced by the server time. Full syncs may
  remove at most half of a source's linked checks within 24 hours, not only
  per request. A source whose last scheduled poll never finished (for example
  because the process crashed) is polled again only after a back-off of one
  interval, doubling up to 6 hours; **Poll now** and saving the source bypass
  it. Over-long Uptime Kuma webhook fields are rejected with `400`.
- **History imports** stop at 500000 state changes per Icinga DB or
  openITCockpit import and 50000 rows per Icinga DB query (a longer range is
  split automatically). An Uptime Kuma import waits at most 5 minutes for each
  answer and skips that monitor with a warning.
- **Subscriptions**: confirming a subscription a second time no longer returns
  the manage token (the API omits `manageToken`; the page and the no-JS form
  say the subscription is already confirmed and offer to request a manage
  link). `POST /api/public/subscriptions` and the form `POST /subscribe` share
  one limit of 5 requests per minute per client IP. With
  `MAIL_TRANSPORT=log` and `NODE_ENV=production` the tokens in logged mails
  are replaced by `[redacted]`.
- **Private pages**: page views and API requests at `/p/` share one budget of
  `PRIVATE_PAGE_REQUESTS_PER_MINUTE` per client (IPv6 counted per /64).
- **Public pages**: when the render queue is full and no stale copy exists,
  public pages get the static client-rendered page instead of a `503`
  (personal pages still get the `503`). Request targets that no browser sends
  (a backslash or `%5C` in the path, absolute-form targets) and other
  spellings of `/api` paths get a plain `404` instead of a redirect. A
  malformed URL gets a JSON:API error with the code `bad_url` (`414
  uri_too_long` for an over-long path parameter) and the usual security
  headers.
- **No-JS forms** from browsers without `Sec-Fetch-Site` are accepted only
  with an `Origin` equal to `PUBLIC_BASE_URL`.
- **Logs** show private-page paths in the router's normalized spelling with
  the token redacted.

### Security

Fixes from an internal security review. Apart from the notes under *Changed*
they need no action.

- Monitoring polls can no longer exhaust the heap: pull adapters bound every
  response by size and by value count before parsing, sized against the
  image's 96 MB heap cap, and a source whose poll crashed the process is not
  polled again at once, so one bad answer cannot crash-loop the server.
- Ingest caps result times at the server clock plus 5 minutes, and bundle
  members whose stored result lies further in the future count as stale, so a
  producer cannot keep a bundle vote alive past silence or token rotation.
- Ingest ignores results older than the stored result, so a delayed or
  replayed push cannot move a check's state backwards.
- Ingest authenticates the source and token before it reads the request body;
  unauthenticated requests never get the larger ingest body limit.
- One monitoring source holds at most `MAX_CHECKS_PER_SOURCE` checks.
- The full-sync guard counts removed linked checks over 24 hours, so repeated
  full pushes cannot remove them step by step.
- Uptime Kuma webhook fields have length bounds like the generic webhook.
- Keeping a stored monitoring secret while turning TLS verification off is
  refused; the secret must be entered again.
- Transport errors of monitoring sources no longer carry URL credentials into
  `last_error` or the log.
- The Uptime Kuma importer drops Socket.IO events nobody waits for, bounds the
  ones it keeps and times out each acknowledgement after 5 minutes.
- Icinga DB and openITCockpit imports bound the rows and state changes they
  keep in memory.
- History CSV uploads stop tokenising as soon as the row limit is exceeded and
  are parsed only once.
- The import cleanup removes staged rows of finished, failed and cancelled
  jobs.
- Logo and favicon paths are validated like other site paths.
- `http(s)` URLs with a user name or password are rejected.
- Icinga DB database URLs accept only the TLS parameter and need a host name,
  so a URL cannot make the server read local files or connect to a socket.
- OIDC auto-create requires a verified e-mail claim, so nobody can claim
  someone else's address through an identity provider that does not verify it.
- `create-user` refuses accounts linked to an SSO identity unless told to
  unlink them, and never takes the password from the command line.
- Failed logins are throttled per account, so forged `X-Forwarded-For`
  headers or many client addresses do not multiply password guesses.
- The authentication hook decides on the matched route instead of the raw URL,
  so percent-encoded spellings of `/api/admin` and `/api/auth` get the same
  authentication and CSRF checks.
- An admin password reset revokes the user's API tokens and sessions; a user's
  own password change rotates the session token.
- A new login (password or SSO) deletes the session it replaces.
- The last-admin guard and the API token owner check run atomically, also on
  PostgreSQL, so concurrent demotions or deletions cannot leave no
  administrator and a demoted user cannot create an admin token.
- Encrypted secrets require a full 16-byte GCM authentication tag.
- Production refuses the published example secrets and warns about an `http`
  `BASE_URL` (non-`Secure` cookies) and a `TRUST_PROXY` hop count.
- `/api/health` no longer discloses the instance role.
- Paths with a backslash are classified the way browsers read them, so private
  and subscription pages keep their no-store, no-referrer, no-framing and
  token-redaction rules in every spelling; such raw paths get a plain `404`.
- The canonical redirect only ever points to a path on the same site, and
  other spellings of `/api` paths are no longer redirected and cached.
- Private-page tokens are redacted from logs in every spelling of the path,
  and `token` query parameters also when their name is percent-encoded.
- Subscription confirm and manage pages may not be framed.
- `PRIVATE_PAGE_REQUESTS_PER_MINUTE` is one budget per client (IPv6 per /64)
  across private page views and all private-page API routes and methods.
- The render cache keeps only successful renders and evicts the least recently
  used page, and a full render queue no longer answers public pages with `503`,
  so requests for unknown URLs cannot push real pages out of the cache.
- Fastify's own error for malformed URLs carries the security headers and no
  longer echoes the URL.
- The cross-site check of the no-JS forms compares the `Origin` only with
  `PUBLIC_BASE_URL`, never with a value derived from request headers.
- Analytics referrers on personal pages are reduced to the site root whatever
  their origin.
- JSON:API filters reject inherited object property names as unknown filters.
- PostgreSQL: all `osp_public` and helper functions run with `search_path`
  pinned to `pg_catalog, pg_temp` (migration `0012_definer_search_path`), and
  a public role that may create objects in the table schema or in
  `osp_public` is refused, so a compromised public instance cannot plant
  functions that run with the table owner's rights. `osp_private_page_id` is
  now `VOLATILE`.
- `deploy/postgres/harden.sql` revokes `CREATE` on schema `public` from
  `PUBLIC`.
- The one-mail-per-10-minutes subscription throttle is claimed with a single
  conditional update, so concurrent subscribe requests send one mail.
- Only the request that confirms a subscription receives the manage token, so
  an old confirmation mail is not a lasting management credential.
- The subscribe API and form share one rate-limit budget per client.
- Mail logging in production redacts link tokens.
- Mail subjects drop Unicode line separators.
- A mail the transport already accepted is no longer retried as a failed
  delivery when the bookkeeping afterwards fails. If the database stays
  unavailable through all attempts to mark it sent, the row keeps its 10-minute
  claim and the mail can be sent once more after the claim expires.
- Token placeholders in editor-written mail text are removed, so only the
  template's own links carry a subscriber's tokens.
- Subscription errors from PostgreSQL pass on only the functions' own input
  errors; any other database message becomes "Invalid input".
- CI pins every third-party action to a full commit SHA, and pull requests
  build the image in a separate `image-build` job without `packages: write`;
  only pushes to `main` and tags get the write permission. Branch protection
  that requires the `image` check should require `image-build` instead, since
  `image` is skipped (and counted as passed) on pull requests.
- `compose.yaml` and the `.env` template publish the app port on
  `127.0.0.1:3000` by default (`HOST_PORT`), so clients cannot bypass the
  reverse proxy and spoof `X-Forwarded-For` under `TRUST_PROXY=1`. Existing
  `.env` files with `HOST_PORT=3000` keep publishing on all interfaces;
  with an exposed port set `TRUST_PROXY` to the proxy's addresses.
- `compose.split.yaml` puts the public instance on its own network with the
  database, so it cannot connect to the admin instance or the worker.
- The Kubernetes manifests no longer mount a service account token, and the
  split manifests add a NetworkPolicy that limits the public pods to traffic
  from the ingress controller and to DNS and PostgreSQL.
- The contrib notify scripts reject an `OSP_TOKEN` outside the base64url
  alphabet before writing it into curl's configuration.

## [0.2.0] - 2026-11-20

### Upgrading from 0.1.x

- Clients of the HTTP API must switch to JSON:API (see *Breaking changes*).
- On PostgreSQL, read the upgrade notes of migration `0007_public_role` below
  before you migrate, and run `deploy/postgres/roles.sql` if you want to split
  the instance by `APP_ROLE`.
- Check the new environment variables `PUBLIC_BASE_URL`,
  `SUBSCRIPTION_TOKEN_KEY` and `UMAMI_URL`. Their defaults keep a single
  instance working.

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

- **Private status pages** at `/p/<link>`: a status page with a secret link for
  chosen services, also ones hidden from the public page, with the look of the
  public page (overall status, uptime bars with day pages, service pages, active
  incidents, running and upcoming maintenance, each with its own page below the
  link), server-rendered and complete
  without JavaScript. Managed by admins under *Administration → Private pages*
  and `/api/admin/private-pages` (name, description, services, expiry, enabled;
  audit log entries). The link carries 160 random bits, is shown once after
  creating or renewing it ("New link" invalidates the old one) and stored only as
  its SHA-256 hash (migration `0009_private_pages`). Visitors' API:
  `/api/public/private-page…` with the token in the `X-Private-Page-Token` header.
  Private pages are `noindex, nofollow` (meta and header), never cached or served
  stale, carry no Umami tag, send no referrer, are absent from the sitemaps,
  `llms.txt` and `robots.txt` (crawlers may fetch them, so they see the
  `noindex`); the request log redacts the link (a reverse proxy's access log may
  still contain it, so treat the link like a password), 60 requests per minute
  and client, and wrong, disabled and expired links get the same 404. On PostgreSQL the public role holds no privilege on the private page
  tables and reads a page only through token-scoped `SECURITY DEFINER` functions
  in `osp_public`. Feeds and email subscriptions of private pages are not part of
  this release.
- **Clickable days with a detail page**: every day of an uptime bar (overview,
  services, service page) and of the service page's day table is a link to
  `/services/<slug>/days/<YYYY-MM-DD>`, server-rendered and complete without
  JavaScript: status and uptime of the UTC day, its status periods with start,
  end and duration, corrections with their public notes, the incidents and
  maintenance windows of the day, and the previous and next day. A bar stays
  one tab stop (roving tabindex: arrow keys, Home, End move between the day
  links, Enter opens one); with JavaScript the whole bar is one pointer target.
  Day pages are `noindex, follow` and in no sitemap. Data comes from the new
  `GET /api/public/services/{idOrSlug}/days/{date}` (`service-days`), built from
  the same corrected history as the uptime bars; `400` for a malformed date,
  `404` outside the uptime range. Links take a base path (`LinkBaseProvider`),
  so pages served below a prefix can reuse them.
- **Server-side rendered public pages**: every public page (overview, services,
  service, locations, history, incident, maintenance, subscribe, subscription
  links, not found) is rendered on the server and hydrated in the browser, so
  it works without JavaScript and search engines get the content. Unknown pages,
  services, incidents and maintenance windows answer `404`. The language comes
  from `?lang=`, the `osp-lang` cookie (set by the language switcher),
  `Accept-Language` or the page default; times are rendered in UTC and switch to
  the visitor's time zone after loading. Rendered pages are cached for 5 s
  (keyed on the query parameters the pages read) and sent with an `ETag`; one
  page renders at a time, at most four wait, and further requests get the
  last rendered version of the page, even an expired one up to 10 minutes old
  (`X-Cache: STALE`, still within the cache's 16 pages and 1 MiB), or, without
  one, `503` with `Retry-After: 5` and a small static "temporarily busy" page
  (`no-store`, `noindex`; personal subscription links are never served stale).
  A render error prefers the stale copy to the client-rendered page. The management UI stays client-rendered and carries
  `X-Robots-Tag: noindex, nofollow`, as does every page of an `admin` instance. See
  [docs/architecture.md](docs/architecture.md#server-side-rendering).
- **The public pages work without JavaScript.** Every control is a link or a
  form: the history filters and pages, the service search and status filter
  (`?q=`, `?status=`), the theme (a form, `POST /preferences/theme`) and the
  language (links, `GET /preferences/language`; a form posting there on the
  personal subscription pages, so their token stays out of URLs and logs; each
  setting its cookie), the
  subscribe menu and the collapsible service groups (`<details>`). The world map
  is drawn on the server (`/world-map.svg`), every day of an uptime bar is listed
  in a table on the service page, the `system` theme follows the OS dark mode in
  CSS and the configured accent color is in the page head. Pages list their
  other languages as `hreflang` alternates. See
  [docs/architecture.md](docs/architecture.md#without-javascript).
- **The email subscription as HTML forms**: `POST /subscribe`,
  `/subscription/confirm`, `/subscription/manage` and `/subscription/unsubscribe`
  (form-urlencoded, outside the JSON:API) with the same flow and rate limits as
  the API, Post/Redirect/Get, server-side validation errors with an error summary,
  and a same-origin check (`Sec-Fetch-Site`/`Origin`) against cross-site posts.
  See [docs/security-model.md](docs/security-model.md#html-forms).
- **Search engines and AI agents**: every public page has a unique title, a
  description from its content, a canonical URL and `hreflang` alternates
  (`?lang=xx`, `x-default`) from `PUBLIC_BASE_URL`, Open Graph and Twitter card
  tags (the logo as image), `theme-color` and robots rules (`noindex` for 404
  pages and subscription links, `noindex, follow` for filtered, searched and
  later pages). Other spellings of a page path (`/Services/`) get a `301` to the
  canonical one. JSON-LD: `WebSite` and `Organization` on the
  overview, `BreadcrumbList` on the other pages, `Article` for incidents and
  maintenance windows. New files: `/robots.txt` (per role; the read-only
  `/api/public/` is allowed for agents; `Disallow: /` on `admin` instances), the sitemap index `/sitemap.xml` with pages, incidents and
  services, `/llms.txt` and `/llms-full.txt` (the current status as Markdown).
  See [docs/architecture.md](docs/architecture.md#search-engines-and-ai-agents).
- **Public API**: maintenance windows have `createdAt` and `updatedAt`.
- **Lighthouse 100**: the public pages score 100 in performance, accessibility,
  best practices and SEO on mobile and desktop and pass the agentic browsing
  audits. The web build writes Brotli and gzip copies of its files, which the
  server sends as they are; rendered pages are sent gzip-compressed; hashed
  assets are cached for a year. The public bundle no longer contains the
  management UI's translations or zod (the subscription forms load it on
  demand): 915 KiB → 170 KiB per page on the wire. `scripts/lighthouse.mjs`
  runs Lighthouse against an instance. See [docs/performance.md](docs/performance.md).
- **Security headers**: pages are sent with a Content-Security-Policy (scripts
  from the own origin only), `Cross-Origin-Opener-Policy: same-origin` and a
  `Permissions-Policy`. See
  [docs/security-model.md](docs/security-model.md#browser-security-headers).
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

- **User guide**: new chapter 12, *Search engines, AI agents and the public
  page* (English and German): `PUBLIC_BASE_URL` for canonical links and sitemaps,
  robots.txt, the sitemap index and sub-sitemaps, `llms.txt`, submitting the sitemap
  in Google Search Console, the noindex rules and using the status page without
  JavaScript. The reverse proxy chapter explains which headers a proxy must keep
  (`Vary`, `Content-Encoding`, `Accept-Encoding`, cache headers).
- **Footer legal links, copyright notice, info link and UTM parameters**
  (Administration → Settings): links to your imprint, privacy policy and
  accessibility statement (external pages, optional labels) in a "Legal"
  navigation of the footer; a plain-text copyright notice with a `{year}`
  placeholder and an optional brand link (also the Organization `sameAs` in
  JSON-LD); a switch for the "Powered by OpenStatusPage" line; an optional info
  link in the page navigation (an http(s) URL or a path on this site); and
  `utm_source`, `utm_medium`, `utm_campaign` appended to every configured
  outbound link (also support URL, footer links and service websites) when
  switched on. Server render and browser use the same helper, links on the
  page's own origin and links with `utm_` parameters stay unchanged. Outbound
  links announce that they open a new tab. New attributes of `settings/site`:
  see [docs/api.md](docs/api.md).
- **Page view statistics with Umami** (optional, off by default): set
  `UMAMI_URL` on the instances that serve the status page and switch it on with
  the website ID in Administration → Settings → Analytics (Umami). The status
  page proxies the tracker (`/pulse/p.js`, cached in memory) and its events
  (`/pulse/api/send`: JSON only, size, rate and concurrency limits, timeouts, no
  redirects, no cookies, the visitor's IP address only when allowed), so the
  CSP stays `'self'` and browsers never contact Umami. The tracker is rendered
  on the server, deferred, never on subscription links or the management UI;
  tokens (with their subscription ID) and fragments are stripped from tracked
  URLs and events keep only the tracker's fields; Do Not Track and Global
  Privacy Control are respected by default. Visitors turn statistics off (and
  on) in the footer, also without JavaScript (cookie `osp-analytics`, which
  Umami's `localStorage` switch always follows); rendered pages are cached per
  choice. The settings page warns when the server has no `UMAMI_URL`
  (`analyticsAvailable`). Needs Umami 2.0 or later. `robots.txt` disallows
  `/pulse/`. See
  [docs/configuration.md](docs/configuration.md#analytics).

### Changed

- **Links in subscription emails carry the token in the query string**
  (`?id=…&token=…`) instead of the URL fragment, so the confirm and manage pages
  work without JavaScript. The server log redacts it, the pages send no referrer
  and are never cached; links of older emails keep working in browsers with
  JavaScript. Confirming now takes a click on **Confirm subscription** (link
  scanners of mail providers no longer confirm by opening the link).

- The Docker image and `pnpm start` run Node.js with `--max-opt=2` (no TurboFan),
  which saves 10–15 MB per instance. Start the server the same way when you run it
  without the image.
- **Less memory per instance**: about 80–100 MB instead of 100–130 MB with the
  Docker image (worker stays below 100 MB, public too under bursts of up to 64
  concurrent connections, so limit connections at the proxy; admin and all peak
  at about 105–110 MB during password checks and bursts, see [docs/architecture.md](docs/architecture.md#memory)). The server build bundles and minifies its dependencies, every role
  loads only its own routes, and nodemailer, openid-client, argon2 and the history
  importers load on first use. The image sets `NODE_OPTIONS`
  (`--max-semi-space-size=1 --max-old-space-size=96`), `MALLOC_ARENA_MAX=2` and
  `UV_THREADPOOL_SIZE=2`; raise `--max-old-space-size` for large history imports.
  Its health check no longer starts a second node process. The Kubernetes example
  requests 128 MiB (limit 256 MiB).

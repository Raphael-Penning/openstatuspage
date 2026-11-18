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
| `BASE_URL` | `http://localhost:3000` | Public URL of the status page, without trailing slash. Used for feed links, links in notification emails, OIDC redirect URIs and ingest URLs. When it starts with `https://` cookies are marked `Secure`. |
| `TRUST_PROXY` | `false` | Behind a reverse proxy (nginx, Traefik, Caddy, ...) client IPs (rate limiting, session metadata) and the protocol are taken from `X-Forwarded-*` headers. Set the number of proxies in front of the app (`1` for a single proxy; `true` means `1`) or a comma separated list of trusted proxy addresses/CIDRs (e.g. `10.0.0.0/8,127.0.0.1`). Entries further left in `X-Forwarded-For` are set by the client and are never trusted. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `WEB_DIST_DIR` | – | Directory with the built web client. By default the server looks for `apps/web/dist`. |

## Security

| Variable | Default | Description |
| --- | --- | --- |
| `SECRET_KEY` | – (development fallback) | At least 32 characters, e.g. `openssl rand -base64 48`. Encrypts monitoring credentials at rest (AES-256-GCM) and signs cookies. **Required unless `NODE_ENV` is `development` or `test`.** Changing it makes stored monitoring credentials unreadable (they have to be re-entered). |
| `SESSION_TTL_HOURS` | `168` (7 days) | Session lifetime. The expiry slides: active sessions are extended, idle ones expire after this many hours. Range 1–2160. |
| `SESSION_MAX_AGE_HOURS` | `720` (30 days) | Absolute session lifetime, counted from the login. Active sessions are never extended past it, so everybody has to log in again (and SSO users pass the IdP checks again) at least this often. Range 1–8760, at least `SESSION_TTL_HOURS`; when unset and `SESSION_TTL_HOURS` is longer, that value is used. |

## Database

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite:./data/openstatuspage.db` | `sqlite:<path>` (use `sqlite::memory:` for throw-away instances) or `postgres://user:password@host:5432/database`. Migrations run automatically on start. |

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

## Background worker

| Variable | Default | Description |
| --- | --- | --- |
| `WORKER_ENABLED` | `true` | Runs maintenance auto start/complete, monitoring pollers, email delivery, maintenance reminders and the cleanup tasks. Set to `false` on additional replicas so only one instance runs background jobs. |

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
Confirmation and unsubscribe links are signed with `SECRET_KEY`; changing it
invalidates links in emails already sent.

## Rate limits

- `POST /api/auth/login`: 10 requests per minute per client IP.
- `GET /api/auth/oidc/login` and `/api/auth/oidc/callback`: 30 requests per minute per client IP.
- `POST /api/public/subscriptions`: 5 requests per minute per client IP; the other
  subscription endpoints 30 requests per minute per client IP.

Behind a reverse proxy set `TRUST_PROXY` (hop count or proxy addresses), otherwise all
clients share the proxy's IP.

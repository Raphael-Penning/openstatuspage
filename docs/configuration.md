# Configuration

OpenStatusPage is configured exclusively through environment variables
(see [`apps/server/src/config.ts`](../apps/server/src/config.ts)). A commented
template lives in [`.env.example`](../.env.example). Invalid values stop the
server at startup with a list of the offending variables.

Boolean variables accept `true`/`false`, `1`/`0` and `yes`/`no`.

## Server

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `production` or `test`. In production `SECRET_KEY` is mandatory and logs are JSON. |
| `HOST` | `0.0.0.0` | Interface the HTTP server binds to. |
| `PORT` | `3000` | HTTP port. |
| `BASE_URL` | `http://localhost:3000` | Public URL of the status page, without trailing slash. Used for feed links, OIDC redirect URIs and ingest URLs. When it starts with `https://` cookies are marked `Secure`. |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy (nginx, Traefik, Caddy, ...) so client IPs (rate limiting, session metadata) and the protocol are taken from `X-Forwarded-*` headers. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `WEB_DIST_DIR` | – | Directory with the built web client. By default the server looks for `apps/web/dist`. |

## Security

| Variable | Default | Description |
| --- | --- | --- |
| `SECRET_KEY` | – (development fallback) | At least 32 characters, e.g. `openssl rand -base64 48`. Encrypts monitoring credentials at rest (AES-256-GCM) and signs cookies. **Required in production.** Changing it makes stored monitoring credentials unreadable (they have to be re-entered). |
| `SESSION_TTL_HOURS` | `168` (7 days) | Session lifetime. The expiry slides: active sessions are extended, idle ones expire after this many hours. Range 1–2160. |

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
| `OIDC_EDITOR_GROUP` | – | Members of this group become `editor`. When unset, every authenticated user may log in as editor. |
| `OIDC_AUTO_CREATE_USERS` | `true` | Create a local user on the first OIDC login. When `false`, users must be created by an admin first. |

See [oidc.md](oidc.md) for IdP setup and the role mapping rules.

## Background worker

| Variable | Default | Description |
| --- | --- | --- |
| `WORKER_ENABLED` | `true` | Runs maintenance auto start/complete, monitoring pollers and the hourly session cleanup. Set to `false` on additional replicas so only one instance runs background jobs. |

## Rate limits

- `POST /api/auth/login`: 10 requests per minute per client IP.
- `GET /api/auth/oidc/login` and `/api/auth/oidc/callback`: 30 requests per minute per client IP.

Behind a reverse proxy enable `TRUST_PROXY`, otherwise all clients share the proxy's IP.

# Configuration

There are two places to configure OpenStatusPage:

- **Environment variables** for everything that concerns the server and its
  environment (URLs, secrets, database, login, mail). They are read on start;
  restart the app after changing them.
- **The settings page** in the management UI (**Administration → Settings**,
  administrators only) for everything visitors see. Changes apply immediately.

## Environment variables

The complete reference with every option lives in
[`docs/configuration.md`](../../configuration.md); a commented template is in
[`.env.example`](../../../.env.example). The most important variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:3000` | Public URL without trailing slash. See [Reverse proxy](03-reverse-proxy.md#base_url). |
| `SECRET_KEY` | – | Required in production, at least 32 characters. See [Operations](09-operations.md#secret_key). |
| `DATABASE_URL` | `sqlite:./data/openstatuspage.db` | `sqlite:<path>` or `postgres://user:password@host:5432/database`. |
| `TRUST_PROXY` | `false` | Number of reverse proxies in front of the app, or their addresses. See [Reverse proxy](03-reverse-proxy.md#trust_proxy). |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Interface and port the server listens on. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | – | First administrator, only used while no user exists. |
| `SESSION_TTL_HOURS` | `168` | Idle time after which a login session expires (sliding). |
| `LOCAL_LOGIN_ENABLED` | `true` | `false` allows single sign-on only. |
| `OIDC_*` | – | Single sign-on, see [Users and access](08-users-and-access.md#single-sign-on-oidc). |
| `WORKER_ENABLED` | `true` | Background jobs; `false` on additional replicas. |
| `MAIL_TRANSPORT`, `SMTP_*` | – | Email delivery, see [Email subscriptions](07-email-subscriptions.md#mail-server). |

Rules that apply to all variables:

- A `.env` file in the working directory or the repository root (or the file
  named in `ENV_FILE`) is loaded automatically; variables that are already set
  in the environment win.
- Empty values count as unset.
- Booleans accept `true`/`false`, `1`/`0` and `yes`/`no`.
- Invalid values stop the server on start with a list of the offending
  variables.
- `NODE_ENV` defaults to `production`. Only for local development use
  `development` (`pnpm dev` sets it): it allows a missing `SECRET_KEY` and
  prints human-readable logs.

With Docker Compose remember that only the variables listed in the
`environment:` section of the `openstatuspage` service reach the container.

## The settings page

**Administration → Settings** controls the public page:

| Section | Setting | Effect |
| --- | --- | --- |
| Branding | Site name | Shown in the header, the browser title, feeds and email subjects. |
| Branding | Description | Short text below the site name. |
| Branding | Logo URL, Favicon URL | `https://` URLs or paths. |
| Branding | Accent color | Color of buttons and highlights (hex, e.g. `#7c6cf2`). |
| Display | Default language | Used when the visitor's browser language is not available (English or German). |
| Display | Default theme | System, light or dark; visitors can switch. |
| Display | Support URL | Optional link to your support or contact page. |
| Display | Show locations | Shows the locations page and the map. |
| Display | Show uptime | Shows uptime bars and percentages. |
| Display | Uptime days | Days shown in the uptime bars (7–180, default 90). |
| Display | Recent incident days | How long resolved incidents stay on the overview (1–90, default 7). |
| Footer links | – | Up to 10 links in the page footer (e.g. imprint, privacy policy). |
| Email | Email subscriptions | Offers subscriptions on the public page (needs a configured mail server). |
| Email | Maintenance reminder | Hours before a scheduled maintenance to remind subscribers (0 = off, default 24). |

The email settings are explained in [Email subscriptions](07-email-subscriptions.md).

The language and theme of the management UI are personal settings in the user
menu (bottom left).

## Checking the effective configuration

There is no page that prints the environment, on purpose. To check a value:

- the start-up log reports configuration errors and warns about an insecure
  `SECRET_KEY` or a risky OIDC setup;
- the email status panel shows the mail transport and sender
  (see [Email subscriptions](07-email-subscriptions.md#troubleshooting));
- `docker compose -f docker/docker-compose.yml exec openstatuspage env` lists
  what the container actually received (it contains secrets, do not paste the
  output anywhere).

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
| `SESSION_MAX_AGE_HOURS` | `720` | Maximum session lifetime from the login, even for active sessions (at least `SESSION_TTL_HOURS`). |
| `LOCAL_LOGIN_ENABLED` | `true` | `false` allows single sign-on only. |
| `OIDC_*` | – | Single sign-on, see [Users and access](08-users-and-access.md#single-sign-on-oidc). |
| `APP_ROLE` | `all` | `all`, or with PostgreSQL `public`, `admin` or `worker` to run the status page and the management side as separate instances. See [Split deployment](../../configuration.md#split-deployment). |
| `DB_PUBLIC_ROLE` | `osp_public` | PostgreSQL login of the `public` instance. It can only read public data and manage subscriptions through checked functions. Create it with `deploy/postgres/roles.sql`; see [Security model](../../security-model.md). |
| `WORKER_ENABLED` | `true` (`false` for `APP_ROLE=admin`) | Background jobs; on PostgreSQL several instances may run them (coordinated through the database). |
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

With Docker Compose every variable goes into `.env` next to `compose.yaml`;
the whole file reaches the container, and `docker compose up -d` applies a
change (see [Installation](02-installation.md#settings-in-env)). Only
`DATABASE_URL` is set by `compose.yaml` itself. On Kubernetes put the
variables into the secret `openstatuspage` or the `env:` list of
`deployment.yaml`.

## The settings page

**Administration → Settings** controls the public page:

| Section | Setting | Effect |
| --- | --- | --- |
| Branding | Site name | Shown in the header, the browser title, feeds and email subjects. |
| Branding | Description | Short text below the site name. |
| Branding | Logo URL, Favicon URL | `https://` URLs or paths. |
| Branding | Accent color | Color of buttons and highlights (hex, e.g. `#7c6cf2`); adjusted automatically for contrast, see [below](#accent-color-and-accessibility). |
| Display | Default language | Used when the visitor's browser language is not available (English or German). |
| Display | Default theme | System, light or dark; visitors can switch. |
| Display | Support URL | Optional link to your support or contact page. |
| Display | Show locations | Shows the locations page and the map. |
| Display | Show uptime | Shows uptime bars and percentages. |
| Display | Uptime days | Days shown in the uptime bars (7–180, default 90). |
| Display | Recent incident days | How long resolved incidents stay on the overview (1–90, default 7). |
| Footer links | – | Up to 10 links in the page footer (e.g. imprint, privacy policy). |
| Email subscriptions | Offer email subscriptions | Offers subscriptions on the public page (needs a configured mail server). Default: off. |
| Email subscriptions | Maintenance reminder (hours) | Hours before a scheduled maintenance to remind subscribers (0–168, 0 = off, default 24). |

The email settings and the **Email delivery** panel below them are explained
in [Email subscriptions](07-email-subscriptions.md).

### Accent color and accessibility

The public page and the emails aim to meet WCAG 2.2 level AA (see
`docs/accessibility.md` in the repository). You can pick any accent color; the
page keeps it readable on its own:

- Links, highlighted text and the keyboard focus outline use a variant of your
  color that is darkened (light theme) or lightened (dark theme) just enough to
  reach a contrast of 4.5:1 on every background.
- Buttons in your color get white or dark text, whichever is readable, and the
  color is darkened slightly if needed. Emails do the same for their button.

So a very light color such as yellow looks darker on the page than in the
color picker. For the result closest to your brand, pick a medium or dark
color, check the page in the light and the dark theme, and avoid logos that
contain important text other than the site name (the logo has no text
alternative because the site name is shown next to it). Write incident and
maintenance texts in the language of most of your visitors.

The language and theme of the management UI are personal settings in the user
menu (bottom left).

## Checking the effective configuration

There is no page that prints the environment, on purpose. To check a value:

- the start-up log reports configuration errors and warns about an insecure
  `SECRET_KEY` or a risky OIDC setup;
- the **Email delivery** panel on the settings page shows the mail transport
  and sender
  (see [Email subscriptions](07-email-subscriptions.md#troubleshooting));
- `docker compose exec openstatuspage env` lists what the container actually
  received (it contains secrets, do not paste the output anywhere).

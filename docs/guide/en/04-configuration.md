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
| `PUBLIC_BASE_URL` | `BASE_URL` | Split deployment: the public URL on admin and worker instances, used for all links in emails and feeds. Search engine data (canonical links, sitemaps, `robots.txt`, `llms.txt`) uses it as well. |
| `SECRET_KEY` | – | Required in production, at least 32 characters and not an example value from the documentation. See [Operations](09-operations.md#secret_key). |
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
| `POLL_MAX_RESPONSE_MB`, `POLL_MAX_VALUES`, `MAX_CHECKS_PER_SOURCE` | `8`, `500000`, `20000` | Limits per poll answer and per monitoring source, sized for the image's memory cap. See [Monitoring integration](05-monitoring.md#tips). |
| `UMAMI_URL` | – | Your Umami server for page view statistics, see [Statistics with Umami](#statistics-with-umami). |

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
change (see [Installation](02-installation.md#settings-in-env)). `compose.yaml`
itself sets `DATABASE_URL`, `SECRET_KEY`, `HOST` and `PORT`, and the mail
variables `SMTP_HOST`, `SMTP_FROM` and `MAIL_DKIM_DIR` when `MAIL_DOMAIN` is set
(a value in `.env` wins). The variables of the bundled mail server are listed in
[configuration](../../configuration.md#email-notifications). On Kubernetes put the
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
| Footer links | – | Up to 10 further links in the page footer. |
| Email subscriptions | Offer email subscriptions | Offers subscriptions on the public page (needs a configured mail server). Default: off. |
| Email subscriptions | Maintenance reminder (hours) | Hours before a scheduled maintenance to remind subscribers (0–168, 0 = off, default 24). |
| Legal links | Imprint, privacy policy, accessibility statement | `https://` links to these pages on your website, each with an optional label; shown in the footer under "Legal", hidden without URL. |
| Copyright and attribution | Copyright notice | Plain text such as `© {year} Example Ltd.`; `{year}` becomes the current year. Empty: `© <year> <site name>`. |
| Copyright and attribution | Brand link URL | Optional; turns the notice into a link to your website. |
| Copyright and attribution | Show "Powered by OpenStatusPage" | Shows the attribution line. Default: on. |
| Info link | Label, URL or path | Optional extra entry in the navigation, e.g. "What does the status mean?". An `https://` URL or a path on this site such as `/about`. |
| Link tracking (UTM) | Append UTM parameters, utm_source, utm_medium, utm_campaign | Adds the parameters to the links above that lead to other websites, see [below](#utm-parameters). Default: off. |

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

### Legal links and the info link

The legal links point to pages on your own website; the status page has no
editor for them. Every public page shows them in the footer, also without
JavaScript. Links to other websites open in a new tab, and screen readers
announce that. The info link may also be a path on this site (`/about`), for
example a page your reverse proxy serves; such a path must start with a single
`/`, so the link can never lead to another host.

### UTM parameters

With **Append UTM parameters to outbound links** switched on, the page adds
`utm_source`, `utm_medium` and `utm_campaign` (the ones you filled in) to every
link you configured that leads to another website: legal links, brand link,
info link, support URL, footer links and the websites of services. Your
analytics then sees visits that came from the status page. Links on the
status page's own address and links that already contain a `utm_` parameter
stay as they are. The rest of a link's address is not touched: the page only
adds the UTM parameters at the end of the query, before a `#fragment`.

The page knows its own address from `PUBLIC_BASE_URL` (or `BASE_URL` when that
is not set). Behind a reverse proxy it must be the address visitors actually
use. If it is wrong, links to the status page itself count as links to another
website: they get UTM parameters, open in a new tab and are announced as such.

### Statistics with Umami

The status page can count page views with [Umami](https://umami.is), an
analytics server you run yourself and that sets no cookies. You need Umami 2.0
or later. Two steps:

1. Set `UMAMI_URL` to the address of your Umami server (for example
   `https://umami.example.com`, or `http://umami:3000` inside a Docker network)
   on every instance that serves the status page, and restart it. In a split
   deployment that is the `public` instance (and the `admin` instance for its
   preview).
2. In Umami, add a website and copy its **Website ID**. In **Settings →
   Analytics (Umami)** switch on **Count page views with Umami** and paste the ID.
   If the server you are managing has no `UMAMI_URL`, the card warns you that
   the switch has no effect there.

Visitors' browsers never contact Umami. The status page delivers the tracker as
`/pulse/p.js` and passes the events of `/pulse/api/send` on to Umami, so your
Umami server may stay internal and the page needs no exception in its security
policy. The address of the Umami server is deliberately an environment variable
and not a setting: nobody who only has access to the management UI can make
the server connect elsewhere.

What visitors and your statistics get:

- Every public page has **Disable statistics** in the footer, next to the
  privacy policy. It works without JavaScript and stores the choice in the
  cookie `osp-analytics` for a year; afterwards the page says "Statistics are
  disabled." and offers **Enable statistics**. That cookie always decides: if
  it expires or is deleted, the page counts again and says so in the footer.
- Subscription links from emails are never counted, and tokens (with the
  subscription ID next to them) and `#fragments` are removed from every
  address before it reaches Umami. The management UI is never
  counted.
- **Respect Do Not Track and Global Privacy Control** (on by default) sends
  nothing for browsers that ask not to be tracked.
- **Pass visitors' IP addresses to Umami** is off by default. Umami then only
  sees your status page server: it shows no visitor locations (or the server's
  location), and visitors with the same browser version count as one visitor,
  so visitor numbers are too low while page views stay right. Switch it on
  only if your privacy policy covers it, and set `TRUST_PROXY` behind a reverse
  proxy (see [Reverse proxy](03-reverse-proxy.md#trust_proxy)), otherwise
  Umami gets the proxy's address.
- **Only on these domains** limits counting to the host names you list, for
  example to leave out a staging copy.

If Umami is down or slow, the pages keep working without errors; the
statistics simply miss those page views. The website ID is visible in every
page, so anyone could send made-up page views, as with any Umami setup; treat
the numbers as a trend, not as an exact count. Mention the statistics in your privacy policy. Details
and limits: [configuration.md](../../configuration.md#analytics).

## Checking the effective configuration

There is no page that prints the environment, on purpose. To check a value:

- the start-up log reports configuration errors and warns about an insecure
  `SECRET_KEY` or a risky OIDC setup;
- the **Email delivery** panel on the settings page shows the mail transport
  and sender
  (see [Email subscriptions](07-email-subscriptions.md#troubleshooting));
- `docker compose exec openstatuspage env` lists what the container actually
  received (it contains secrets, do not paste the output anywhere).

# OpenStatusPage

 [LIVE DEMO HERE](https://openstatus.partlabs.de/)

A self-hosted, open-source status page for companies that want to keep their
customers informed **without exposing their internal infrastructure**.

Public visitors see curated services, sites and locations together with
incidents and maintenance windows. Internally, every public service can be
composed from any number of monitoring checks (Icinga 2, Uptime Kuma,
openITCockpit, generic webhooks). Check names, hosts and outputs never leave the
management area.

> Status: early development.

## Features

- **Overview**: current incidents, active and upcoming maintenance, overall status
- **Services & Sites**: grouped services with 90-day uptime bars; every day links to a day page with its status periods, corrections, incidents and maintenance
- **Private status pages**: a page with a secret link for chosen services, also hidden ones, managed in the admin UI; never indexed or cached
- **Locations**: data center / PoP locations on a map with live status
- **History**: filterable archive of incidents and maintenance
- **Monitoring adapters**: Icinga 2, Uptime Kuma, openITCockpit, generic webhook (pull and push)
- **Service composition**: build public services from internal checks with configurable aggregation rules
- **Check bundles**: let several monitoring nodes (e.g. Uptime Kuma instances in different places) vote with weights on the state of one target
- **Management UI**: incidents, maintenance, services, groups, locations, monitoring sources, users, branding
- **Auth**: local users (admin / editor) and optional OIDC single sign-on
- **Databases**: SQLite (zero config) or PostgreSQL
- **i18n**: English and German included
- **Email notifications**: double opt-in subscriptions for all updates or selected services, maintenance reminders, one-click unsubscribe
- **Webhooks and SMS**: team webhooks for Discord, Slack, Microsoft Teams and generic JSON (HMAC-signed), SMS through a configurable HTTP provider (presets for Twilio, Vonage, seven.io and MessageBird) and on-call numbers; visitors can subscribe by webhook or SMS (confirmed with a code), with a monthly SMS budget and an SSRF-guarded outbound delivery queue
- **Works without JavaScript**: every public page is rendered on the server and works without scripts (filters, subscriptions, language and theme are links and forms); scripts only enhance it
- **Search engines and AI agents**: unique titles, canonical and language links, JSON-LD, `robots.txt`, a sitemap index with page, incident and service sitemaps, and `llms.txt` (see the [public page guide](docs/guide/en/12-public-page.md))
- **[JSON:API 1.1](docs/api.md) HTTP API and RSS/Atom feeds** (since 0.2.0; a breaking change for API clients of 0.1.x, see the [changelog](CHANGELOG.md))

## Quick start (Docker Compose)

Prebuilt multi-arch images (amd64, arm64) are published to the GitHub
Container Registry as `ghcr.io/raphael-penning/openstatuspage`. Every release
ships a `compose.yaml` (the app and PostgreSQL) and a settings template.
Install the newest release into a new directory:

```bash
mkdir openstatuspage && cd openstatuspage
curl -fsSLO https://github.com/Raphael-Penning/openstatuspage/releases/latest/download/compose.yaml
curl -fsSL -o .env https://github.com/Raphael-Penning/openstatuspage/releases/latest/download/env.example
printf 'SECRET_KEY=%s\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -base64 48)" "$(openssl rand -hex 16)" >> .env
chmod 600 .env
# edit .env: BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD (and HOST_PORT / TRUST_PROXY for your proxy)
docker compose up -d
```

No reverse proxy is included: put your own proxy with HTTPS in front of the
app, see [Reverse proxy and HTTPS](docs/guide/en/03-reverse-proxy.md), then
open `BASE_URL/admin` and log in. With an `https://` `BASE_URL` the login
cookie is Secure, so logging in over plain `http://<host>:3000` does not
work; before the proxy is ready use `http://localhost:3000` on the host
(e.g. through `ssh -L 3000:127.0.0.1:3000 <host>`). All settings,
including mail and single sign-on, go into `.env`; keep a copy of
`SECRET_KEY` and `POSTGRES_PASSWORD`. The downloaded files are pinned to
their release via `OSP_VERSION` in `.env`; change it deliberately to
upgrade. Later commands are plain `docker compose ...` in that directory.

To build the image from a clone instead, create `.env` the same way in
[`deploy/compose/`](deploy/compose/) and run
`docker compose -f compose.yaml -f compose.build.yaml up -d --build` there
(see [building the image yourself](docs/guide/en/02-installation.md#building-the-image-yourself)).

The [installation and deployment guide](docs/guide/en/02-installation.md)
covers the Compose setup in detail, SQLite, Kubernetes
([Helm chart](deploy/helm/openstatuspage/) or
[example manifests](deploy/kubernetes/)) and upgrades. To serve the public
page and the admin area on separate domains, with a worker of its own and a
database role that can only read public data, see the
[split deployment](docs/guide/en/02-installation.md#split-deployment)
([compose example](deploy/compose/compose.split.yaml)). See
[docs/configuration.md](docs/configuration.md) for all settings,
[CONTRIBUTING.md](CONTRIBUTING.md) for local development and
[docs/releasing.md](docs/releasing.md) for how images and releases are made.

## Documentation

- [Setup and operations guide](docs/guide/en/01-overview.md): installation
  and deployment (Docker Compose, Kubernetes), reverse proxy, monitoring
  integration, daily work, email subscriptions, backups, upgrades and a
  security checklist (also available in German and inside the management UI
  under **Help**)
- [Documentation index](docs/README.md): configuration, API, monitoring
  adapters, OIDC, architecture design and releasing
- [HTTP API reference](docs/api.md): [JSON:API 1.1](https://jsonapi.org/format/1.1/)
  with an example for every endpoint. Since 0.2.0 requests and responses use
  `application/vnd.api+json`; API clients written for 0.1.x need to be updated
  (see the [changelog](CHANGELOG.md)).

```sh
curl -g -H "Authorization: Bearer $OSP_TOKEN" \
  "https://status.example.com/api/admin/incidents?filter[status]=active&page[size]=10"
```

## License

[AGPL-3.0](LICENSE)

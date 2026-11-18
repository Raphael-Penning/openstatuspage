# OpenStatusPage

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
- **Services & Sites**: grouped services with 90-day uptime bars
- **Locations**: data center / PoP locations on a map with live status
- **History**: filterable archive of incidents and maintenance
- **Monitoring adapters**: Icinga 2, Uptime Kuma, openITCockpit, generic webhook (pull and push)
- **Service composition**: build public services from internal checks with configurable aggregation rules
- **Management UI**: incidents, maintenance, services, groups, locations, monitoring sources, users, branding
- **Auth**: local users (admin / editor) and optional OIDC single sign-on
- **Databases**: SQLite (zero config) or PostgreSQL
- **i18n**: English and German included
- **Email notifications**: double opt-in subscriptions for all updates or selected services, maintenance reminders, one-click unsubscribe
- **Public API and RSS/Atom feeds**

## Quick start (Docker)

Prebuilt multi-arch images (amd64, arm64) are published to the GitHub
Container Registry as `ghcr.io/raphael-penning/openstatuspage`. Get the compose
file (or clone the repository), create a private env file and start the stack
with PostgreSQL:

```bash
mkdir -p openstatuspage/docker && cd openstatuspage
curl -fsSL -o docker/docker-compose.yml \
  https://raw.githubusercontent.com/Raphael-Penning/openstatuspage/main/docker/docker-compose.yml

touch deploy.env && chmod 600 deploy.env
cat >> deploy.env <<EOF
SECRET_KEY=$(openssl rand -base64 48)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=a-long-password
OSP_VERSION=latest   # or a release such as 1.2.3; "edge" until the first release
EOF

docker compose --env-file deploy.env -f docker/docker-compose.yml pull
docker compose --env-file deploy.env -f docker/docker-compose.yml up -d
```

The status page is then served on http://localhost:3000 and the management UI on
http://localhost:3000/admin. Keep `deploy.env`: later commands need the same
secrets. Add `BASE_URL` (the public URL), `HOST_PORT` (published port) and
`OSP_VERSION` to it; pinning a release such as `OSP_VERSION=1.2.3` is
recommended, the default `latest` is the newest stable release and `edge` the
current `main` branch. Optional demo data:
`docker compose --env-file deploy.env -f docker/docker-compose.yml exec openstatuspage node server/dist/cli/seed.js`.

To build the image from a checkout instead, add the build override:
`docker compose --env-file deploy.env -f docker/docker-compose.yml -f docker/docker-compose.build.yml up -d --build`.

The [installation and deployment guide](docs/guide/en/02-installation.md)
covers HTTPS, SQLite, Kubernetes ([example manifests](deploy/kubernetes/)) and
upgrades. See [docs/configuration.md](docs/configuration.md) for all settings,
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

## License

[AGPL-3.0](LICENSE)

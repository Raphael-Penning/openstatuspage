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
- **Public API and RSS/Atom feeds**

## Quick start (Docker)

```bash
export SECRET_KEY="$(openssl rand -base64 48)"
export POSTGRES_PASSWORD="$(openssl rand -hex 16)"
export ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='a-long-password'
docker compose -f docker/docker-compose.yml up -d --build
```

The status page is then served on http://localhost:3000 and the management UI on
http://localhost:3000/admin. Set `HOST_PORT` to publish a different port and
`BASE_URL` to the public URL. Optional demo data:
`docker compose -f docker/docker-compose.yml exec openstatuspage node server/dist/cli/seed.js`.

See [docs/configuration.md](docs/configuration.md) for all settings and
[CONTRIBUTING.md](CONTRIBUTING.md) for local development.

## Documentation

- [Setup and operations guide](docs/guide/en/01-overview.md): installation,
  reverse proxy, monitoring integration, daily work, email subscriptions,
  backups, upgrades and a security checklist (also available in German and
  inside the management UI under **Help**)
- [Documentation index](docs/README.md): configuration, API, monitoring
  adapters, OIDC and architecture

## License

[AGPL-3.0](LICENSE)

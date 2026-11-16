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

## License

[AGPL-3.0](LICENSE)

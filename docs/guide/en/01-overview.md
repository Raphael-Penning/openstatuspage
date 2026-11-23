# Overview and concepts

OpenStatusPage is a self-hosted status page. Your customers see the state of
the services you offer; your internal infrastructure (hosts, checks, monitoring
systems) stays private. This guide explains how to set it up and run it.

The guide is also available in the management UI under **Help**, in the
language you selected there.

## The two halves of the application

| Part | URL | Audience |
| --- | --- | --- |
| Public status page | `/` (e.g. `https://status.example.com/`) | customers, no login |
| Management UI | `/admin` | your team, login required |

Both are served by a single Node.js process together with the HTTP API
(`/api/...`), RSS and Atom feeds (`/feed.rss`, `/feed.atom`) and a background
worker for scheduled jobs. It is published as a container image for Docker
Compose, a single container or Kubernetes, and also runs directly from
source.

## Building blocks

**Services** are what your customers care about, for example "Web
application", "Public API" or "DNS". A service has a public status:

| Status | Meaning |
| --- | --- |
| Operational | everything works |
| Maintenance | a planned maintenance is in progress |
| Degraded performance | slower or partly impaired |
| Partial outage | some customers or functions are affected |
| Major outage | the service is unavailable |

A service is either a *service* or a *site* (a website with a public URL that
is shown as a link). Every service can be public or hidden; hidden services are
only visible in the management UI.

**Groups** structure the public list of services, e.g. "Platform", "Network"
and "Websites". A group can be collapsed by default on the public page.

**Locations** are data centers or points of presence. Services are linked to
the locations they run in, and the public map shows each location with the
worst status of its public services. A location can also be given a fixed
status by hand (override).

**Checks** are imported from your monitoring systems (Icinga 2, Uptime Kuma,
openITCockpit or any system that can send a webhook). A **monitoring source**
is the connection to one such system. Checks are internal: their names, hosts,
outputs and even their number never appear on the public page or in the public
API.

**Incidents** are unplanned disruptions you communicate. An incident has a
title, a status (*Investigating*, *Identified*, *Monitoring*, *Resolved*), an
impact, affected services and a timeline of updates.

**Maintenance** announces planned work with a scheduled window. While a
maintenance is in progress, its services show *Maintenance* on the public page.

**Subscribers** receive emails about public incidents and maintenance, if you
enable [email subscriptions](07-email-subscriptions.md). Webhooks (Discord, Slack,
Teams, generic JSON) and SMS can get the same notifications, see
[Webhooks and SMS](13-webhooks-and-sms.md).

## How a service gets its status

Each service has a *status source*:

- **Automatic**: the status is calculated from the linked checks. Every link
  maps the check state to a service status (defaults: warning → degraded
  performance, critical → major outage, unknown → ignored).
- **Manual**: you set the status by hand; checks are ignored.

On top of that base status:

1. An **in-progress public maintenance** replaces the base status with
   *Maintenance*.
2. **Unresolved public incidents** set the status they declare for the
   service; the worst status wins.

How several checks are combined is configured per service (*aggregation*):

- **Worst check**: the worst mapped status of any check.
- **Redundancy (quorum)**: for redundant setups. A failing check only causes a *partial
  outage* unless all checks with a critical mapping fail at the same time;
  warnings are capped at *degraded performance*.

Uptime bars on the public page are calculated per UTC day from the recorded
status history. *Degraded performance* and *Maintenance* count as up.
[Corrections](06-daily-work.md#correcting-the-history) (a forgotten
maintenance, a false alarm) are applied on top of the recorded history; the
recorded data itself is never changed.

See [Monitoring integration](05-monitoring.md) for the details of composing
services from checks.

## Privacy model

The core promise is: **customers see services, never infrastructure.**

- Monitoring sources, checks, hosts, check outputs and credentials are only
  available in the management UI and the admin API (`/api/admin/...`).
- The public API (`/api/public/...`) and the feeds only return public
  services, groups, locations, incidents and maintenance, field by field.
  Hidden objects and anything about monitoring never leave the server.
- Monitoring credentials are stored encrypted (AES-256-GCM, key derived from
  `SECRET_KEY`) and are never shown again after saving.
- Session tokens, API tokens and ingest tokens are stored as hashes only.
- Subscriber email addresses are only visible to administrators.

## Where to go next

1. [Install and deploy](02-installation.md) the application.
2. Put it [behind a reverse proxy with HTTPS](03-reverse-proxy.md).
3. Review the [configuration](04-configuration.md) and the settings page.
4. Connect your [monitoring](05-monitoring.md) and create services.
5. Learn the [daily work](06-daily-work.md) with incidents and maintenance, and
   how the [public page](12-public-page.md) reaches search engines and visitors
   without JavaScript.
6. Plan [backups, upgrades and monitoring](09-operations.md) of the status page
   itself, and go through the [security checklist](11-security-checklist.md).

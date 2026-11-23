# Documentation

## Setup and operations guide

A step-by-step guide for administrators who install and run OpenStatusPage.
It is also shown in the management UI under **Help**, in English or German.

| Topic | English | Deutsch |
| --- | --- | --- |
| Overview and concepts | [en](guide/en/01-overview.md) | [de](guide/de/01-overview.md) |
| Installation and deployment | [en](guide/en/02-installation.md) | [de](guide/de/02-installation.md) |
| Reverse proxy and HTTPS | [en](guide/en/03-reverse-proxy.md) | [de](guide/de/03-reverse-proxy.md) |
| Configuration | [en](guide/en/04-configuration.md) | [de](guide/de/04-configuration.md) |
| Monitoring integration | [en](guide/en/05-monitoring.md) | [de](guide/de/05-monitoring.md) |
| Daily work: incidents and maintenance | [en](guide/en/06-daily-work.md) | [de](guide/de/06-daily-work.md) |
| Email subscriptions | [en](guide/en/07-email-subscriptions.md) | [de](guide/de/07-email-subscriptions.md) |
| Users and access | [en](guide/en/08-users-and-access.md) | [de](guide/de/08-users-and-access.md) |
| Operations: backups, upgrades, monitoring | [en](guide/en/09-operations.md) | [de](guide/de/09-operations.md) |
| Troubleshooting | [en](guide/en/10-troubleshooting.md) | [de](guide/de/10-troubleshooting.md) |
| Security checklist | [en](guide/en/11-security-checklist.md) | [de](guide/de/11-security-checklist.md) |
| Webhooks and SMS | [en](guide/en/13-webhooks-and-sms.md) | [de](guide/de/13-webhooks-and-sms.md) |

## Reference

| Document | Contents |
| --- | --- |
| [configuration.md](configuration.md) | Every environment variable with defaults |
| [notifications.md](notifications.md) | Email subscriptions: mail transport, delivery queue, stored data, deliverability, troubleshooting; webhooks (Discord, Slack, Teams, generic JSON) and SMS: events, formats, signing, providers, limits |
| [api.md](api.md) | HTTP API: public, auth, admin, webhook and SMS subscription and ingest endpoints |
| [adapters/](adapters/README.md) | Monitoring adapters: Icinga 2, Uptime Kuma, openITCockpit, generic webhook |
| [oidc.md](oidc.md) | Single sign-on with OpenID Connect, role mapping, provider notes |
| [architecture.md](architecture.md) | Code layout, privacy model, status model, database, worker |
| [security-model.md](security-model.md) | Split deployment on PostgreSQL: what the restricted public database role can and cannot do, how it is enforced, threat model |
| [accessibility.md](accessibility.md) | WCAG 2.2 AA for the public page and the emails: implementation, automated checks, manual test checklist, known limitations |
| [releasing.md](releasing.md) | Container image pipeline, image tags, cutting a release, release assets, Helm chart publishing, GHCR setup (maintainers) |
| [../deploy/compose/](../deploy/compose/) | Docker Compose setup (`compose.yaml`, `.env.example`, build override `compose.build.yaml`), also attached to every release, see [installation](guide/en/02-installation.md#docker-compose) |
| [../deploy/helm/openstatuspage/](../deploy/helm/openstatuspage/) | Helm chart (recommended on Kubernetes, single instance or split mode), see [installation](guide/en/02-installation.md#kubernetes-with-helm) |
| [../deploy/kubernetes/](../deploy/kubernetes/) | Example Kubernetes manifests (Kustomize), see [installation](guide/en/02-installation.md#kubernetes) |

## Writing the guide

The guide lives in `docs/guide/<language>/` with identical file names per
language; the numeric prefix defines the order and the first `#` heading is
the topic title. Links between topics are relative (`02-installation.md#...`),
so they work on GitHub and in the management UI. Tests in `apps/web` check that
both languages have the same files and that all links and anchors resolve.

# Monitoring adapters

OpenStatusPage does not monitor anything itself. It imports **check results**
from the monitoring systems you already run and lets you build public
**services** from them. Checks, hosts, outputs and sources are internal data:
they are only visible in the admin UI and never appear on the public page or
in the public API (not even their number).

| System | Pull (status page polls) | Push (monitoring sends) | Guide |
| --- | --- | --- | --- |
| Icinga 2 | REST API `/v1/objects/services`, `/v1/objects/hosts` | notification script | [icinga2.md](icinga2.md) |
| Uptime Kuma | Prometheus endpoint `/metrics` | native webhook notification | [uptime-kuma.md](uptime-kuma.md) |
| openITCockpit | API `/services/index.json`, `/hosts/index.json` | notification command | [openitcockpit.md](openitcockpit.md) |
| anything else | – | generic JSON (`webhook` source type) | [below](#generic-push-api) |

## Pull vs. push

**Pull** – OpenStatusPage queries the monitoring API every *poll interval*
(default 60 s, per source) and imports the **complete** set of checks:

- new checks appear automatically, checks that disappear from the monitoring
  system are removed (including their links to services);
- the "Test connection" button in the admin UI shows whether credentials and
  URL work without storing anything; "Poll now" polls immediately;
- a failed poll (network error, timeout, HTTP error) only records the error on
  the source. Check states keep their last known value, so a broken
  connection never turns your status page red or green on its own;
- an empty result while checks exist is treated as an error as well (usually a
  broken filter or missing permissions), so service links are not lost;
- responses larger than 50 MiB (after decompression) are rejected as an error.

**Push** – the monitoring system calls OpenStatusPage on every state change:

- state changes appear within seconds instead of after the next poll;
- only the reported checks are updated (no removal; only `webhook` sources can
  send a complete set with `full`, see [Generic push API](#generic-push-api));
- push and pull can be combined on the same source: the external IDs are
  identical, pull provides the complete list and push the fast updates.

### Network and DMZ considerations

The status page is usually hosted where customers can reach it, often outside
the internal network. Choose the direction that fits your firewall policy:

| | Push | Pull |
| --- | --- | --- |
| Connection | monitoring → status page (outbound HTTPS from the internal network) | status page → monitoring API (inbound to the internal network) |
| Firewall | usually already allowed (like any outgoing HTTPS) | needs a rule from the status page host to the monitoring API |
| Credentials stored on the status page | none (only the hash of the ingest token) | API credentials, encrypted at rest |
| Typical use | status page in a DMZ or in the cloud | status page inside the same trusted network |

If the status page runs in a DMZ, **push is the recommended mode**: nothing on
the status page can reach into your monitoring system, and a compromised status
page does not expose monitoring credentials.

### Least-privilege credentials

- Create a dedicated, **read-only** API user / key for OpenStatusPage. Never
  reuse an administrator account.
- Restrict it to the objects that feed the status page where the monitoring
  system allows that (Icinga 2 permission filters, openITCockpit containers,
  separate Uptime Kuma instance for public checks if needed).
- Keep TLS verification enabled. Disable it only for self-signed certificates in
  trusted networks; prefer adding your internal CA to the system trust store
  (`NODE_EXTRA_CA_CERTS=/path/to/ca.pem`).
- Monitoring credentials are stored encrypted with a key derived from
  `SECRET_KEY` and are never returned by the API (masked as `••••••••`).
- Ingest tokens are stored as SHA-256 hashes; the token is shown once on
  creation and can be rotated at any time.
- Error messages stored on the source never contain credentials.

## From checks to public services

1. **Admin → Monitoring sources → Add**: choose the type, enter URL and
   credentials (pull) and/or copy the ingest URL and token (push).
2. Use **Test connection** (pull) or trigger a notification (push). Imported
   checks appear under **Admin → Checks**.
3. **Admin → Services**: create or edit a service and link one or more checks.
   Each link maps the check state to a public status (defaults:
   `warning → degraded`, `critical → major outage`, `unknown → ignored`).
   With aggregation `quorum`, redundant checks only cause a partial outage
   when some of them fail.
4. The public page shows only the resulting service status. Incidents and
   maintenance windows are managed separately and override the check-based
   status where appropriate.

## Check bundles

When several monitoring nodes watch the **same target from different places**
(typically several Uptime Kuma instances in different data centres or
networks), one node alone should not decide that the target is down: its own
network may be the problem. A **check bundle** combines one check of each node
into a single check that is decided by a **weighted majority vote**.

- **Admin → Monitoring → Bundles → New bundle**: give the bundle a name and pick,
  per source (node), the check that watches the target. Every member gets a
  number of **votes** (whole number, at least 1, default 1). Matching is manual:
  nothing is grouped automatically. A check may belong to several bundles; a
  bundle cannot contain another bundle. Members may come from any source type;
  the dialog shows Uptime Kuma sources by default.
- Each bundle is a check of the built-in source **Check bundles** (type
  `bundle`) and is linked to services like any other check, with the usual
  warning/critical/unknown mappings. That source is created with the first
  bundle, is never polled, accepts no pushes and cannot be edited; it can only
  be deleted while no bundle exists.

### How the vote works

Only members that currently **report** take part. A member does not report when

| Reason | Shown as |
| --- | --- |
| its source is disabled | source disabled |
| the last poll of its (pull) source failed | last poll failed |
| its check state is `unknown` | state unknown |
| it has no result yet | no result yet |
| its result is too old: for pull sources (Icinga 2, Uptime Kuma, openITCockpit) neither a **successful poll** nor a result within the last **3 poll intervals, at least 5 minutes**; for push-only `webhook` sources no result within `BUNDLE_PUSH_STALE_SECONDS` (default 1 hour) | result too old |

For pull sources a recent successful poll is enough: it proves that the node
reports and that the value is current. Icinga 2 and openITCockpit report when
the check itself ran, which with the usual 5-minute check interval is
regularly older than 5 minutes just before the next run; such a member stays
in the vote as long as its source polls successfully. Only when polling stops
(the source is not polled any more and no new results arrive) does the age of
the result decide. Push results to a pull source also refresh the result age.

With *R* = the votes of the reporting members:

| Bundle state | Condition |
| --- | --- |
| `critical` | critical votes **> 50 %** of *R* |
| `warning` | otherwise, critical + warning votes > 50 % of *R* |
| `ok` | otherwise |
| `unknown` | no member reports (*R* = 0) |

Exactly half is **not** a majority. Uptime Kuma's *pending* (retrying) is a
warning, so pending nodes make the bundle *degraded* (with the default mapping)
before they make it *down*.

Examples with three nodes A (2 votes), B (1 vote), C (1 vote), 4 votes in total:

| A | B | C | Result |
| --- | --- | --- | --- |
| down | up | up | `ok`: 2 of 4 votes is exactly half |
| down | down | up | `critical`: 3 of 4 |
| up | down | down | `ok`: 2 of 4 |
| down | not reporting | up | `critical`: 2 of 3 reporting votes |
| down | pending | up | `warning`: critical + warning = 3 of 4 |
| not reporting | not reporting | not reporting | `unknown` (ignored by the default mapping) |

Bundles are re-evaluated whenever a member check receives a result, after every
poll (success or failure), when a source is enabled, disabled, changed or
deleted, when the bundle is edited, and every minute by the background worker,
so a node that goes silent drops out of the vote even if nothing else happens.
The bundle check's output (admin only) summarizes the vote, e.g.
`critical: 3 of 4 reporting votes down, 0 warning`; the admin page shows the
breakdown per member. Nothing of this is visible publicly.

## Ingest API

```
POST /api/ingest/<source-id>                 generic JSON (all source types)
POST /api/ingest/<source-id>/icinga2         Icinga 2 notification script
POST /api/ingest/<source-id>/uptimekuma      Uptime Kuma webhook
POST /api/ingest/<source-id>/openitcockpit   openITCockpit notification command
```

- Authentication: `Authorization: Bearer <ingest token>`, or `?token=<ingest token>`
  for senders that cannot set headers. Prefer the header: query strings tend to
  end up in proxy and access logs.
- `Content-Type: application/json` (JSON sent as `text/plain` is accepted, too).
- Native endpoints accept payloads for sources of the same type or of type
  `webhook`; the generic endpoint works for every source type.
- Responses: `200 {"ok":true,"created":0,"updated":1,"removed":0,"stateChanges":1}`,
  `400` invalid payload (or `full` on a source that is not of type `webhook`),
  `401` missing or wrong token, `404` unknown source, `409` source disabled,
  the check bundle source (bundle states are computed) or full sync rejected
  (see below), `429` more than 120 requests per minute for
  the source (see `Retry-After`).

### Generic push API

For scripts, CI jobs, cron jobs or monitoring systems without a dedicated adapter.
Create a source of type `webhook` and send:

```bash
curl -fsS https://status.example.com/api/ingest/<source-id> \
  -H "Authorization: Bearer $OSP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "checks": [
          { "id": "backup-nightly", "name": "Nightly backup", "state": "ok", "output": "42 GB in 12 min" },
          { "id": "db01!replication", "host": "db01", "state": 2, "output": "lag 900 s" }
        ]
      }'
```

| Field | Description |
| --- | --- |
| `checks[].id` | Stable ID within the source (required, max 500 characters) |
| `checks[].name` | Display name in the admin UI (new checks default to `id`; omitted on later pushes keeps the stored name) |
| `checks[].host` | Host name (internal only; omitted keeps the stored host) |
| `checks[].state` | `ok`, `warning`, `critical`, `unknown` or `0`–`3` (Nagios convention) |
| `checks[].output` | Check output (internal only, max 5000 characters; omitted keeps the stored output unless the state changed) |
| `checks[].timestamp` | ISO-8601 time of the check (default: now) |
| `full` | `true` = the payload is the complete set; checks missing from it are removed (sources of type `webhook` only) |

Up to 5000 checks per request (5 MiB body). Sending full metadata once and only
`id` + `state` afterwards is fine.

**Full sync (`"full": true`).** Removing a check also removes its links to
services, and the links do not come back when the check is pushed again. To
protect that configuration:

- `full` is accepted only for sources of type `webhook`. Pull sources get their
  complete list from polling; a full push to them is rejected with `400`.
- A full push that would remove **more than half of the checks linked to
  services or used as members of a check bundle** is rejected with `409` and
  nothing is stored (the push counterpart of the poller's "empty result"
  guard). Include the missing checks, unlink them (or take them out of the
  bundle) in the admin UI first, or push without `full`. Checks that are
  neither linked nor bundle members are removed without this limit.

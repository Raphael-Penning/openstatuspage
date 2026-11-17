# Monitoring integration

OpenStatusPage does not monitor anything itself. It imports check results from
the monitoring systems you already run and lets you build public services from
them. This page gives an overview; the detailed adapter documentation is in
[`docs/adapters/`](../../adapters/README.md).

| System | Pull (status page queries) | Push (monitoring sends) | Details |
| --- | --- | --- | --- |
| Icinga 2 | REST API | notification script from `contrib/icinga2` | [icinga2.md](../../adapters/icinga2.md) |
| Uptime Kuma | Prometheus endpoint `/metrics` | built-in webhook notification | [uptime-kuma.md](../../adapters/uptime-kuma.md) |
| openITCockpit | JSON API | notification command from `contrib/openitcockpit` | [openitcockpit.md](../../adapters/openitcockpit.md) |
| anything else | – | generic JSON webhook | [Generic push API](../../adapters/README.md#generic-push-api) |

## Pull or push?

**Pull**: the status page queries the monitoring API at a fixed interval
(default 60 seconds per source) and always imports the complete set of checks.
New checks appear automatically, removed checks disappear together with their
service links. A failed poll only records an error on the source; checks keep
their last known state, so a broken connection never changes the public page
by itself.

**Push**: the monitoring system calls OpenStatusPage on every state change.
Changes appear within seconds, only the reported checks are updated, and the
status page needs no credentials for your monitoring.

Both can be combined on one source: pull for the complete list, push for fast
updates.

Which direction fits depends on your network:

| | Push | Pull |
| --- | --- | --- |
| Connection | monitoring → status page (outbound HTTPS) | status page → monitoring API (inbound into your network) |
| Credentials on the status page | none (only a hashed ingest token) | API credentials, stored encrypted |
| Typical setup | status page in a DMZ or in the cloud | status page in the same trusted network |

If the status page is reachable from the internet, **push is the recommended
mode**: a compromised status page then cannot reach into your monitoring.

For pull, create a dedicated **read-only** API user restricted to the objects
that feed the status page. Keep TLS verification on; for an internal CA set
`NODE_EXTRA_CA_CERTS=/path/to/ca.pem` in the environment instead of disabling
verification.

## Connecting a source

1. **Monitoring → Sources → New source** (administrators): choose the type.
   - For pull, enter the base URL and the credentials, then use **Test
     connection**. **Poll now** imports immediately.
   - For push, copy the **ingest URL** and the **token**. The token is shown
     only once; it can be rotated later.
2. Configure the monitoring side as described in the adapter documentation
   (Icinga 2 notification command, Uptime Kuma webhook notification,
   openITCockpit notification command or your own script).
3. Imported checks appear under **Monitoring → Checks**.

The source list shows the time and result of the last poll. A source with a
failing poll keeps its checks at their last state; fix the error shown there.

### Generic webhook

For scripts, cron jobs or systems without an adapter, create a source of type
**Webhook** and send JSON:

```bash
curl -fsS https://status.example.com/api/ingest/<source-id> \
  -H "Authorization: Bearer $OSP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"checks":[{"id":"backup-nightly","name":"Nightly backup","state":"ok"}]}'
```

States are `ok`, `warning`, `critical`, `unknown` or `0`–`3`. Prefer the
`Authorization` header over the `?token=` query parameter: query strings tend
to end up in proxy logs. The full format is described in
[`docs/adapters/README.md`](../../adapters/README.md#generic-push-api).

Add `"full": true` when the payload is the complete list of checks: checks
missing from it are removed, together with their service links. This works
only for **Webhook** sources (other types get their list from polling, and
the server answers `400`). As a safety net, a full push that would remove more than half
of the checks linked to services is rejected with `409` and changes nothing;
unlink those checks first if the removal is intended.

## Composing services from checks

A public service is built from any number of internal checks:

1. **Catalog → Services & sites**: create a service (or open an existing one)
   with status source **Automatic**.
2. Under **Linked monitoring checks** use **Link checks** and search by name,
   host or ID.
3. For every link choose which service status each check state causes:

   | Check state | Default service status |
   | --- | --- |
   | OK | – (no effect) |
   | Warning | Degraded performance |
   | Critical | Major outage |
   | Unknown | ignored |

   Every mapping can be changed or set to "Ignore" per link. For example, a
   check of a non-essential component can map *Critical* to *Degraded
   performance*.
4. Choose how the checks are combined:
   - **Worst check**: the worst mapped status wins. Use it when every component
     is required.
   - **Redundancy (quorum)**: for redundant components (e.g. several web
     servers behind a load balancer). As long as not all checks with a
     critical mapping are critical, the service is at most *Partial outage*;
     warnings count at most as *Degraded performance*.
5. The preview shows the resulting status before you save.

Customers only ever see the resulting status. Incidents and maintenance are
managed separately and override the check-based status (see
[Overview](01-overview.md#how-a-service-gets-its-status)).

## Tips

- Monitoring downtimes and acknowledgements do not change the imported state.
  Announce planned work as a **maintenance** in OpenStatusPage; it takes
  precedence over the checks of the affected services.
- Soft states (Icinga 2) and retries are ignored; only hard states count, so
  short flaps do not reach the public page.
- With Uptime Kuma pull, pausing a monitor removes its check (and its service
  links) on the next poll.
- Removing a check also removes its service links. If a service suddenly shows
  no checks, look for renamed hosts or monitors.
- Ingest endpoints are rate limited to 120 requests per minute per source.
  Batch many results into one request (up to 5000 checks, 5 MiB).

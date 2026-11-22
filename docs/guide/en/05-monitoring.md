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
verification. To turn verification off for a source, enter its password or API
key again (as when you change the URL or user name).

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

The body is plain JSON, not a JSON:API document. The answer is a JSON:API
document that counts what changed:

```json
{"jsonapi":{"version":"1.1"},"meta":{"created":1,"updated":0,"removed":0,"stateChanges":0}}
```

States are `ok`, `warning`, `critical`, `unknown` or `0`–`3`. Prefer the
`Authorization` header over the `?token=` query parameter: query strings tend
to end up in proxy logs. The full format is described in
[`docs/adapters/README.md`](../../adapters/README.md#generic-push-api).

Add `"full": true` when the payload is the complete list of checks: checks
missing from it are removed, together with their service links. This works
only for **Webhook** sources (other types get their list from polling, and
the server answers `400`). As a safety net, a full push that would remove more than half
of the checks linked to services or used in check bundles is rejected with
`409` and changes nothing; unlink those checks (or take them out of the
bundle) first if the removal is intended.

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

## Check bundles: several nodes vote

If you monitor the same target from several places, for example with two or
three Uptime Kuma instances in different data centres, a single node should not
be able to put your status page into an outage: maybe only its own network is
broken. A **check bundle** combines one check per node into one check that is
decided by a **majority vote**.

**When to use a bundle:** the checks measure the *same* thing from *different*
places. For different components (web server, database, …) keep linking the
checks to the service directly and use the aggregation (worst check / quorum).

**Create a bundle:**

1. Add every monitoring node as its own source (e.g. *Kuma Frankfurt*,
   *Kuma Amsterdam*, *Kuma New York*).
2. **Monitoring → Bundles → New bundle**: enter a name, then pick for each node
   the check that watches the target and click **Add**. The list shows Uptime
   Kuma sources; choose another source type in the filter if needed.
3. Set the **votes** of each member (whole number, at least 1). Give a node more
   votes if you trust it more, e.g. because it runs in a better connected
   location.
4. Save, then link the bundle in the service like any other check
   (**Link checks**, search for the bundle name). Do not link the individual
   node checks as well, or a single node can still change the service.

**How the vote works:** only nodes that currently **report** count. A node does
not report when its source is disabled, its last poll failed, its check is
*unknown*, or it has gone silent: for polled sources neither a successful
poll nor a new result within 3 poll intervals (at least 5 minutes), for pure
webhook sources no result for one hour by default. A successful poll is
enough, so an Icinga check that last ran 6 minutes ago still counts while
Icinga answers. Of the votes of the reporting nodes:

- more than half say *down* → the bundle is **critical**;
- otherwise more than half say *down* or *pending/warning* → **warning**;
- otherwise → **OK**;
- no node reports → **unknown** (ignored by the default mapping).

Exactly half is **not** a majority. Examples with three nodes, Frankfurt
2 votes, Amsterdam and New York 1 vote each (4 votes):

| Frankfurt | Amsterdam | New York | Bundle |
| --- | --- | --- | --- |
| down | up | up | OK (2 of 4, exactly half) |
| down | down | up | critical (3 of 4) |
| up | down | down | OK (2 of 4) |
| down | not reporting | up | critical (2 of 3 reporting votes) |
| down | pending | up | warning (3 of 4 down or pending) |

The **Bundles** page shows every bundle with its current result and, per node,
the votes, the state and whether (and why not) it counts. It refreshes on its
own. All of this is internal; customers only see the resulting service status.

## Importing history

The status page records history from the moment a check is connected. The
uptime bars of a new installation therefore start empty. To fill the time
before, import the history your monitoring systems already keep:

| System | Read from | What you need |
| --- | --- | --- |
| Uptime Kuma | heartbeats (same API as its web UI) | an Uptime Kuma login, plus the 2FA code if enabled |
| Icinga 2 | the Icinga DB database (MySQL/MariaDB or PostgreSQL) | a read-only database user |
| openITCockpit | the state history API | nothing extra (the API key of the source); set the API user's time zone to UTC |
| any source | a CSV file you upload | the file |

1. Open the source under **Monitoring** and click **Import history** in the
   **History import** box.
2. Choose the time range and, for Uptime Kuma and Icinga 2, enter the
   credentials. They are only used for this import and are not stored. If you
   import regularly, you can store them encrypted in the source instead
   (section **History import** of the source form).
3. Click **Load preview**. The server reads the history in the background; you
   can close the dialog and come back later.
4. Check the preview: per service you see how much time had no data, how much
   gets filled, the downtime and the uptime in the range before and after.
   Click **Import** to write it or **Discard** to drop it.

What you can rely on:

- **Only gaps are filled.** History the status page recorded itself is never
  changed. Typically only the time before go-live is filled.
- **Same rules as live.** The imported check states go through your current
  service links, mappings, aggregation and check bundles, and maintenance
  windows and incidents of that time count as well. Services with a manual
  status are left alone.
- **Repeating is safe.** Running the same import again changes nothing; a later
  import of the same period replaces the earlier imported data (for example
  after you imported a second source that feeds the same services). Imports
  are written one after the other, even when you confirm several at once.
- **Service statuses from a CSV file stay.** If you set a service's status
  directly in a CSV file (column `service`), later imports keep it. Only
  another CSV file with rows for that service changes it, and only for the
  times in its rows.
- **Uptime Kuma:** a monitor with very many heartbeats (more than about
  200 000 from the start of the range until today) is skipped and named in
  the preview. Choose a later start for it.
- Every import is recorded in the audit log.

For the CSV format and the details per system, see the
[adapter documentation](../../adapters/README.md#history-import).

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
- A source holds at most 20000 checks (`MAX_CHECKS_PER_SOURCE`). A push or poll
  that would add more is rejected and stores nothing.
- A poll answer may be up to 8 MiB with up to 500000 values
  (`POLL_MAX_RESPONSE_MB`, `POLL_MAX_VALUES`); a larger answer fails the poll.
  For very large monitoring systems raise both together with the heap cap
  (`NODE_OPTIONS`), see the configuration reference.

# Uptime Kuma

Both modes are supported and can be combined on one source:

- **Pull** from the Prometheus endpoint `/metrics`.
- **Push** with Uptime Kuma's native **Webhook** notification.

The external ID is the **monitor name** in both modes, so keep monitor names
unique (monitors with the same name overwrite each other). Renaming a monitor
creates a new check; the old one is removed by the next poll together with its
service links.

## Pull

1. In Uptime Kuma: **Settings → API Keys → Add API Key** (available in current
   Uptime Kuma releases). Give it a descriptive name and, if desired, an expiry date.
2. Create a monitoring source of type **Uptime Kuma**:

   | Field | Description |
   | --- | --- |
   | Base URL | e.g. `https://kuma.example.com` (the adapter requests `<base>/metrics`) |
   | API key | the key from step 1 |
   | Verify TLS | disable only for self-signed certificates in trusted networks |

The request uses HTTP Basic auth with an **empty user name and the API key as
password**, which is how Uptime Kuma authenticates `/metrics` with API keys.

From the Prometheus metrics the adapter reads `monitor_status` (and
`monitor_response_time` for the output):

| `monitor_status` | Meaning | Check state |
| --- | --- | --- |
| 1 | up | ok |
| 0 | down | critical |
| 2 | pending (retrying) | warning |
| 3 | maintenance | ok |

The host is taken from the `monitor_hostname` label or, for HTTP monitors, from
`monitor_url`. Only active monitors are exported by Uptime Kuma: **pausing a
monitor removes its check** (and its service links) on the next poll.

Maintenance is reported as `ok` on purpose: announce planned work as a
maintenance in OpenStatusPage so customers see a proper maintenance notice.

## Push (webhook notification)

1. Create a monitoring source of type **Uptime Kuma** (or **Webhook** for push
   only) and copy the ingest URL and token.
2. In Uptime Kuma: **Settings → Notifications → Setup Notification**:

   | Field | Value |
   | --- | --- |
   | Notification Type | Webhook |
   | Post URL | `https://status.example.com/api/ingest/<source-id>/uptimekuma?token=<token>` |
   | Request Body | `application/json` (Preset – application/json) |
   | Additional Headers | optional, see below |

3. Enable the notification for the monitors that feed the status page (or tick
   "Apply on all existing monitors"). Use **Test** to verify: test notifications
   are accepted with `200` and change nothing.

### Token: query parameter or header

The token can be passed in two ways:

- **Query parameter** `?token=<token>` in the Post URL (shown above). Works with
  every Uptime Kuma version. The URL then contains the token, so make sure
  reverse-proxy access logs in front of the status page are protected.
- **Header**: enable "Additional Headers" (available in newer versions) and enter

  ```json
  { "Authorization": "Bearer <token>" }
  ```

  and omit the query parameter.

### Payload

Uptime Kuma sends `{ heartbeat, monitor, msg }`. Used fields:

- `heartbeat.status` – 0 down, 1 up, 2 pending, 3 maintenance (mapped as above)
- `heartbeat.msg` – output, `heartbeat.time` – check time (UTC)
- `monitor.name` – external ID, `monitor.hostname` / `monitor.url` – host

Notifications without heartbeat (test notifications, certificate expiry
warnings) are accepted and ignored.

### Notes

- Uptime Kuma sends notifications only on **important** heartbeats (state
  changes). Combine push with pull (e.g. every 5 minutes) for reconciliation.
- Group monitors are exported like any other monitor.

## Several Uptime Kuma nodes (check bundles)

Running Uptime Kuma in more than one place (e.g. `kuma-fra.example.com` and
`kuma-ams.example.com`) avoids false alarms caused by the network of a single
monitoring node. Add each instance as its own source, then combine the
monitors that watch the same target into a **check bundle**
(**Admin → Monitoring → Bundles**): pick the monitor of each node, give every
node a number of votes and link the bundle to the service instead of the
individual monitors. The bundle is down only when more than half of the votes
of the reporting nodes say so; *pending* counts as a warning. A node whose
poll fails, or that has neither polled successfully nor delivered a result
within 3 poll intervals (at least 5 minutes), is left out of the vote. Details and examples:
[Check bundles](README.md#check-bundles).

Use pull for bundle members (optionally plus push): webhook notifications
arrive only on state changes, so a push-only source would look silent and drop
out of the vote after `BUNDLE_PUSH_STALE_SECONDS`.

## History import

Uptime Kuma keeps a heartbeat per check run. The history import reads them
through the Socket.IO API that the Uptime Kuma web UI uses (versions 1.23 and
2.x): it logs in, receives the monitor list and calls `getMonitorBeats` per
monitor. The API key cannot be used for this; a **login** is required. See
[README.md](README.md#history-import) for the procedure and the rules.

- **Credentials**: enter user name and password in the import dialog (used for
  this import only), or store them in the source (**History import** section of
  the source form, `historyUsername` / `historyPassword`, encrypted, masked in
  responses). Uptime Kuma has no read-only role, so the login has full access:
  prefer typing it into the dialog over storing it.
- **Two-factor authentication**: enter the current 6-digit code in the dialog.
  A code can only be used once, so start the import right after typing it.
  A stored login cannot be used for accounts with 2FA without a code.
- **Network**: the server talks to `<base URL>/socket.io/` with HTTP long
  polling (no WebSocket needed). A reverse proxy in front of Uptime Kuma must
  pass `/socket.io/` through, which it already does for the web UI.
- **Retention**: Uptime Kuma deletes heartbeats older than **Settings →
  Monitor History → Keep monitor history data** (default 180 days). The preview
  warns when the returned data starts later than the requested range.
- **Mapping**: monitors are matched by **name** (the external ID). Monitors
  sharing a name are skipped with a warning. Heartbeat states map like the live
  status (down → critical, pending → warning, up and maintenance → ok). A
  heartbeat counts until the next one, but at most three check intervals
  (minimum 10 minutes): a paused monitor leaves a gap instead of extending its
  last state.
- **Size limit**: `getMonitorBeats` returns all heartbeats of a monitor from
  the start of the range up to now in one response, and one response is
  limited to 50 MiB, which is roughly 200 000 heartbeats. One per minute is
  about 260 000 per half year, one every 20 seconds about 780 000. A monitor
  over the limit is skipped and named in a preview warning; the other monitors
  are still imported (the importer logs in again with the session token, so
  no new 2FA code is needed). For such monitors choose a range that starts
  later (the response always reaches up to now), or lower the retention in
  Uptime Kuma. Large imports take a while.
- **Time limit**: Uptime Kuma must answer each request (login,
  `getMonitorBeats`) within 5 minutes. A monitor whose heartbeats do not
  arrive in time is skipped with the same warning; a login that times out
  fails the import. Events the importer does not ask for (for example live
  heartbeats) are ignored instead of being kept in memory.

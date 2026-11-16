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

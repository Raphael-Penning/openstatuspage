# Icinga 2

Both modes are supported and can be combined on one source:

- **Pull** via the Icinga 2 REST API (port 5665).
- **Push** via a notification command ([contrib/icinga2](../../contrib/icinga2/)).

External IDs: `<host name>!<service name>` for services, `<host name>` for hosts
(object names, not display names).

## Pull

### API user

Create a dedicated API user with read-only query permissions, e.g. in
`/etc/icinga2/conf.d/api-users.conf`:

```
object ApiUser "openstatuspage" {
  password = "<long random password>"
  permissions = [ "objects/query/Host", "objects/query/Service" ]
}
```

The permissions can be narrowed with filters so the user only sees what feeds
the status page:

```
object ApiUser "openstatuspage" {
  password = "<long random password>"
  permissions = [
    { permission = "objects/query/Service", filter = {{ "statuspage" in service.groups }} },
    { permission = "objects/query/Host",    filter = {{ "statuspage" in host.groups }} },
  ]
}
```

Reload Icinga 2 afterwards (`icinga2 daemon -C && systemctl reload icinga2`).

### Source settings

| Field | Description |
| --- | --- |
| Base URL | e.g. `https://icinga.example.com:5665` (with or without `/v1`) |
| Username / password | the API user |
| Filter | optional Icinga 2 filter expression for services, e.g. `"statuspage" in service.groups` or `match("web*", host.name)` |
| Include hosts | also import host checks |
| Verify TLS | disable only for self-signed certificates in trusted networks; better: `NODE_EXTRA_CA_CERTS` with the Icinga CA (`/var/lib/icinga2/certs/ca.crt`) |
| Poll interval | seconds between polls (default 60) |

### What is requested

- `GET /v1/objects/services?attrs=...` with `Accept: application/json` and HTTP
  Basic auth. With a filter, the request is sent as
  `POST` + `X-HTTP-Method-Override: GET` with the JSON body `{ "filter": ..., "attrs": [...] }`.
- With "include hosts": `GET /v1/objects/hosts`. When a filter is configured,
  only the hosts of matching services are imported
  (`host.name in osp_hosts` with `filter_vars`), because the filter is a service
  expression.

Only these attributes are requested: `name`, `display_name`, `host_name`,
`state`, `last_hard_state`, `state_type`, `last_check`, `last_check_result`,
`downtime_depth`, `acknowledgement`.

### State mapping

| Icinga 2 | Check state |
| --- | --- |
| service 0 OK | ok |
| service 1 WARNING | warning |
| service 2 CRITICAL | critical |
| service 3 UNKNOWN | unknown |
| host 0 UP | ok |
| host 1 DOWN | critical |
| not checked yet (pending) | unknown |

- **Soft states** are ignored: the adapter reports `last_hard_state`, so a check
  that is still being re-tried does not flap the status page.
- **Downtimes and acknowledgements** do not change the reported state. Announce
  planned work as a maintenance in OpenStatusPage instead; the maintenance
  status takes precedence over check results for the affected services.
- The check output is `last_check_result.output` (admin UI only).

## Push

[`contrib/icinga2/openstatuspage-notify.sh`](../../contrib/icinga2/openstatuspage-notify.sh)
posts the notification to `POST /api/ingest/<source-id>/icinga2`. It needs
`sh` and `curl` on the Icinga 2 host (on every satellite that sends
notifications) and only outbound HTTPS to the status page.

1. Create a monitoring source of type **Icinga 2** (or **Webhook** for push only),
   copy the ingest URL and the token (shown once).
2. Install the script:

   ```bash
   install -m 755 openstatuspage-notify.sh /etc/icinga2/scripts/
   install -m 640 -g icinga openstatuspage-notify.env.example /etc/icinga2/openstatuspage-notify.env
   # edit OSP_URL and OSP_TOKEN (the group is `nagios` on Debian/Ubuntu)
   ```

3. Copy [`contrib/icinga2/openstatuspage.conf`](../../contrib/icinga2/openstatuspage.conf)
   to `/etc/icinga2/conf.d/`, adapt the `assign where` rules (the example uses
   `vars.statuspage = true` on hosts and services) and reload Icinga 2.

Test the script by hand:

```bash
OSP_DRY_RUN=1 OSP_HOST=web01 OSP_SERVICE=http OSP_STATE=CRITICAL \
  /etc/icinga2/scripts/openstatuspage-notify.sh          # prints the JSON payload

OSP_CONFIG=/etc/icinga2/openstatuspage-notify.env OSP_HOST=web01 OSP_SERVICE=http OSP_STATE=OK \
  /etc/icinga2/scripts/openstatuspage-notify.sh && echo sent
```

### Payload

```json
{
  "type": "service",
  "host": "web01.example.com",
  "hostDisplayName": "Web 01",
  "service": "https",
  "displayName": "HTTPS",
  "state": "CRITICAL",
  "stateId": "2",
  "output": "connection refused",
  "timestamp": "1767225600",
  "notificationType": "PROBLEM"
}
```

`stateId` is preferred over `state` when both are present. `host` and a state
are required; `service` is required for service notifications. An array of such
objects is accepted as well.

### Notes

- Icinga 2 only notifies on **hard** state changes, matching the pull mode.
- Problem notifications are suppressed while a check is in downtime. The
  example also enables the `DowntimeStart`/`DowntimeEnd` types, which report the
  current state when a downtime starts and ends.
- Set `interval` on the notification (example: 30 minutes) so problem states are
  re-sent periodically; this heals missed notifications. Combining push with a
  slower pull interval achieves the same with full reconciliation.

## History import

The Icinga 2 REST API has no history. The history import therefore reads the
**Icinga DB** database (the backend of Icinga DB Web), MySQL/MariaDB or
PostgreSQL. The IDO database is not supported. See
[README.md](README.md#history-import) for the procedure and the rules.

Tables read (nothing is written; the session is set to read-only):

| Table | Used for |
| --- | --- |
| `state_history` joined with `host` / `service` | state changes in the range (`event_time` in ms, `hard_state`) and the last change before the range |
| `host_state` / `service_state` | current hard state and `last_state_change`, for objects whose older history was removed by retention |

External IDs are built like the live adapter (`host!service`, `host`) from the
object names. Only **hard states** count; soft states (retries) are ignored.

Create a read-only database user that the status page server can reach:

```sql
-- MySQL / MariaDB
CREATE USER 'osp_history'@'status.example.com' IDENTIFIED BY '<long random password>';
GRANT SELECT ON icingadb.state_history TO 'osp_history'@'status.example.com';
GRANT SELECT ON icingadb.host TO 'osp_history'@'status.example.com';
GRANT SELECT ON icingadb.service TO 'osp_history'@'status.example.com';
GRANT SELECT ON icingadb.host_state TO 'osp_history'@'status.example.com';
GRANT SELECT ON icingadb.service_state TO 'osp_history'@'status.example.com';

-- PostgreSQL
CREATE ROLE osp_history LOGIN PASSWORD '<long random password>';
GRANT SELECT ON state_history, host, service, host_state, service_state TO osp_history;
```

Connection string (typed into the import dialog for one import, or stored
encrypted in the source as **Icinga DB connection string**, `icingaDbUrl`):

```
mysql://osp_history:<password>@db.example.com:3306/icingadb
postgres://osp_history:<password>@db.example.com:5432/icingadb?sslmode=require
```

`mariadb://` is accepted as an alias of `mysql://`. For TLS with MySQL/MariaDB
append `?ssl={"rejectUnauthorized":true}`. Special characters in the password
must be URL encoded.

The connection string must name a host (no Unix socket) and may carry only
one parameter: `sslmode` for PostgreSQL (`disable`, `prefer`, `require`,
`verify-ca`, `verify-full`, `no-verify`) or `ssl` for MySQL/MariaDB. Other
parameters are rejected, because the database drivers read them as
connection options, some of them file paths on the status page server
(`sslcert`, `sslkey`, `sslrootcert`) or local sockets (`host`,
`socketPath`). `verify-ca` and `verify-full` check the server certificate
against the CA certificates Node.js trusts on the status page server.

- **Retention**: Icinga DB removes history after `retention.history-days`
  (per category `retention.options.state`) of its configuration. For objects
  whose state did not change since before the range, the current state fills
  the range even when older history is gone.
- **Several environments** in one Icinga DB: objects are matched by name only;
  use unique host names across environments.
- The range is queried in windows of 7 days. Every query reads at most
  50 000 rows: a window with more state changes (of all objects, not only the
  imported ones) is split in halves until each part fits. If one minute
  still holds more, or the import would keep more than 500 000 state changes
  of the imported checks, the import fails; import a shorter range or fewer
  checks.

# openITCockpit

> **Status: implemented against the public openITCockpit API documentation and
> example responses. It has not yet been verified against a real installation.**
> Please test with "Test connection" first and report differences (with
> anonymized responses) so the mapper can be adjusted.

Both modes are supported and can be combined on one source:

- **Pull** via the openITCockpit JSON API.
- **Push** via a Nagios-style notification command
  ([contrib/openitcockpit](../../contrib/openitcockpit/)).

## External IDs

openITCockpit writes the object **UUIDs** as `host_name` and
`service_description` into the monitoring core (Naemon). The notification
macros `$HOSTNAME$` and `$SERVICEDESC$` therefore resolve to UUIDs, and the
adapter uses UUIDs in pull mode as well:

- services: `<host uuid>!<service uuid>`
- hosts: `<host uuid>`

Names are stored as display name and host for the admin UI. If a response lacks
UUIDs, the numeric IDs are used instead (pull and push IDs then no longer match;
use only one mode in that case).

## Pull

1. In openITCockpit: **user menu → Edit profile → API keys → Create new API
   key**. Use a dedicated user with read-only permissions for hosts and
   services, limited to the containers that feed the status page.
2. Create a monitoring source of type **openITCockpit**:

   | Field | Description |
   | --- | --- |
   | Base URL | e.g. `https://oitc.example.com` |
   | API key | the key from step 1 |
   | Include hosts | also import host checks |
   | Verify TLS | disable only for self-signed certificates in trusted networks |

### Requests

All requests send `Authorization: X-OITC-API <api key>` and `Accept: application/json`:

- `GET <base>/services/index.json?angular=true&page=<n>`
- `GET <base>/hosts/index.json?angular=true&page=<n>` (with "include hosts")

Pagination: the next page is requested while the response says so
(`scroll.hasNextPage`, `paging.nextPage`, or `paging.page < paging.pageCount`).
The adapter stops on an empty page, when a page adds no new objects (server
ignores the page parameter) and after at most 500 pages per object type.

A redirect (e.g. to `/users/login`) is reported as an error; it usually means
an invalid API key or a wrong base URL.

### Assumptions about the response format

Response shapes differ between openITCockpit versions. The mapper is
deliberately defensive:

| Value | Fields tried, in order |
| --- | --- |
| result list | `all_services` / `all_hosts`, `services` / `hosts`, `data`, `results`, then the first array of objects |
| service ID | `Service.uuid`, `Service.id` |
| service name | `Service.servicename`, `Service.name`, `Service.service_name` |
| host ID | `Host.uuid`, `Host.id`, `Service.host_uuid`, `Service.host_id` |
| host name | `Host.name`, `Host.hostname`, `Service.hostname`, `Service.host_name` |
| state | `Servicestatus.currentState` / `Hoststatus.currentState`, `current_state`, `state` |
| output | `…status.output`, `…status.outputHtml` |
| check time | only machine-readable values (unix time or ISO-8601) of `lastCheckUnix`, `last_check`, `lastCheck`; user-formatted dates are ignored |

Lower-case keys (`service`, `host`, `servicestatus`, …) are accepted as well.
Entries without status (not yet in monitoring) are imported as `unknown`.

### State mapping

| openITCockpit / Naemon | Check state |
| --- | --- |
| service 0 OK | ok |
| service 1 WARNING | warning |
| service 2 CRITICAL | critical |
| service 3 UNKNOWN | unknown |
| host 0 UP | ok |
| host 1 DOWN | critical |
| host 2 UNREACHABLE | critical |

The current state is reported (the index API does not expose the last hard
state). Downtimes and acknowledgements do not change the state; use
maintenance windows in OpenStatusPage instead.

## Push

[`contrib/openitcockpit/openstatuspage-notify.sh`](../../contrib/openitcockpit/openstatuspage-notify.sh)
posts to `POST /api/ingest/<source-id>/openitcockpit`. It needs `sh` and `curl`
on the openITCockpit server (and on satellites that send notifications).

1. Create a monitoring source of type **openITCockpit** (or **Webhook** for push
   only) and copy the ingest URL and token.
2. Install the script and the credentials file:

   ```bash
   install -m 755 openstatuspage-notify.sh /opt/openitc/nagios/libexec/openstatuspage-notify.sh
   install -m 640 -g nagios openstatuspage-notify.env.example /etc/openitcockpit/openstatuspage-notify.env
   # edit OSP_URL and OSP_TOKEN
   ```

   Paths and the group differ between installations; any location readable by
   the monitoring user works.

3. In openITCockpit create two commands (**Objects → Commands**, type
   *Notification command*):

   **openstatuspage-service**
   ```
   /opt/openitc/nagios/libexec/openstatuspage-notify.sh -c /etc/openitcockpit/openstatuspage-notify.env -t service -H "$HOSTNAME$" -N "$HOSTDISPLAYNAME$" -S "$SERVICEDESC$" -D "$SERVICEDISPLAYNAME$" -s "$SERVICESTATEID$" -o "$SERVICEOUTPUT$" -T "$TIMET$"
   ```

   **openstatuspage-host**
   ```
   /opt/openitc/nagios/libexec/openstatuspage-notify.sh -c /etc/openitcockpit/openstatuspage-notify.env -t host -H "$HOSTNAME$" -N "$HOSTDISPLAYNAME$" -s "$HOSTSTATEID$" -o "$HOSTOUTPUT$" -T "$TIMET$"
   ```

4. Create a contact (e.g. "OpenStatusPage") that uses these commands as host
   and service notification commands, with all states enabled (including
   recovery), and add it to the hosts/services or contact groups that feed the
   status page. Export the configuration (**Refresh monitoring configuration**).

Test by hand on the openITCockpit server:

```bash
/opt/openitc/nagios/libexec/openstatuspage-notify.sh -n -t service -H host-uuid -S service-uuid -s 2 -o "test"
```

`-n` prints the payload instead of sending it; `-k` skips TLS verification;
`-h` shows all options.

### Payload

```json
{
  "type": "service",
  "host": "a7d1c3e2-5b4f-4e6a-8c9d-aaaaaaaaaaaa",
  "hostDisplayName": "web01.example.com",
  "service": "6b1f7a8e-0c2d-4f3a-9e1b-111111111111",
  "serviceDisplayName": "HTTPS",
  "stateId": "2",
  "output": "connection refused",
  "timestamp": "1767225600"
}
```

`host` and `stateId` are required, `service` for service notifications.
Unresolved macros (e.g. a literal `$SERVICEDISPLAYNAME$`) are ignored. An array
of such objects is accepted as well.

### Notes

- Naemon removes characters listed in `illegal_macro_output_chars` from
  `$SERVICEOUTPUT$`/`$HOSTOUTPUT$` before running the command; keep quotes in
  that list so the output cannot break the shell quoting of the command line.
- Naemon only notifies on hard state changes; configure a re-notification
  interval or combine push with pull for reconciliation.

## History import

The history import reads the state history through the API, with the API key
of the source (like the pull mode, not yet verified against a real
installation). See [README.md](README.md#history-import) for the procedure and
the rules.

Requests, besides the paginated `services/index.json` / `hosts/index.json`
that map UUIDs to numeric IDs and provide the current state:

- `GET <base>/statehistories/service/<id>.json?angular=true&filter[from]=…&filter[to]=…&filter[StatehistoryServices.state_type]=1&sort=StatehistoryServices.state_time&direction=asc&page=<n>`
- `GET <base>/statehistories/host/<id>.json?…` with `StatehistoryHosts.*` for host checks

The API user needs permission to view the state history of the hosts and
services it can see.

- **Time zone**: openITCockpit formats `state_time` with the date format and
  **time zone of the API user**. Unix timestamps and ISO 8601 with offset are
  used as they are; `Y-m-d H:i:s`, `d.m.Y H:i:s`, `m/d/Y H:i:s` and
  `H:i:s - d.m.Y` are read as **UTC**. Set the time zone of the API user to UTC
  in its profile before importing.
- Only hard states count (`state_type` filter, and `is_hardstate` when present).
- The state before the first event in the range comes from the last change in
  the 30 days before it, otherwise from the current status when its last hard
  state change lies before the range.
- **Retention**: openITCockpit deletes old state history according to its
  cleanup settings; older periods stay empty.
- One request per check and page: keep "Only checks used by services or
  bundles" enabled for large installations.
- An import keeps at most 500 000 state changes (all checks together); with
  more, it fails. Import a shorter range or fewer checks.

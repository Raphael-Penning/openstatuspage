# contrib

Integration helpers for monitoring systems that push results to OpenStatusPage.
They only need **outbound HTTPS from the monitoring host to the status page**.

| Directory | Contents | Documentation |
| --- | --- | --- |
| [`icinga2/`](icinga2/) | Notification script, `NotificationCommand` / `Notification` apply rule example, env file example | [docs/adapters/icinga2.md](../docs/adapters/icinga2.md) |
| [`openitcockpit/`](openitcockpit/) | Nagios-style notification command (also works with Naemon/Nagios), env file example | [docs/adapters/openitcockpit.md](../docs/adapters/openitcockpit.md) |

Uptime Kuma needs no script: it has a native webhook notification
(see [docs/adapters/uptime-kuma.md](../docs/adapters/uptime-kuma.md)).

The scripts only depend on POSIX `sh`, `curl`, `sed`, `awk` and `tr`. They pass
the ingest token to curl via stdin so it never appears in the process list,
and support a dry-run mode that prints the JSON payload instead of sending it.

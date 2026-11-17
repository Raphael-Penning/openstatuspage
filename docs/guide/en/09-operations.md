# Operations

This page covers backups, upgrades, health checks, logs and the handling of
`SECRET_KEY`. The commands assume the Docker Compose setup from
[Installation](02-installation.md); adapt service and volume names to your
deployment.

## Backup and restore

### What to back up

1. **The database**: PostgreSQL database or SQLite file. It contains
   everything: services, incidents, history, users, settings, subscribers.
2. **`SECRET_KEY`** (and the rest of your environment file). Without the same
   key, a restored database cannot decrypt the stored monitoring credentials.
   Keep it separate from the database backup, e.g. in your password manager.
3. Your own changes to the compose file or proxy configuration.

Back up at least daily and before every upgrade, keep several generations,
store copies outside the host, and test a restore now and then.

### PostgreSQL

Backup (custom format, compressed):

```bash
docker compose -f docker/docker-compose.yml exec -T db \
  pg_dump -U openstatuspage -Fc openstatuspage > openstatuspage-$(date +%F).dump
```

Restore:

```bash
docker compose -f docker/docker-compose.yml stop openstatuspage
docker compose -f docker/docker-compose.yml exec -T db \
  pg_restore -U openstatuspage -d openstatuspage --clean --if-exists < openstatuspage-2026-01-31.dump
docker compose -f docker/docker-compose.yml start openstatuspage
```

For an external PostgreSQL server use `pg_dump` / `pg_restore` with the
credentials from `DATABASE_URL` the same way.

### SQLite

SQLite runs in WAL mode: the database consists of `openstatuspage.db` plus the
files `-wal` and `-shm` next to it. Do not just copy the `.db` file of a
running instance; use one of these methods.

**Online backup** with the SQLite backup API (consistent while the app is
running). In the Docker image:

```bash
docker exec -w /app/server openstatuspage node -e "
  const db = require('better-sqlite3')('/data/openstatuspage.db', { readonly: true });
  db.backup('/data/backup.db').then(() => { db.close(); console.log('backup written'); });
"
docker cp openstatuspage:/data/backup.db ./openstatuspage-$(date +%F).db
docker exec openstatuspage rm /data/backup.db
```

Replace `openstatuspage` with the container name (`docker ps` shows it; with
Compose use `docker compose -f docker/docker-compose.yml exec -w /app/server openstatuspage ...`).
On a host with the `sqlite3` command line tool you can use
`sqlite3 /var/lib/openstatuspage/openstatuspage.db ".backup '/backup/openstatuspage.db'"`
instead.

**Offline backup**: stop the app, copy the whole volume, start again:

```bash
docker stop openstatuspage
docker run --rm -v openstatuspage-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/openstatuspage-data-$(date +%F).tar.gz -C /data .
docker start openstatuspage
```

**Restore**: stop the app, replace the database file and remove stale `-wal`
and `-shm` files, start the app:

```bash
docker stop openstatuspage
docker run --rm -v openstatuspage-data:/data -v "$PWD":/backup alpine sh -c \
  "rm -f /data/openstatuspage.db-wal /data/openstatuspage.db-shm && \
   cp /backup/openstatuspage-2026-01-31.db /data/openstatuspage.db && \
   chown 1000:1000 /data/openstatuspage.db"
docker start openstatuspage
```

The app runs as user `node` (UID 1000) in the container and needs write access
to the file. Named volumes created by Compose are prefixed with the project
name (e.g. `docker_data`); `docker volume ls` shows the exact name.

## Upgrades

1. Read the release notes for breaking changes.
2. Make a backup (see above).
3. Update the code and rebuild:

   ```bash
   git pull
   docker compose -f docker/docker-compose.yml up -d --build
   ```

   From source: `git pull && pnpm install --frozen-lockfile && pnpm build`,
   then restart the service.
4. Database migrations run **automatically** on start. Watch the log for
   errors and check `/api/health`.

Migrations only go forward; an older version cannot run on a database that a
newer version has migrated. To roll back an upgrade, check out the previous
version **and** restore the backup made before the upgrade. Changes made
since then are lost, so decide quickly.

`pnpm db:migrate` (from source) applies migrations without starting the
server, e.g. to test an upgrade on a copy of the database.

## Health check

`GET /api/health` returns `200 {"status":"ok"}` when the app runs and the
database answers, otherwise an error status. It needs no authentication.

- The Docker image has a built-in `HEALTHCHECK` that uses it every 30 seconds.
- Use it for load balancer health checks and container orchestration.

## Monitoring the status page

A status page is most needed when your infrastructure has problems, so monitor
it **from outside** that infrastructure: an external monitoring service or a
monitoring instance in a different network or at a different provider.
Monitoring it only with the same Icinga or Uptime Kuma that feeds it tells you
nothing when the shared network is down.

Recommended checks:

- `https://status.example.com/api/health`: HTTP 200 (app and database).
- `https://status.example.com/`: HTTP 200 (the page as customers see it,
  including proxy and certificate).
- The expiry date of the TLS certificate.
- For push integrations: the source list in the management UI shows when
  data last arrived. A source that stays silent usually means a broken
  notification script or firewall rule.
- With email subscriptions: the failed count in the email status panel.

Also make sure the status page does not depend on the infrastructure it
reports on (same host, same database cluster, same DNS) more than necessary.

## Logs

The app writes structured JSON logs (one object per line) to stdout; with
`NODE_ENV=development` they are formatted for humans.

```bash
docker compose -f docker/docker-compose.yml logs -f openstatuspage
journalctl -u openstatuspage -f      # systemd
```

`LOG_LEVEL` (default `info`) selects the detail: `fatal`, `error`, `warn`,
`info`, `debug`, `trace` or `silent`. `debug` helps with monitoring adapters
and OIDC problems; switch back afterwards. `Authorization` and `Cookie`
headers are never logged, and request logs of routes that carry tokens in the
URL (ingest, email links) are only written at `warn` level and above.

## Running several instances

One instance is enough for most setups. If you run several instances (e.g.
for high availability):

- Use **PostgreSQL**. SQLite cannot be shared between instances.
- Set `WORKER_ENABLED=false` on all but **one** instance. The worker runs
  monitoring polls, automatic maintenance start/completion, email delivery,
  reminders and clean-up jobs; running it on several instances would do the
  work twice.
- Use the same `SECRET_KEY` and `BASE_URL` on all instances.
- Rate limits are counted per instance.

If the worker instance is down, the page and the management UI keep working,
but polls, automatic maintenance transitions and emails pause until it is
back.

## SECRET_KEY

`SECRET_KEY` (at least 32 characters, generate it with
`openssl rand -base64 48`) is used to:

- encrypt the credentials of monitoring sources (AES-256-GCM),
- sign the short-lived login state cookie of single sign-on,
- derive the tokens in the confirmation, manage and unsubscribe links of
  subscriber emails.

Never commit it, keep it out of screenshots and tickets, and back it up
separately from the database.

**Changing it** has these consequences:

- Stored monitoring credentials can no longer be decrypted: re-enter the
  password or API key of every pull source.
- Links in emails sent before the change stop working (confirmation, manage,
  unsubscribe). Subscribers can subscribe again with the same address to
  receive a new manage link.
- Single sign-on logins that are in progress at that moment fail and have to
  be started again.

Not affected: login sessions, user passwords, API tokens and ingest tokens
(they are stored as hashes, independent of the key).

So change it only when it may have leaked, and then deliberately: set the new
key, restart, re-enter the monitoring credentials.

## Automatic clean-up

The worker removes on its own:

- expired login sessions (hourly),
- unconfirmed email subscriptions after 7 days,
- sent and failed emails from the queue after 30 days.

Incidents, maintenance, the status history and the audit log are kept.

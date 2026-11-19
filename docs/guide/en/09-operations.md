# Operations

This page covers backups, upgrades, health checks, logs and the handling of
`SECRET_KEY`. The commands assume the
[Docker Compose](02-installation.md#docker-compose) setup and run in the
directory with `compose.yaml` and `.env`; adapt service and volume names to
your deployment. If you use override files (e.g. for Caddy), add their `-f`
options to every command or set `COMPOSE_FILE` in `.env`.

## Backup and restore

### What to back up

1. **The database**: PostgreSQL database or SQLite file. It contains
   everything: services, incidents, history, users, settings, subscribers.
2. **`SECRET_KEY`** (and the rest of your `.env`). Without the same
   key, a restored database cannot decrypt the stored monitoring credentials.
   Keep it separate from the database backup, e.g. in your password manager.
3. Your own override files and proxy configuration.

Back up at least daily and before every upgrade, keep several generations,
store copies outside the host, and test a restore now and then.

### PostgreSQL

Backup (custom format, compressed):

```bash
docker compose exec -T db \
  pg_dump -U openstatuspage -Fc openstatuspage > openstatuspage-$(date +%F).dump
```

Restore:

```bash
docker compose stop openstatuspage
docker compose exec -T db \
  pg_restore -U openstatuspage -d openstatuspage --clean --if-exists < openstatuspage-2026-01-31.dump
docker compose start openstatuspage
```

For an external PostgreSQL server (and on Kubernetes) use `pg_dump` /
`pg_restore` with the credentials from `DATABASE_URL` the same way. Before a
restore, stop the app with
`kubectl -n openstatuspage scale deployment/openstatuspage --replicas=0` and
start it again afterwards with `--replicas=1`.

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
Compose use `docker compose exec -w /app/server openstatuspage ...`).
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
name (`openstatuspage_data` with `compose.yaml`); `docker volume ls` shows
the exact name.

## Upgrades

Every upgrade follows the same steps:

1. Read the release notes for breaking changes, also those of the versions
   you skip.
2. Make a backup (see above).
3. Switch to the new version (see below).
4. Database migrations run **automatically** on start. Watch the log for
   errors and check `/api/health`.

### Docker Compose

Set the new release in `.env`, pull the image and recreate the container:

```bash
# .env
OSP_VERSION=1.3.0
```

```bash
docker compose pull
docker compose up -d
```

`OSP_VERSION` in `.env` decides the version; the default in `compose.yaml`
only applies when the line is missing. If you follow a moving tag (`1.3`,
`latest`), `pull` and `up -d` alone fetch and start the newest image of that
tag.

When the release notes mention changes to `compose.yaml`, also replace it
with the file of the new release; your settings stay untouched in `.env`:

```bash
curl -fsSLO https://github.com/Raphael-Penning/openstatuspage/releases/download/v1.3.0/compose.yaml
```

New options are listed in the `env.example` of the release; add the ones you
need to `.env`. In a clone of the repository `git pull` updates
`deploy/compose/` instead.

`docker image prune` removes old images afterwards.

### Moving from the 0.1.0 compose file

Release 0.1.0 shipped `docker/docker-compose.yml`, used with `deploy.env` and
`--env-file`. That project was named after its directory (`docker`), so its
volumes are `docker_data` and `docker_pg`. The new `compose.yaml` uses the
project name `openstatuspage` and would start with an empty database. To keep
your data:

1. Make a backup (see above) and stop the old stack with its old command:
   `docker compose --env-file deploy.env -f docker/docker-compose.yml down`
   (without `-v`).
2. Download `compose.yaml` as in [Installation](02-installation.md#install)
   and use your `deploy.env` as `.env` (same `SECRET_KEY` and
   `POSTGRES_PASSWORD`). Settings from your own override files, such as
   `TRUST_PROXY`, now go into `.env` as well.
3. Keep the old project name: add `COMPOSE_PROJECT_NAME=docker` to `.env`
   (or pass `-p docker` to every command), then run `docker compose up -d`.

Alternatively start the new stack under its own name and move the database
with `pg_dump` and `pg_restore` as described in
[Backup and restore](#backup-and-restore).

### Single container

```bash
docker pull ghcr.io/raphael-penning/openstatuspage:1.3.0
docker rm -f openstatuspage
docker run -d --name openstatuspage ... ghcr.io/raphael-penning/openstatuspage:1.3.0
```

Use the same options as for the installation; the data stays in the volume.

### Kubernetes

Change `newTag` in `kustomization.yaml`, apply and wait for the rollout:

```bash
kubectl apply -k deploy/kubernetes
kubectl -n openstatuspage rollout status deployment/openstatuspage
```

The `Recreate` strategy stops the old pod before the new one starts, so the
migrations never run while the old version is still active.

### Building yourself and from source

With the build override, in `deploy/compose` of your clone:

```bash
git pull
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

From source: `git pull && pnpm install --frozen-lockfile && pnpm build`, then
restart the service. `pnpm db:migrate` applies migrations without starting
the server, e.g. to test an upgrade on a copy of the database.

### Rolling back

Migrations only go forward; an older version cannot run on a database that a
newer version has migrated. To roll back an upgrade:

1. Stop the app.
2. Restore the backup made before the upgrade.
3. Start the **previous** version again: the old `OSP_VERSION` in
   `.env`, the old `newTag` in `kustomization.yaml`, or the previous
   Git tag when you build yourself.

Changes made since the upgrade are lost, so decide quickly.

## Health check

`GET /api/health` returns `200 {"status":"ok"}` when the app runs and the
database answers, otherwise an error status. It needs no authentication.

- The Docker image has a built-in `HEALTHCHECK` that uses it every 30 seconds.
- The Kubernetes example uses it for the readiness and liveness probes.
- Use it for load balancer health checks and container orchestration.

## Memory

An instance needs about 80–100 MB of memory in normal use; a password check or
the first poll of a process briefly adds 10–20 MB. A memory limit of 128 MB per
container leaves enough room. The Docker image sets the Node.js and allocator
options for this (`NODE_OPTIONS`, `MALLOC_ARENA_MAX`, `UV_THREADPOOL_SIZE`).
Without the image, set them yourself:

```sh
NODE_OPTIONS="--max-semi-space-size=1 --max-old-space-size=96" \
MALLOC_ARENA_MAX=2 UV_THREADPOOL_SIZE=2 node apps/server/dist/index.js
```

Raise `--max-old-space-size` (e.g. to `256`) on the instance that runs a large
history import. Measurements per role: [architecture.md](../../architecture.md#memory).

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
- With email subscriptions: the failed count under **Queue** in the
  **Email delivery** panel on the settings page.

Also make sure the status page does not depend on the infrastructure it
reports on (same host, same database cluster, same DNS) more than necessary.

## Logs

The app writes structured JSON logs (one object per line) to stdout; with
`NODE_ENV=development` they are formatted for humans.

```bash
docker compose logs -f openstatuspage                         # Docker Compose
kubectl -n openstatuspage logs -f deployment/openstatuspage   # Kubernetes
journalctl -u openstatuspage -f                               # systemd
```

`LOG_LEVEL` (default `info`) selects the detail: `fatal`, `error`, `warn`,
`info`, `debug`, `trace` or `silent`. `debug` helps with monitoring adapters
and OIDC problems; switch back afterwards. `Authorization` and `Cookie`
headers are never logged, and request logs of routes that carry tokens in the
URL (ingest, email links) are only written at `warn` level and above.

## Running several instances

One instance is enough for most setups. If you run several instances (e.g.
for high availability, or the [split deployment](../../configuration.md#split-deployment)
with separate public, admin and worker instances):

- Use **PostgreSQL**. SQLite cannot be shared between instances.
- Background work may run on several instances. Monitoring polls, automatic
  maintenance start/completion, email delivery, reminders and clean-up jobs
  are coordinated through the database: each task runs on one instance at a
  time and once per interval, each source is polled once per interval, and
  each email is sent once. If a worker instance stops, another one takes over
  its tasks within about a minute.
- Use the same `SECRET_KEY` and `BASE_URL` on all instances. Logins work on
  every instance (sessions are stored in the database).
- Rate limits are counted per instance: with three instances behind a load
  balancer a client can try to log in up to three times as often. If that
  matters to you, let the proxy send each client to the same instance (sticky
  sessions by client IP) or limit requests at the proxy.
- After an update, start the new version on one instance first; it migrates
  the database. Instances may start at the same time: only one of them
  migrates.

If every instance with background tasks is down, the page and the management
UI keep working, but polls, automatic maintenance transitions and emails pause
until one is back.

With **Kubernetes** you can raise `replicas` of the example deployment once it
uses PostgreSQL. The pods then need no `/data` volume, and the example volume is
`ReadWriteOnce` (mountable on one node only): remove the `data` volume and its
mount from `deployment.yaml` and `pvc.yaml` from `kustomization.yaml`.

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
- unconfirmed email subscriptions 7 days after the last confirmation email
  (hourly),
- sent and failed emails from the queue after 30 days (hourly).

Incidents, maintenance, the status history and the audit log are kept.

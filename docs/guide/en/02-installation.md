# Installation and deployment

OpenStatusPage runs as a single Node.js process that serves the API, the
public page and the management UI. Every release is published as a container
image for `linux/amd64` and `linux/arm64`:

```text
ghcr.io/raphael-penning/openstatuspage
```

Choose one of these ways to run it:

| Option | Database | Good for |
| --- | --- | --- |
| [Docker Compose](#docker-compose) | PostgreSQL 17 container | most production setups |
| [Split deployment](#split-deployment) | PostgreSQL 17 container | public and admin on separate domains, worker in its own container |
| [Single container with SQLite](#single-container-with-sqlite) | SQLite file in a volume | small setups, one instance |
| [Kubernetes](#kubernetes) | external PostgreSQL (or SQLite on a volume) | clusters with an ingress controller |
| [Building the image yourself](#building-the-image-yourself) | as with Compose | own changes, other platforms |
| [From source](#from-source) | SQLite or PostgreSQL | hosts without Docker, development |

## Minimal configuration

Every installation needs at least these environment variables:

| Variable | Example | Why |
| --- | --- | --- |
| `SECRET_KEY` | output of `openssl rand -base64 48` | Encrypts monitoring credentials and signs data. At least 32 characters, required in production. **Back it up**, see [Operations](09-operations.md#secret_key). |
| `BASE_URL` | `https://status.example.com` | The public URL, used for links in feeds and emails, the OIDC redirect URI and the ingest URLs shown in the UI. No trailing slash. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | `admin@example.com`, at least 10 characters | Creates the first administrator, only when the database has no user yet. |

`DATABASE_URL` defaults to an SQLite file; set it for PostgreSQL. All other
options are described in [Configuration](04-configuration.md).

## Docker Compose

The recommended setup is a directory with two files that runs the app and a
PostgreSQL 17 database. Both files are attached to every
[release](https://github.com/Raphael-Penning/openstatuspage/releases):

| File | Content |
| --- | --- |
| `compose.yaml` | The services `openstatuspage` (the prebuilt image) and `db` (PostgreSQL 17, not published on the host). You do not need to edit it. |
| `.env` | Your settings and secrets, created from the template `env.example`. Every variable in it reaches the app. |

No reverse proxy is included: the app publishes plain HTTP on port 3000, and
you put your own proxy with HTTPS in front of it, see
[Reverse proxy](03-reverse-proxy.md).

### Install

You need Docker with the Compose plugin (`docker compose version` shows it).
On the host run:

```bash
mkdir openstatuspage && cd openstatuspage
curl -fsSLO https://github.com/Raphael-Penning/openstatuspage/releases/latest/download/compose.yaml
curl -fsSL -o .env https://github.com/Raphael-Penning/openstatuspage/releases/latest/download/env.example
printf 'SECRET_KEY=%s\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -base64 48)" "$(openssl rand -hex 16)" >> .env
chmod 600 .env
# edit .env: BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD (and HOST_PORT / TRUST_PROXY for your proxy)
docker compose up -d
```

What the steps do:

1. The new directory holds your installation; its name does not matter. The
   compose file sets the project name `openstatuspage`, so the volumes are
   always called `openstatuspage_data` and `openstatuspage_pg`.
2. The two downloads come from the newest stable release. Its `compose.yaml`
   and `env.example` are pinned to that release (`OSP_VERSION=1.2.3`), so
   the installation does not change version on its own.
3. `printf` appends two random secrets to `.env`: `SECRET_KEY` and the
   database password `POSTGRES_PASSWORD`. Run it only once and **keep a
   copy of both values**, see [SECRET_KEY](09-operations.md#secret_key).
4. `chmod 600` makes `.env` readable only for you.
5. After editing `.env` (see below), `docker compose up -d` pulls the images,
   starts the database, waits until it is ready and starts the app. Database
   migrations run automatically.

### Settings in .env

The template is grouped and commented. Set at least:

```bash
BASE_URL=https://status.example.com
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=a-long-password
```

| Variable | Meaning |
| --- | --- |
| `BASE_URL` | The public URL, as described [above](#minimal-configuration). |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The [first administrator](#the-first-administrator), created only while the database has no user. |
| `HOST_PORT` | Port published on the host, default `3000`, see [HOST_PORT](#host_port). |
| `TRUST_PROXY` | Number of reverse proxies in front of the app, `1` in the template. Leave it empty when no proxy is used, see [TRUST_PROXY](03-reverse-proxy.md#trust_proxy). |
| `OSP_VERSION` | [Image tag](#image-tags) to run. Pin a release. |
| `OSP_IMAGE` | Image without tag, default `ghcr.io/raphael-penning/openstatuspage`. Change it for a fork or your own registry mirror. |
| `SECRET_KEY`, `POSTGRES_PASSWORD` | Generated by the install command. Do not change them later: a new `SECRET_KEY` makes stored monitoring credentials unreadable, and `POSTGRES_PASSWORD` is only applied when the database is created. |

Every other option from [Configuration](04-configuration.md), for example
the [mail server](07-email-subscriptions.md#mail-server), single sign-on or
`LOG_LEVEL`, goes into `.env` as well: `compose.yaml` passes the whole file
to the app. Only `DATABASE_URL` is set by `compose.yaml` itself (it points to
the `db` service) and wins over a value in `.env`.

Notes on the file format:

- One `NAME=value` per line, `#` starts a comment. Empty values (`LOG_LEVEL=`)
  count as unset.
- Compose interprets `$` in values. Avoid it, or wrap the whole value in
  single quotes: `SMTP_PASSWORD='pa$$word'`.
- After a change run `docker compose up -d`: Compose recreates the container
  with the new settings. `docker compose restart` does **not** read `.env`
  again.

Git ignores `.env` files and they are not part of the Docker build context,
so the file ends up neither in a commit nor in an image.

### HOST_PORT

The app listens on port 3000 inside the container. `HOST_PORT` (default
`3000`) selects the port published on the host:

- `HOST_PORT=8080` publishes port 8080 on all interfaces.
- `HOST_PORT=127.0.0.1:3000` publishes it on localhost only. Use this when a
  reverse proxy on the same host terminates HTTPS, so the plain HTTP port is
  not reachable from outside.

### Check the installation

```bash
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
```

`ps` shows the app as `healthy` after a few seconds, and the health endpoint
returns `{"status":"ok"}`. Then open your `BASE_URL` with `/admin` once the
proxy is set up, and log in. With an `https://` `BASE_URL` the login cookie
is Secure, so logging in over plain `http://<host>:3000` fails; to log in
before the proxy is ready, use `http://localhost:3000` on the host itself
(e.g. through `ssh -L 3000:127.0.0.1:3000 <host>`). If Compose stops with
"set SECRET_KEY in .env", see
[Troubleshooting](10-troubleshooting.md#start-up). For HTTPS continue with
the [reverse proxy](03-reverse-proxy.md).

### Everyday commands

Run all commands in the directory with `compose.yaml` and `.env`; Compose
finds both files there, no further options are needed:

```bash
docker compose ps                              # state of the services
docker compose logs -f openstatuspage          # follow the app log
docker compose pull && docker compose up -d    # new images, apply .env changes
docker compose exec openstatuspage node server/dist/cli/create-user.js ...
docker compose down                            # stop and remove the containers
```

`down` keeps the volumes. Never add `-v` unless you want to delete the
database. Backups and upgrades are described in [Operations](09-operations.md).

A second instance on the same host needs its own directory, its own
`HOST_PORT` and its own project name: start it with
`docker compose -p openstatuspage2 up -d` and pass `-p openstatuspage2` to
every command, or put `COMPOSE_PROJECT_NAME=openstatuspage2` into its `.env`.

### From a clone of the repository

The same files are in the repository under `deploy/compose/`, with the
template named `.env.example`:

```bash
git clone https://github.com/Raphael-Penning/openstatuspage.git
cd openstatuspage/deploy/compose
cp .env.example .env
printf 'SECRET_KEY=%s\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -base64 48)" "$(openssl rand -hex 16)" >> .env
chmod 600 .env
# edit .env as above
docker compose up -d
```

These files follow the `main` branch and default to `OSP_VERSION=latest`;
pin a release in `.env`. Run all commands in `deploy/compose`.

### Optional demo data

To look around with fictional data, fill an **empty** database once:

```bash
docker compose exec openstatuspage node server/dist/cli/seed.js
```

The seed refuses to run when services already exist. Do not use it on a
production instance.

## Image tags

| Tag | Contains | Use it for |
| --- | --- | --- |
| `1.2.3` | exactly this release | production (recommended) |
| `1.2` | the newest patch release of 1.2 | bug fixes without new features |
| `1` | the newest release of major version 1 (not for 0.x versions) | new features without breaking changes |
| `latest` | the newest stable release | trying it out |
| `edge` | the current state of the `main` branch | testing upcoming changes, **not for production** |
| `sha-<commit>` | one commit of the `main` branch | tracking down a regression |

Pre-releases such as `1.3.0-rc.1` only get their own tag; they never move
`latest`, `1.3` or `1`.

**Pin a release** (`1.2.3`) in production and upgrade on purpose, after
reading the release notes and making a backup (see
[Upgrades](09-operations.md#upgrades)). With a moving tag a simple `pull` can
upgrade the database without warning, and
[migrations only go forward](09-operations.md#rolling-back). For the strictest
pinning, use the image digest instead of a tag
(`ghcr.io/raphael-penning/openstatuspage@sha256:...`, shown by
`docker buildx imagetools inspect`). How the images and releases are made is
described in [`docs/releasing.md`](../../releasing.md).

## Split deployment

The split deployment runs the public status page and the admin area as two
instances on two domains, plus a background worker, all on one PostgreSQL
database. The point is containment: the public instance cannot reach the admin
area, the monitoring systems or the admin tables, so a vulnerability in the
public app or a stolen admin session cannot make the data flow out through the
public instance.

| Container | `APP_ROLE` | Serves | Database role | Port on the host |
| --- | --- | --- | --- | --- |
| `public` | `public` | status page, public API, feeds, subscriptions, `/api/health` | `osp_public` (no table access) | `PUBLIC_HOST_PORT`, default 3000 |
| `admin` | `admin` | management UI and API, login, OIDC, ingest, public page for previews | owner role (`POSTGRES_USER`) | `ADMIN_HOST_PORT`, default 3001 |
| `worker` | `worker` | polling, mails, maintenance, bundles, imports, cleanup; `/api/health` only | owner role | none |
| `db` | – | PostgreSQL 17, not published | – | none |

The public container has no `env_file` and receives only its own settings: no
admin password, no OIDC or SMTP secrets, and no route to the monitoring systems
(they are polled by the worker). It never runs migrations and waits until the
admin instance has brought the schema up to date. The database role `osp_public`
sees only the public views and calls only the subscription functions, see
[security-model.md](../../security-model.md).

### Setup

You need the same as for [Docker Compose](#docker-compose), plus a clone of the
repository, because the file uses the database init script in `deploy/postgres/`:

```bash
git clone https://github.com/Raphael-Penning/openstatuspage.git
cd openstatuspage/deploy/compose
cp .env.example .env
chmod 600 .env
printf 'SECRET_KEY=%s\nSUBSCRIPTION_TOKEN_KEY=%s\nPOSTGRES_PASSWORD=%s\nPOSTGRES_PUBLIC_PASSWORD=%s\nPOSTGRES_APP_PASSWORD=%s\n' \
  "$(openssl rand -base64 48)" "$(openssl rand -base64 48)" \
  "$(openssl rand -hex 16)" "$(openssl rand -hex 16)" "$(openssl rand -hex 16)" >> .env
# edit .env, see below
docker compose -f compose.split.yaml up -d
```

In `.env`, uncomment and set the variables of the section *Split deployment*:

- `PUBLIC_BASE_URL`, the public domain, for example `https://status.example.com`.
- `ADMIN_BASE_URL`, the admin domain, for example `https://status.admin.example.com`.
- `ADMIN_EMAIL` and `ADMIN_PASSWORD`, for the first administrator (as in
  [Minimal configuration](#minimal-configuration)).
- `TRUST_PROXY`, the number of proxies in front of each instance (1 for one proxy).
- `PUBLIC_BIND` and `ADMIN_BIND` keep the default `127.0.0.1` when your reverse
  proxy runs on the same host.

Use letters and digits only in `POSTGRES_PASSWORD`, `POSTGRES_PUBLIC_PASSWORD`
and `POSTGRES_APP_PASSWORD`: they are part of connection URLs. `BASE_URL` in `.env` is not used by this file;
the compose file sets the base URL of each container. Only admin and worker
get `SECRET_KEY`; the public container gets `SUBSCRIPTION_TOKEN_KEY`, the key of
the subscription links, instead.

The database init script creates the roles `osp_public` (public container,
`POSTGRES_PUBLIC_PASSWORD`) and `osp_app` (admin and worker,
`POSTGRES_APP_PASSWORD`, not a superuser) when the data volume is created for
the first time.
If that step failed, the database is initialized already and the script does not
run again: stop the stack, remove the volume `openstatuspage-split_pg` (this
deletes the data) and start again.

### Reverse proxies

Each instance publishes plain HTTP on its own host port. Put one proxy host in
front of each:

| Domain | Points to | Notes |
| --- | --- | --- |
| `status.example.com` | `127.0.0.1:3000` | the public page; open to everyone |
| `status.admin.example.com` | `127.0.0.1:3001` | the admin area; restrict it, for example by IP address, VPN or an access proxy |

See [Reverse proxy](03-reverse-proxy.md) for the proxy settings. Do not publish
the admin domain to the internet without a restriction: that is the reason the
two instances are separate.

### Check the installation

```bash
docker compose -f compose.split.yaml ps
curl -fsS http://127.0.0.1:3000/api/health   # public
curl -fsS http://127.0.0.1:3001/api/health   # admin
docker compose -f compose.split.yaml logs --tail 50 worker
```

Then log in at `https://status.admin.example.com` and check that the status
page at `https://status.example.com` loads. The worker log shows the polling and
mail tasks; it should contain no errors.

### Upgrades and passwords

Pin `OSP_VERSION` to a release, as described in [Image tags](#image-tags), and
make a backup first ([Operations](09-operations.md)). Then run
`docker compose -f compose.split.yaml pull` followed by
`docker compose -f compose.split.yaml up -d`. The admin instance migrates the
schema; the public instance waits for it (`SCHEMA_WAIT_SECONDS`).

To change `POSTGRES_PUBLIC_PASSWORD` or `POSTGRES_APP_PASSWORD` later, change
it in `.env` (letters and digits only), then:

```bash
docker compose -f compose.split.yaml up -d db
docker compose -f compose.split.yaml exec db /docker-entrypoint-initdb.d/10-roles.sh
docker compose -f compose.split.yaml up -d public admin worker
```

### What the split does not cover

- **Admin and worker own the tables.** They connect as `osp_app`, which is not
  a superuser but owns every table and can read and change all data. A
  compromised admin or worker container therefore has full access to the
  application's data (not to other databases or the server). The separation
  protects the public side: the public role is the only one that faces the
  internet.
- **Shared secrets.** Admin and worker hold `SECRET_KEY`, all three containers
  hold `SUBSCRIPTION_TOKEN_KEY`. Keep the `.env` file private and back it up,
  see [Operations](09-operations.md#secret_key).
- **PostgreSQL only.** SQLite is a single-instance database and supports only the
  combined `all` role.
- **One host.** The compose file is an example for one machine. For several
  hosts or more replicas, see [Kubernetes](#kubernetes) and
  [Running several instances](09-operations.md#running-several-instances).

The Kubernetes example for the split deployment is in
The manifests are in `deploy/kubernetes/split/` (apply them with
`kubectl apply -k deploy/kubernetes/split`).

## Single container with SQLite

Without PostgreSQL the image stores its SQLite database in `/data`
(`DATABASE_URL=sqlite:/data/openstatuspage.db` is preset). Mount a volume
there, otherwise the data is lost with the container.

```bash
cat > openstatuspage.env <<EOF
SECRET_KEY=$(openssl rand -base64 48)
BASE_URL=https://status.example.com
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=a-long-password
EOF
chmod 600 openstatuspage.env

docker run -d --name openstatuspage --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v openstatuspage-data:/data \
  --env-file openstatuspage.env \
  ghcr.io/raphael-penning/openstatuspage:1.2.3
```

Keep `openstatuspage.env` and use it for every later `docker run`; a new
`SECRET_KEY` makes stored monitoring credentials unreadable. To upgrade,
`docker pull` the new tag, remove the container (`docker rm -f
openstatuspage`; the volume stays) and run the command again with the new
tag.

You can also use `compose.yaml` with SQLite: remove the `db` service, the
`depends_on` block, the `pg` volume and the `DATABASE_URL` line. The data is
then stored in the `data` volume.

SQLite supports exactly one running instance. Use PostgreSQL if you want
[additional replicas](09-operations.md#running-several-instances).

## Kubernetes

The directory `deploy/kubernetes/` in the repository contains example
manifests, combined with Kustomize:

| File | Content |
| --- | --- |
| `kustomization.yaml` | namespace `openstatuspage`, list of resources, pinned image tag |
| `namespace.yaml` | the namespace |
| `deployment.yaml` | one replica, `Recreate` strategy, health probes on `/api/health`, non-root security context |
| `service.yaml` | cluster-internal service for the pod |
| `ingress.yaml` | host `status.example.com` with TLS |
| `pvc.yaml` | volume for `/data` (needed for SQLite, harmless with PostgreSQL) |
| `secret.example.yaml` | documents the secret keys; **not** applied |

Prerequisites:

- an ingress controller (the example uses the default ingress class of the
  cluster; set `ingressClassName` in `ingress.yaml` otherwise),
- optionally cert-manager for the TLS certificate: add the annotation shown
  in the comment of `ingress.yaml`. Without it, create the TLS secret
  `openstatuspage-tls` yourself,
- a PostgreSQL database, e.g. a managed database or an operator in the
  cluster. Without one the app falls back to SQLite on the volume, which
  allows exactly one replica.

### Create the namespace and the secret

The secret named `openstatuspage` holds everything confidential. Create it
directly with `kubectl`, never commit it:

```bash
kubectl apply -f deploy/kubernetes/namespace.yaml

kubectl -n openstatuspage create secret generic openstatuspage \
  --from-literal=SECRET_KEY="$(openssl rand -base64 48)" \
  --from-literal=DATABASE_URL='postgres://openstatuspage:<password>@db.example.com:5432/openstatuspage' \
  --from-literal=ADMIN_EMAIL=admin@example.com \
  --from-literal=ADMIN_PASSWORD='a-long-password'
```

Optional keys: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`,
`SMTP_PASSWORD`, `SMTP_FROM` and the other variables from
[Configuration](04-configuration.md), e.g. `OIDC_CLIENT_SECRET`. To keep the
values out of your shell history, write them into a private file and use
`--from-env-file=openstatuspage.env` instead of `--from-literal`. Back up
`SECRET_KEY` outside the cluster; you can read it back with
`kubectl -n openstatuspage get secret openstatuspage -o jsonpath='{.data.SECRET_KEY}' | base64 -d`.

### Adjust and apply the manifests

1. Set your host name in `ingress.yaml` (rule and TLS section) and the same
   URL as `BASE_URL` in `deployment.yaml`.
2. Check `TRUST_PROXY` in `deployment.yaml`: it must equal the number of
   proxies in front of the app, see
   [Reverse proxy](03-reverse-proxy.md#kubernetes-ingress).
3. Pin the image tag in `kustomization.yaml`:

   ```yaml
   images:
     - name: ghcr.io/raphael-penning/openstatuspage
       newTag: "1.2.3"
   ```

4. Apply and wait for the rollout:

   ```bash
   kubectl apply -k deploy/kubernetes
   kubectl -n openstatuspage rollout status deployment/openstatuspage
   ```

Instead of editing the files you can keep them untouched and write your own
Kustomize overlay: a `kustomization.yaml` that lists the directory (or a
copy of it) under `resources:` and changes the host, `BASE_URL` and tag with
`patches:` and `images:`. That keeps your changes separate when you take
over newer manifests.

Check the installation:

```bash
kubectl -n openstatuspage get pods
kubectl -n openstatuspage logs deployment/openstatuspage
kubectl -n openstatuspage port-forward deployment/openstatuspage 3000:3000
# in a second terminal:
curl -fsS http://127.0.0.1:3000/api/health
```

Then open `https://status.example.com/admin` and log in.

Keep **one replica** unless the rules from
[Running several instances](09-operations.md#running-several-instances) are
met: PostgreSQL, and the worker enabled on exactly one pod. The `Recreate`
strategy makes sure two versions never run against the same database during
an upgrade.

The `create-user` and seed commands run in the pod the same way as with
Docker, e.g. `kubectl -n openstatuspage exec deployment/openstatuspage -- node server/dist/cli/create-user.js ...`.

## Building the image yourself

Build the image from the repository when you changed the code or need a
platform other than `linux/amd64` and `linux/arm64`. The override
`deploy/compose/compose.build.yaml` builds the image from the checkout
(`docker/Dockerfile`) and names it `openstatuspage:local`. Set up `.env` as
described [from a clone](#from-a-clone-of-the-repository), then:

```bash
cd openstatuspage/deploy/compose
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

Pass both `-f` files to every later command, or put
`COMPOSE_FILE=compose.yaml:compose.build.yaml` into `.env`; then plain
`docker compose ...` commands use both. Run `up -d --build` again after each
`git pull`. Without Compose, build in the repository root with
`docker build -f docker/Dockerfile -t openstatuspage:local .`

## From source

Requirements: Node.js 22 or newer and pnpm 10 (`corepack enable` installs the
pnpm version pinned in `package.json`). Building the native SQLite and
password hashing modules may need `python3`, `make` and a C++ compiler when no
prebuilt binary is available for your platform.

```bash
git clone https://github.com/Raphael-Penning/openstatuspage.git /opt/openstatuspage
cd /opt/openstatuspage
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Create `/opt/openstatuspage/.env` (start from [`.env.example`](../../../.env.example)):

```bash
NODE_ENV=production
BASE_URL=https://status.example.com
SECRET_KEY=<output of openssl rand -base64 48>
DATABASE_URL=sqlite:/var/lib/openstatuspage/openstatuspage.db
# or: DATABASE_URL=postgres://openstatuspage:<password>@localhost:5432/openstatuspage
HOST=127.0.0.1
```

Start it with `pnpm start`. The server runs in `apps/server`; it reads `.env`
from the working directory or the repository root (or the file named in
`ENV_FILE`). Use an absolute SQLite path: the default
`sqlite:./data/openstatuspage.db` is relative to the working directory.

A systemd unit could look like this:

```ini
# /etc/systemd/system/openstatuspage.service
[Unit]
Description=OpenStatusPage
After=network-online.target
Wants=network-online.target

[Service]
User=openstatuspage
WorkingDirectory=/opt/openstatuspage/apps/server
EnvironmentFile=/opt/openstatuspage/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

The user needs write access to the directory of the SQLite file.

For local development (`pnpm dev`, hot reload, Vite dev server on port 5173)
see [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).

## The first administrator

There are two ways to create the first account:

1. **`ADMIN_EMAIL` and `ADMIN_PASSWORD`**: on start, when the database contains
   no user at all, an administrator with these credentials is created. Later
   starts ignore the variables. Remove `ADMIN_PASSWORD` from the environment
   (`.env` followed by `docker compose up -d`, or the Kubernetes secret)
   after the first login and change the password in the user menu.
2. **The `create-user` command**, which creates a user or, if the address
   already exists, sets a new password and role and ends the user's sessions:

   ```bash
   # Docker Compose
   docker compose exec openstatuspage \
     node server/dist/cli/create-user.js admin@example.com 'a-long-password' admin 'Jane Doe'

   # single container
   docker exec openstatuspage node server/dist/cli/create-user.js admin@example.com 'a-long-password' admin

   # Kubernetes
   kubectl -n openstatuspage exec deployment/openstatuspage -- \
     node server/dist/cli/create-user.js admin@example.com 'a-long-password' admin

   # from source
   pnpm --filter @openstatuspage/server create-user admin@example.com 'a-long-password' admin
   ```

   Arguments: email, password (at least 10 characters), role `admin` or
   `editor` (default `admin`) and an optional display name. This is also the
   way back in if every administrator lost their password.

When no user exists and neither way was used, the server logs a warning on
every start.

## Checking the installation

- `curl -fsS http://127.0.0.1:3000/api/health` returns `{"status":"ok",...}` when
  the app and the database work. The Docker image uses the same endpoint for
  its built-in health check (`docker ps` shows `healthy`), the Kubernetes
  example for its readiness and liveness probes.
- The logs list configuration errors with the offending variable names; the
  process exits on invalid configuration.
- Log in at `/admin`, open **Settings** and give the page a name.

If the image cannot be pulled, see
[Troubleshooting](10-troubleshooting.md#container-image).

Next: put the app [behind a reverse proxy with HTTPS](03-reverse-proxy.md).

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
| [Docker Compose with the prebuilt image](#docker-compose-with-the-prebuilt-image) | PostgreSQL 17 container | most production setups |
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
`latest`, `1.3` or `1`. Before the first release is published, only `edge`
and the `sha-` tags exist.

**Pin a release** (`1.2.3`) in production and upgrade on purpose, after
reading the release notes and making a backup (see
[Upgrades](09-operations.md#upgrades)). With `latest` or a moving tag a
simple restart or `pull` can upgrade the database without warning, and
[migrations only go forward](09-operations.md#rolling-back). For the strictest
pinning, use the image digest instead of a tag
(`ghcr.io/raphael-penning/openstatuspage@sha256:...`, shown by
`docker buildx imagetools inspect`).

The images are built and published by the CI pipeline of the repository,
see [`docs/releasing.md`](../../releasing.md).

## Docker Compose with the prebuilt image

The repository contains a ready-to-use [`docker/docker-compose.yml`](../../../docker/docker-compose.yml)
with two services: `openstatuspage` (the prebuilt image) and `db`
(PostgreSQL 17). Data is kept in the named volumes `pg` (database) and `data`.

### Get the compose file

Either clone the repository:

```bash
git clone https://github.com/Raphael-Penning/openstatuspage.git
cd openstatuspage
```

or download only the compose file, into a `docker` directory so that the
commands in this guide work unchanged:

```bash
mkdir -p openstatuspage/docker && cd openstatuspage
curl -fsSL -o docker/docker-compose.yml \
  https://raw.githubusercontent.com/Raphael-Penning/openstatuspage/main/docker/docker-compose.yml
```

To get the file exactly as it was released, replace `main` in the URL with
the release tag (e.g. `v1.2.3`).

### Create the env file

Put your settings into a private file `deploy.env` next to the `docker`
directory. Generate the secrets once:

```bash
touch deploy.env && chmod 600 deploy.env
echo "SECRET_KEY=$(openssl rand -base64 48)" >> deploy.env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" >> deploy.env
```

Then add the rest with an editor:

```bash
# deploy.env (keep it private: chmod 600, never commit it)
SECRET_KEY=<generated>
POSTGRES_PASSWORD=<generated>
OSP_VERSION=1.2.3
BASE_URL=https://status.example.com
HOST_PORT=127.0.0.1:3000
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=a-long-password
```

| Variable | Meaning |
| --- | --- |
| `OSP_VERSION` | [Image tag](#image-tags) to run, default `latest`. Pin a release. |
| `OSP_IMAGE` | Image without tag, default `ghcr.io/raphael-penning/openstatuspage`. Change it for a fork or your own registry mirror. |
| `HOST_PORT` | Port published on the host, see [HOST_PORT](#host_port). |

Keep this file: you need the same `SECRET_KEY` and `POSTGRES_PASSWORD` for
every later command. Git ignores it (like every `*.env` file), and it is not
part of the Docker build context, so it ends up neither in a commit nor in an
image.

### Start

```bash
docker compose --env-file deploy.env -f docker/docker-compose.yml pull
docker compose --env-file deploy.env -f docker/docker-compose.yml up -d
```

Compose refuses to start when `SECRET_KEY` or `POSTGRES_PASSWORD` is missing.
It reads the compose file for **every** command (`ps`, `logs`, `exec`, ...),
so always pass `--env-file deploy.env`, as all commands in this guide do. To
type less, set `COMPOSE_ENV_FILES=deploy.env` and
`COMPOSE_FILE=docker/docker-compose.yml` in your shell; then a plain
`docker compose up -d` uses both.

Check that it runs:

```bash
docker compose --env-file deploy.env -f docker/docker-compose.yml ps
curl -fsS http://127.0.0.1:3000/api/health
```

`ps` shows the app as `healthy` after a few seconds, and the health endpoint
returns `{"status":"ok"}`. Then open `http://localhost:3000/admin` (or your
`BASE_URL`) and log in. For HTTPS continue with the
[reverse proxy](03-reverse-proxy.md).

### More environment variables

The compose file passes `BASE_URL`, `SECRET_KEY`, `DATABASE_URL`,
`ADMIN_EMAIL`, `ADMIN_PASSWORD` and the email variables (`MAIL_TRANSPORT`,
`SMTP_*`, see [Email subscriptions](07-email-subscriptions.md#mail-server))
into the container, so you set them in `deploy.env`. Further options (for
example `TRUST_PROXY`, `LOG_LEVEL` or the OIDC variables) must be added to
the `environment:` section of the `openstatuspage` service. Do that in a
small override file of your own, so the shipped compose file stays unchanged
and can simply be replaced on upgrades:

```yaml
# docker/docker-compose.local.yml
services:
  openstatuspage:
    environment:
      TRUST_PROXY: "1"
      LOG_LEVEL: ${LOG_LEVEL:-info}
```

`${...}` takes the value from `deploy.env`. Pass the override with a second
`-f` on every command:

```bash
docker compose --env-file deploy.env \
  -f docker/docker-compose.yml -f docker/docker-compose.local.yml up -d
```

### HOST_PORT

The app listens on port 3000 inside the container. `HOST_PORT` (default
`3000`) selects the port published on the host:

- `HOST_PORT=8080` publishes port 8080 on all interfaces.
- `HOST_PORT=127.0.0.1:3000` publishes it on localhost only. Use this when a
  reverse proxy on the same host terminates HTTPS, so the plain HTTP port is
  not reachable from outside.

### Optional demo data

To look around with fictional data, fill an **empty** database once:

```bash
docker compose --env-file deploy.env -f docker/docker-compose.yml \
  exec openstatuspage node server/dist/cli/seed.js
```

The seed refuses to run when services already exist. Do not use it on a
production instance.

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

You can also use the compose file with SQLite: remove the `db` service, the
`depends_on` block, the `pg` volume and the `DATABASE_URL` line.

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
[`docker/docker-compose.build.yml`](../../../docker/docker-compose.build.yml)
adds the build section and names the image `openstatuspage:local`:

```bash
git clone https://github.com/Raphael-Penning/openstatuspage.git
cd openstatuspage
docker compose --env-file deploy.env \
  -f docker/docker-compose.yml -f docker/docker-compose.build.yml up -d --build
```

Use both `-f` files for every later command, and `up -d --build` again after
each `git pull`. Without Compose, build with
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
   (`deploy.env` or the Kubernetes secret) after the first login and change
   the password in the user menu.
2. **The `create-user` command**, which creates a user or, if the address
   already exists, sets a new password and role and ends the user's sessions:

   ```bash
   # Docker Compose
   docker compose --env-file deploy.env -f docker/docker-compose.yml exec openstatuspage \
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

- `curl -fsS http://127.0.0.1:3000/api/health` returns `{"status":"ok"}` when
  the app and the database work. The Docker image uses the same endpoint for
  its built-in health check (`docker ps` shows `healthy`), the Kubernetes
  example for its readiness and liveness probes.
- The logs list configuration errors with the offending variable names; the
  process exits on invalid configuration.
- Log in at `/admin`, open **Settings** and give the page a name.

If the image cannot be pulled, see
[Troubleshooting](10-troubleshooting.md#container-image).

Next: put the app [behind a reverse proxy with HTTPS](03-reverse-proxy.md).

# Installation

OpenStatusPage runs as a single Node.js process that serves the API, the
public page and the management UI. Choose one of three ways to run it:

| Option | Database | Good for |
| --- | --- | --- |
| [Docker Compose with PostgreSQL](#docker-compose-with-postgresql) | PostgreSQL 17 container | most production setups |
| [Single container with SQLite](#single-container-with-sqlite) | SQLite file in a volume | small setups, one instance |
| [From source](#from-source) | SQLite or PostgreSQL | hosts without Docker, development |

All options build from the source code in this repository; there is no
prebuilt image to pull.

## Minimal configuration

Every installation needs at least these environment variables:

| Variable | Example | Why |
| --- | --- | --- |
| `SECRET_KEY` | output of `openssl rand -base64 48` | Encrypts monitoring credentials and signs data. At least 32 characters, required in production. **Back it up**, see [Operations](09-operations.md#secret_key). |
| `BASE_URL` | `https://status.example.com` | The public URL, used for links in feeds and emails, the OIDC redirect URI and the ingest URLs shown in the UI. No trailing slash. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | `admin@example.com`, at least 10 characters | Creates the first administrator, only when the database has no user yet. |

`DATABASE_URL` defaults to an SQLite file; set it for PostgreSQL. All other
options are described in [Configuration](04-configuration.md).

## Docker Compose with PostgreSQL

The repository contains a ready-to-use [`docker/docker-compose.yml`](../../../docker/docker-compose.yml)
with two services: `openstatuspage` (built from the repository) and `db`
(PostgreSQL 17). Data is kept in the named volumes `pg` (database) and `data`.

```bash
git clone <repository URL> openstatuspage
cd openstatuspage

export SECRET_KEY="$(openssl rand -base64 48)"
export POSTGRES_PASSWORD="$(openssl rand -hex 16)"
export BASE_URL=https://status.example.com
export ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='a-long-password'

docker compose -f docker/docker-compose.yml up -d --build
```

Compose refuses to start when `SECRET_KEY` or `POSTGRES_PASSWORD` is missing.
Instead of exporting the variables you can put them into a file and pass it
with `--env-file`:

```bash
# deploy.env (keep it private, e.g. chmod 600)
SECRET_KEY=...
POSTGRES_PASSWORD=...
BASE_URL=https://status.example.com
HOST_PORT=127.0.0.1:3000
```

```bash
docker compose --env-file deploy.env -f docker/docker-compose.yml up -d --build
```

Keep this file: you need the same `SECRET_KEY` and `POSTGRES_PASSWORD` for
every later `up`. Git ignores it (like every `*.env` file), and it is not part
of the Docker build context, so it ends up neither in a commit nor in the image.

The compose file passes `BASE_URL`, `SECRET_KEY`, `DATABASE_URL`,
`ADMIN_EMAIL`, `ADMIN_PASSWORD` and the email variables (`MAIL_TRANSPORT`,
`SMTP_*`, see [Email subscriptions](07-email-subscriptions.md#mail-server))
into the container, so you can set them in the env file or the shell. To use
further options (for example `TRUST_PROXY`, `LOG_LEVEL` or the OIDC
variables), add them to the `environment:` section of the `openstatuspage`
service.

### HOST_PORT

The app listens on port 3000 inside the container. `HOST_PORT` (default
`3000`) selects the port published on the host:

- `HOST_PORT=8080` publishes port 8080 on all interfaces.
- `HOST_PORT=127.0.0.1:3000` publishes it on localhost only. Use this when a
  reverse proxy on the same host terminates HTTPS, so the plain HTTP port is
  not reachable from outside.

Then open `http://localhost:3000/admin` (or your `BASE_URL`) and log in.

### Optional demo data

To look around with fictional data, fill an **empty** database once:

```bash
docker compose -f docker/docker-compose.yml exec openstatuspage node server/dist/cli/seed.js
```

The seed refuses to run when services already exist. Do not use it on a
production instance.

## Single container with SQLite

Without PostgreSQL the image stores its SQLite database in `/data`
(`DATABASE_URL=sqlite:/data/openstatuspage.db` is preset). Mount a volume
there, otherwise the data is lost with the container.

```bash
docker build -f docker/Dockerfile -t openstatuspage .

docker run -d --name openstatuspage --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v openstatuspage-data:/data \
  -e SECRET_KEY="$(openssl rand -base64 48)" \
  -e BASE_URL=https://status.example.com \
  -e ADMIN_EMAIL=admin@example.com \
  -e ADMIN_PASSWORD='a-long-password' \
  openstatuspage
```

Store the generated `SECRET_KEY` somewhere safe (for example in an env file
used with `--env-file`); a new key on the next `docker run` makes stored
monitoring credentials unreadable.

You can also use the compose file with SQLite: remove the `db` service, the
`depends_on` block, the `pg` volume and the `DATABASE_URL` line.

SQLite supports exactly one running instance. Use PostgreSQL if you want
[additional replicas](09-operations.md#running-several-instances).

## From source

Requirements: Node.js 22 or newer and pnpm 10 (`corepack enable` installs the
pnpm version pinned in `package.json`). Building the native SQLite and
password hashing modules may need `python3`, `make` and a C++ compiler when no
prebuilt binary is available for your platform.

```bash
git clone <repository URL> /opt/openstatuspage
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
   after the first login and change the password in the user menu.
2. **The `create-user` command**, which creates a user or, if the address
   already exists, sets a new password and role:

   ```bash
   # Docker Compose
   docker compose -f docker/docker-compose.yml exec openstatuspage \
     node server/dist/cli/create-user.js admin@example.com 'a-long-password' admin 'Jane Doe'

   # single container
   docker exec openstatuspage node server/dist/cli/create-user.js admin@example.com 'a-long-password' admin

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
  its built-in health check (`docker ps` shows `healthy`).
- The logs list configuration errors with the offending variable names; the
  process exits on invalid configuration.
- Log in at `/admin`, open **Settings** and give the page a name.

Next: put the app [behind a reverse proxy with HTTPS](03-reverse-proxy.md).

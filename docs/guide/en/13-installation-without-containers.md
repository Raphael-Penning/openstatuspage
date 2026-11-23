# Installation without containers

OpenStatusPage also runs directly on a Linux server with systemd, without
Docker. Every release attaches the files for that:

| File | Content |
| --- | --- |
| `openstatuspage-<version>-linux-x64.tar.gz`, `…-linux-arm64.tar.gz` | The built server and web client with their production dependencies, the systemd units, the launcher, the reverse proxy templates and `install.sh`. |
| `openstatuspage_<version>_amd64.deb`, `…_arm64.deb` | Debian and Ubuntu package with the same content. |
| `openstatuspage-<version>-1.x86_64.rpm`, `…aarch64.rpm` | RHEL, Rocky, AlmaLinux and Fedora package with the same content. |
| `install.sh` | The install script (also inside the tarball as `scripts/install.sh`). |
| `SHA256SUMS` | SHA-256 checksums of all of the above. |

Choose one way:

| Option | Good for |
| --- | --- |
| [Install script](#install-script) | most servers: one command, sets up Node.js, PostgreSQL and a mail server if you want, updates with checksum check |
| [Packages](#packages) | hosts managed with apt or dnf, configuration management |
| [Tarball by hand](#tarball-by-hand) | full control over every step |
| [Run from source](#run-from-source) | development, own changes |

Supported: Debian 11 or newer, Ubuntu 22.04 or newer, RHEL, Rocky Linux and
AlmaLinux 9 or newer, Fedora; `x86_64` and `aarch64`. The native modules of
the release are built against glibc 2.31. Alpine Linux (musl, OpenRC) is not
supported by these files: use the [container image](02-installation.md) there,
or build from source on the host.

Every way runs the same program as the container image, with the same
memory settings, and needs **Node.js 22** (exactly this major version: the
native modules are built for it). Put a reverse proxy with HTTPS in front of
it, see [reverse proxy](#reverse-proxy).

## Install script

The script installs a release to `/opt/openstatuspage/app`, writes the
settings to `/etc/openstatuspage/openstatuspage.env` (mode `0640`, it holds
secrets), keeps the data in `/var/lib/openstatuspage` and installs hardened
systemd units. It checks the SHA-256 of the download against the release's
`SHA256SUMS`, generates `SECRET_KEY` on the first install and never overwrites
existing settings or data, so you can run it again at any time, for example
to add PostgreSQL or the mail server later.

```bash
curl -fsSLO https://github.com/Raphael-Penning/openstatuspage/releases/latest/download/install.sh
less install.sh   # read what it does
sudo bash install.sh install --base-url https://status.example.com
```

Then set the first administrator in `/etc/openstatuspage/openstatuspage.env`
(`ADMIN_EMAIL`, `ADMIN_PASSWORD`, see [the first administrator](02-installation.md#the-first-administrator))
and run `sudo systemctl restart openstatuspage`. The app listens on
`127.0.0.1:3000`.

Options of `install`:

| Option | Meaning |
| --- | --- |
| `--base-url URL` | Public URL of the status page (`BASE_URL`). |
| `--version X.Y.Z` | Install this release instead of the latest one. |
| `--tarball FILE` | Install a local tarball; `SHA256SUMS` must be next to it. |
| `--with-postgres` | Install PostgreSQL from the distribution, create the database `openstatuspage` and the roles of `deploy/postgres/roles.sql` with generated passwords (stored root-only in `/etc/openstatuspage/.database-passwords`), allow their password login on the loopback interface, and point `DATABASE_URL` at it. Without it, SQLite in `/var/lib/openstatuspage` is used. |
| `--database-url URL` | Use an existing PostgreSQL (login of the app role). |
| `--mode split` | The [split deployment](#split-deployment): public, admin and worker as three services. |
| `--admin-url URL`, `--public-database-url URL` | Admin domain and login of the restricted public role, for `--mode split` (not needed with `--with-postgres`). |
| `--with-postfix --mail-domain example.com` | A local send-only Postfix with DKIM, see [mail server](#mail-server). |
| `--node MODE` | `system`: Node.js 22 from `PATH`; `bundled`: a private copy in `/opt/openstatuspage/node` from nodejs.org (checked against its `SHASUMS256.txt`). `auto` (default) uses a suitable `node` on `PATH` and installs the private copy otherwise. |
| `--no-start` | Do not enable or start the service. |

### What the script changes

- Packages: `curl`, `tar` and `gzip` if missing; PostgreSQL, Postfix and
  OpenDKIM only with the matching option (on Rocky and RHEL OpenDKIM comes from
  EPEL, which the script enables).
- Users `openstatuspage` (runs the services) and `openstatuspage-public` (runs
  only the public instance of the split deployment), both without login.
- `/opt/openstatuspage/app` (the release, owned by root), the previous release
  in `/opt/openstatuspage/app.previous`, optionally `/opt/openstatuspage/node`.
- `/etc/openstatuspage` (settings, root and the group `openstatuspage`),
  `/var/lib/openstatuspage` (data).
- The units `openstatuspage.service`, `openstatuspage-public.service`,
  `openstatuspage-admin.service`, `openstatuspage-worker.service` and
  `openstatuspage-split.target` in `/etc/systemd/system`.

The units run as the unprivileged user with `ProtectSystem=strict` (only
`/var/lib/openstatuspage` is writable), `NoNewPrivileges`, `PrivateTmp`,
`PrivateDevices`, an empty capability bounding set, a system call filter and
`MemoryMax=256M`. Look at them with `systemctl cat openstatuspage`.

### Split deployment

The same split as with [Compose](02-installation.md#split-deployment): the
public page and the admin portal on separate domains, the worker on its own.
It needs PostgreSQL.

```bash
sudo bash install.sh install --mode split --with-postgres \
  --base-url https://status.example.com --admin-url https://status.admin.example.com
```

| Service | Port | Settings |
| --- | --- | --- |
| `openstatuspage-public` | 3000 | `/etc/openstatuspage/public.env` only. It runs as `openstatuspage-public` and cannot read the other files, so it never sees `SECRET_KEY`, the admin password, SMTP credentials or the owner database login. |
| `openstatuspage-admin` | 3001 | `openstatuspage.env`, then `admin.env` |
| `openstatuspage-worker` | 3002 (health only) | `openstatuspage.env`, then `worker.env` |

`systemctl restart openstatuspage-split.target` restarts all three. The proxy
templates for two domains are `Caddyfile.split` and `nginx.split.conf`.

### Update, rollback, uninstall

```bash
sudo bash /opt/openstatuspage/app/scripts/install.sh update            # latest release
sudo bash /opt/openstatuspage/app/scripts/install.sh update --version 0.4.0
sudo bash /opt/openstatuspage/app/scripts/install.sh rollback          # back to the release before
sudo bash /opt/openstatuspage/app/scripts/install.sh uninstall
```

`update` downloads the release and its `SHA256SUMS`, checks the checksum,
replaces `/opt/openstatuspage/app` (keeping the old one as `app.previous`),
refreshes the private Node.js 22 if there is one, restarts the running
services and waits for `/api/health`. The new release migrates the database on
start; `rollback` brings back the program but not the old schema, so take a
[backup](09-operations.md#backup-and-restore) first.

`uninstall` stops and removes the services and `/opt/openstatuspage`. It keeps
the settings, the data, the users and a PostgreSQL or Postfix the script set
up; delete them by hand if you no longer need them.

## Packages

The `.deb` and `.rpm` packages contain exactly the tarball and the units.
Their scripts create the users and directories and, on the first install, the
settings file with a generated `SECRET_KEY`. They never enable or start a
service on a new install, never overwrite the settings and keep settings and
data when the package is removed. An upgrade restarts the services that run.

```bash
# Debian, Ubuntu
sudo apt install ./openstatuspage_0.4.0_amd64.deb
# RHEL, Rocky, AlmaLinux, Fedora
sudo dnf install ./openstatuspage-0.4.0-1.x86_64.rpm
```

The packages recommend `nodejs` 22 but do not bring it, since most
distributions ship another version. Install Node.js 22 from your distribution
(for example the `nodejs:22` module stream on RHEL 9) or NodeSource, or run
`sudo /opt/openstatuspage/app/scripts/install.sh node` for the private copy.
Then edit `/etc/openstatuspage/openstatuspage.env` and run
`sudo systemctl enable --now openstatuspage`. Update with `apt`/`dnf`;
`install.sh update` refuses to touch a package installation.

## Tarball by hand

```bash
version=0.4.0
curl -fsSLO "https://github.com/Raphael-Penning/openstatuspage/releases/download/v$version/openstatuspage-$version-linux-x64.tar.gz"
curl -fsSLO "https://github.com/Raphael-Penning/openstatuspage/releases/download/v$version/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS
sudo mkdir -p /opt/openstatuspage
sudo tar -xzf "openstatuspage-$version-linux-x64.tar.gz" -C /opt/openstatuspage
sudo mv "/opt/openstatuspage/openstatuspage-$version-linux-x64" /opt/openstatuspage/app
```

Then do by hand what the script does: create the user, the directories and
`/etc/openstatuspage/openstatuspage.env` from
`/opt/openstatuspage/app/share/openstatuspage.env.example`, and copy the units
from `/opt/openstatuspage/app/share/systemd/` to `/etc/systemd/system/`. The
launcher `/opt/openstatuspage/app/bin/openstatuspage` also runs the CLI
commands as the service user, for example:

```bash
sudo -u openstatuspage /opt/openstatuspage/app/bin/openstatuspage create-user --help
```

## Run from source

For development or own changes: you need Node.js 22, pnpm (`corepack enable`)
and, when no prebuilt binary fits your platform, `python3`, `make` and a C++
compiler for the native modules.

```bash
git clone https://github.com/Raphael-Penning/openstatuspage.git
cd openstatuspage
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

The simplest way to run the build as a service is to turn it into a tarball and
install that with the script, which gives you the same units and layout as a
release:

```bash
scripts/build-bundle.sh 0.4.0-local.1          # writes dist/release/openstatuspage-0.4.0-local.1-linux-<arch>.tar.gz
(cd dist/release && sha256sum -- *.tar.gz > SHA256SUMS)
sudo bash scripts/install.sh install --tarball dist/release/openstatuspage-0.4.0-local.1-linux-x64.tar.gz
```

Without the script, `pnpm start` runs the server from `apps/server`; it reads
`.env` from the working directory or the file in `ENV_FILE`. The unit in
[From source](02-installation.md#from-source) shows a minimal service; copy the
hardening lines from `deploy/bare-metal/systemd/openstatuspage.service` into it.
For hot reload during development see `CONTRIBUTING.md`.

## Reverse proxy

`deploy/proxy/` has templates for Caddy (automatic certificates) and nginx,
for one instance and for the split deployment; the tarball has them in
`/opt/openstatuspage/app/share/proxy`. See its [README](../../../deploy/proxy/README.md).
They expect the app on `127.0.0.1`, which is why `TRUST_PROXY=1` is safe:
nobody can reach the app port around the proxy. If the proxy runs on another
host, let the app listen on its private address and set `TRUST_PROXY` to the
proxy's address instead, see [TRUST_PROXY](03-reverse-proxy.md#trust_proxy).

## Mail server

Subscription and notification mails need a mail server. Both the Compose files
and the install script can bring a send-only Postfix that signs with DKIM;
you can always use another server instead.

### Bundled Postfix with Docker Compose

`compose.yaml` and `compose.split.yaml` contain a `postfix` service (the widely
used image `boky/postfix`, pinned by version). It is on by default in a new
`.env`:

```bash
COMPOSE_PROFILES=mail
MAIL_DOMAIN=example.com
```

The app then sends as `Status <status@example.com>` through `postfix` without
any `SMTP_*` setting. The mail server:

- generates a DKIM key (selector `osp`) on the first start into the volume
  `dkim` and signs every mail with it;
- copies only the **public** key to the volume `dkim-public`, which the app
  mounts read-only (`MAIL_DKIM_DIR`) to show the DNS records;
- is never published on a host port, sits on an internal network with the app
  (the public instance of the split deployment is not on it), and relays only
  for that network (`MAIL_SUBNET`, default `172.30.250.0/28`, `…251.0/28` for
  the split; change it if it overlaps with a network of your host) and only
  for senders of `MAIL_DOMAIN`.

Without `MAIL_RELAYHOST` it delivers directly to the recipients' servers. That
needs outbound port 25 (blocked by many cloud providers), a PTR record for the
host's address that matches `MAIL_HOSTNAME` (default: `MAIL_DOMAIN`), and the
DNS records below. Otherwise relay through your provider:
`MAIL_RELAYHOST=[smtp.example.com]:587` with `MAIL_RELAYHOST_USERNAME` and
`MAIL_RELAYHOST_PASSWORD`. A subdomain such as `status.example.com` as
`MAIL_DOMAIN` keeps these records apart from your other mail.

### Local Postfix with the install script

```bash
sudo bash install.sh install --with-postfix --mail-domain example.com
```

installs Postfix and OpenDKIM, listening on `127.0.0.1` only (`inet_interfaces
= loopback-only`, no local delivery, relaying only for `127.0.0.1`/`::1`),
generates the key in `/etc/opendkim/keys/example.com/osp.private` and copies the
public key to `/etc/openstatuspage/dkim`. It sets `SMTP_HOST=127.0.0.1`,
`SMTP_PORT=25`, `SMTP_FROM` and `MAIL_DKIM_DIR` in the settings. The script
refuses to take over a Postfix, Exim or Sendmail that was installed before;
`--mail-relayhost` and `--mail-hostname` work like the Compose variables.

### DNS records

Once the app knows the public key, **Settings → Email delivery** shows the
records to publish for the sender domain, each with a copy button:

| Record | Name | Value |
| --- | --- | --- |
| SPF | `example.com` | `v=spf1 ip4:<server-ipv4> ip6:<server-ipv6> -all`: put in the addresses the server sends from. If the domain already has an SPF record, add them to it; a domain must have only one. |
| DKIM | `osp._domainkey.example.com` | `v=DKIM1; k=rsa; p=…` (the generated key) |
| DMARC | `_dmarc.example.com` | `v=DMARC1; p=quarantine; adkim=s; aspf=s`. Start with `p=none` while you check the reports, then tighten it. |

The same records are in the API (`dns` in `GET /api/admin/notifications/status`).
Then send a [test email](07-email-subscriptions.md#test-email) and check its
headers (`dkim=pass`, `spf=pass`).

### Another mail server

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` and `SMTP_FROM`
(see [mail server](07-email-subscriptions.md#mail-server)); they always win
over the bundled Postfix. With Compose also remove `MAIL_DOMAIN` and remove
`mail` from `COMPOSE_PROFILES` (an empty `COMPOSE_PROFILES=` or deleting the
line), then `docker compose up -d --remove-orphans` stops the `postfix`
service. The volumes `dkim` and `dkim-public` stay until you delete them.

## Troubleshooting

- `journalctl -u openstatuspage -n 100` (or `-u 'openstatuspage*'` for the split)
  shows start-up errors, for example a missing setting.
- `Node.js 22 is required`: install Node.js 22 or run `install.sh node`.
- `curl http://127.0.0.1:3000/api/health` answers `{"status":"ok"}` while the
  database is reachable.
- Mail: `journalctl -u postfix -u opendkim` (script) or
  `docker compose logs postfix` (Compose); the **Email delivery** panel shows the
  last delivery error.

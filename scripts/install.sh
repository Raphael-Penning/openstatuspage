#!/usr/bin/env bash
# OpenStatusPage installer for Linux without containers (systemd).
#
# Installs a release tarball (openstatuspage-<version>-linux-<arch>.tar.gz) to
# /opt/openstatuspage/app, settings to /etc/openstatuspage, data to
# /var/lib/openstatuspage, and the hardened systemd units. Optionally sets up a
# local PostgreSQL and a send-only Postfix with DKIM. Safe to rerun: existing
# settings, secrets and data are never overwritten.
#
# Supported: Debian 11+, Ubuntu 22.04+, RHEL/Rocky/AlmaLinux 9+, Fedora; x86_64
# and aarch64. Alpine is not supported (musl: the native modules of the release
# are glibc builds, and the units need systemd); use the container image there.
#
# Usage (as root):
#   install.sh install   [options]   install or reconfigure
#   install.sh update    [options]   install a newer release and restart
#   install.sh rollback              go back to the release before the last update
#   install.sh uninstall             remove the program, keep settings and data
#   install.sh node                  install or refresh the private Node.js 22 runtime
#   install.sh help
#
# Options:
#   --version X.Y.Z        release to install (default: the latest release)
#   --tarball FILE         install a local tarball; SHA256SUMS must be next to it
#   --mode all|split       one instance with every role (default) or the split
#                          deployment (public, admin and worker; needs PostgreSQL)
#   --base-url URL         public URL of the status page (new installs)
#   --admin-url URL        URL of the admin domain (split mode)
#   --with-postgres        install PostgreSQL locally and create the database
#                          and the roles of deploy/postgres/roles.sql
#   --database-url URL     PostgreSQL URL of the app role (instead of --with-postgres)
#   --public-database-url URL   PostgreSQL URL of the public role (split mode)
#   --with-postfix         install a local send-only Postfix with OpenDKIM
#   --mail-domain DOMAIN   sender domain for --with-postfix (status@DOMAIN)
#   --mail-hostname NAME   HELO name of Postfix (default: the mail domain)
#   --mail-relayhost HOST  send through a smarthost, e.g. [smtp.example.com]:587
#   --dkim-selector NAME   DKIM selector (default: osp)
#   --node auto|system|bundled   Node.js 22 from PATH or the private runtime
#                          in /opt/openstatuspage/node (default: auto)
#   --no-start             install only, do not enable or start the services
#
# Environment: OSP_REPO (GitHub repository, default Raphael-Penning/openstatuspage).
# Guide: docs/guide/en/13-installation-without-containers.md
set -euo pipefail
umask 022

REPO="${OSP_REPO:-Raphael-Penning/openstatuspage}"
PREFIX=/opt/openstatuspage
APP_DIR=/opt/openstatuspage/app
NODE_DIR=/opt/openstatuspage/node
CONF_DIR=/etc/openstatuspage
ENV_FILE=/etc/openstatuspage/openstatuspage.env
DB_SECRETS=/etc/openstatuspage/.database-passwords
DKIM_PUBLIC_DIR=/etc/openstatuspage/dkim
DATA_DIR=/var/lib/openstatuspage
UNIT_DIR=/etc/systemd/system
APP_USER=openstatuspage
PUBLIC_USER=openstatuspage-public
DB_NAME=openstatuspage
UNITS=(openstatuspage.service openstatuspage-public.service openstatuspage-admin.service openstatuspage-worker.service openstatuspage-split.target)

COMMAND=""
VERSION=""
TARBALL=""
MODE=""
BASE_URL=""
ADMIN_URL=""
WITH_POSTGRES=false
DATABASE_URL=""
PUBLIC_DATABASE_URL=""
WITH_POSTFIX=false
MAIL_DOMAIN=""
MAIL_HOSTNAME=""
MAIL_RELAYHOST=""
DKIM_SELECTOR=osp
NODE_CHOICE=auto
START=true

TMP=""
OS_FAMILY=""
ARCH=""

log() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
cleanup() { if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf -- "$TMP"; fi; }
trap cleanup EXIT

usage() { sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; }

parse_args() {
  [ "$#" -gt 0 ] || {
    usage
    exit 2
  }
  COMMAND="$1"
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version) VERSION="${2:?--version needs a value}"; shift ;;
      --tarball) TARBALL="${2:?--tarball needs a file}"; shift ;;
      --mode) MODE="${2:?--mode needs all or split}"; shift ;;
      --base-url) BASE_URL="${2:?--base-url needs a URL}"; shift ;;
      --admin-url) ADMIN_URL="${2:?--admin-url needs a URL}"; shift ;;
      --with-postgres) WITH_POSTGRES=true ;;
      --database-url) DATABASE_URL="${2:?--database-url needs a URL}"; shift ;;
      --public-database-url) PUBLIC_DATABASE_URL="${2:?--public-database-url needs a URL}"; shift ;;
      --with-postfix) WITH_POSTFIX=true ;;
      --mail-domain) MAIL_DOMAIN="${2:?--mail-domain needs a domain}"; shift ;;
      --mail-hostname) MAIL_HOSTNAME="${2:?--mail-hostname needs a name}"; shift ;;
      --mail-relayhost) MAIL_RELAYHOST="${2:?--mail-relayhost needs a host}"; shift ;;
      --dkim-selector) DKIM_SELECTOR="${2:?--dkim-selector needs a name}"; shift ;;
      --node) NODE_CHOICE="${2:?--node needs auto, system or bundled}"; shift ;;
      --no-start) START=false ;;
      -h | --help) COMMAND=help ;;
      *) die "unknown option: $1 (see: $0 help)" ;;
    esac
    shift
  done
}

validate_args() {
  local url_re='^https?://[A-Za-z0-9.-]+(:[0-9]+)?$'
  [ -z "$VERSION" ] || [[ "${VERSION#v}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "invalid --version: $VERSION"
  [ -z "$MODE" ] || [[ "$MODE" =~ ^(all|split)$ ]] || die "--mode must be all or split"
  [ -z "$BASE_URL" ] || [[ "$BASE_URL" =~ $url_re ]] || die "--base-url must be http(s)://host[:port] without path"
  [ -z "$ADMIN_URL" ] || [[ "$ADMIN_URL" =~ $url_re ]] || die "--admin-url must be http(s)://host[:port] without path"
  [ -z "$MAIL_DOMAIN" ] || [[ "$MAIL_DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] || die "invalid --mail-domain"
  [ -z "$MAIL_HOSTNAME" ] || [[ "$MAIL_HOSTNAME" =~ ^[A-Za-z0-9.-]+$ ]] || die "invalid --mail-hostname"
  [ -z "$MAIL_RELAYHOST" ] || [[ "$MAIL_RELAYHOST" =~ ^\[?[A-Za-z0-9.:-]+\]?(:[0-9]+)?$ ]] || die "invalid --mail-relayhost"
  [[ "$DKIM_SELECTOR" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "invalid --dkim-selector"
  [[ "$NODE_CHOICE" =~ ^(auto|system|bundled)$ ]] || die "--node must be auto, system or bundled"
  local url
  for url in "$DATABASE_URL" "$PUBLIC_DATABASE_URL"; do
    [ -z "$url" ] || [[ "$url" =~ ^postgres(ql)?://[^[:space:]\"\']+$ ]] || die "database URLs must start with postgres://"
  done
  if [ "$WITH_POSTFIX" = true ] && [ -z "$MAIL_DOMAIN" ]; then die "--with-postfix needs --mail-domain"; fi
  return 0
}

# --- System -------------------------------------------------------------------------

require_root() { [ "$(id -u)" = 0 ] || die "run as root (sudo $0 $COMMAND ...)"; }

has_systemd() { [ -d /run/systemd/system ]; }

detect_os() {
  [ -r /etc/os-release ] || die "cannot detect the distribution (/etc/os-release missing)"
  local id like
  # shellcheck source=/dev/null
  id="$(. /etc/os-release && printf '%s' "${ID:-}")"
  # shellcheck source=/dev/null
  like="$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")"
  case " $id $like " in
    *" alpine "*) die "Alpine is not supported by the release tarball (musl, OpenRC). Use the container image (docs/guide/en/02-installation.md) or run from source." ;;
    *" debian "* | *" ubuntu "*) OS_FAMILY=debian ;;
    *" rhel "* | *" fedora "* | *" centos "* | *" rocky "* | *" almalinux "*) OS_FAMILY=rhel ;;
    *) die "unsupported distribution '$id' (Debian/Ubuntu or RHEL/Fedora family needed)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) die "unsupported CPU architecture $(uname -m) (x86_64 or aarch64 needed)" ;;
  esac
  if ! getconf GNU_LIBC_VERSION > /dev/null 2>&1; then die "glibc is required"; fi
}

pkg_installed() {
  case "$OS_FAMILY" in
    debian) dpkg-query -W -f='${Status}' "$1" 2> /dev/null | grep -q 'install ok installed' ;;
    rhel) rpm -q "$1" > /dev/null 2>&1 ;;
  esac
}

pkg_install() {
  local missing=() p
  for p in "$@"; do pkg_installed "$p" || missing+=("$p"); done
  [ "${#missing[@]}" -gt 0 ] || return 0
  log "Installing packages: ${missing[*]}"
  case "$OS_FAMILY" in
    debian)
      if [ -z "${APT_UPDATED:-}" ]; then
        DEBIAN_FRONTEND=noninteractive apt-get update -q
        APT_UPDATED=1
      fi
      DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${missing[@]}"
      ;;
    rhel) dnf install -y -q "${missing[@]}" ;;
  esac
}

ensure_tools() {
  local missing=() t
  for t in curl tar gzip; do command -v "$t" > /dev/null 2>&1 || missing+=("$t"); done
  if [ "$OS_FAMILY" = debian ] && [ ! -e /etc/ssl/certs/ca-certificates.crt ]; then missing+=(ca-certificates); fi
  if [ "$OS_FAMILY" = rhel ] && ! command -v useradd > /dev/null 2>&1; then missing+=(shadow-utils); fi
  [ "${#missing[@]}" -eq 0 ] || pkg_install "${missing[@]}"
  for t in sha256sum base64 od runuser getent useradd groupadd; do
    command -v "$t" > /dev/null 2>&1 || die "$t is missing"
  done
}

new_tmp() { [ -n "$TMP" ] || TMP="$(mktemp -d /tmp/openstatuspage-install.XXXXXXXX)"; }

fetch() { curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 20 -o "$2" "$1"; }

rand_b64() { head -c 48 /dev/urandom | base64 | tr -d '\n'; }
rand_hex() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }

ensure_users() {
  local nologin
  nologin="$(command -v nologin || printf '/usr/sbin/nologin')"
  if ! getent group "$APP_USER" > /dev/null; then groupadd --system "$APP_USER"; fi
  if ! getent passwd "$APP_USER" > /dev/null; then
    log "Creating system user $APP_USER"
    useradd --system --gid "$APP_USER" --home-dir "$DATA_DIR" --no-create-home --shell "$nologin" --comment "OpenStatusPage" "$APP_USER"
  fi
  if ! getent group "$PUBLIC_USER" > /dev/null; then groupadd --system "$PUBLIC_USER"; fi
  if ! getent passwd "$PUBLIC_USER" > /dev/null; then
    useradd --system --gid "$PUBLIC_USER" --home-dir /nonexistent --no-create-home --shell "$nologin" --comment "OpenStatusPage public instance" "$PUBLIC_USER"
  fi
}

ensure_dirs() {
  install -d -m 0755 -o root -g root "$PREFIX"
  install -d -m 0750 -o root -g "$APP_USER" "$CONF_DIR"
  install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR"
  # Themes folder (docs/themes.md) and the mount point of the public instance.
  install -d -m 0755 -o root -g root "$CONF_DIR/themes" "$PREFIX/themes"
}

installed_by_package() {
  [ -e "$APP_DIR/bin/openstatuspage" ] || return 1
  if command -v dpkg-query > /dev/null 2>&1 && dpkg-query -S "$APP_DIR/bin/openstatuspage" > /dev/null 2>&1; then return 0; fi
  if command -v rpm > /dev/null 2>&1 && rpm -qf "$APP_DIR/bin/openstatuspage" > /dev/null 2>&1; then return 0; fi
  return 1
}

# --- Node.js ------------------------------------------------------------------------

system_node_ok() {
  local node
  node="$(command -v node 2> /dev/null)" || return 1
  [ "$("$node" -p 'process.versions.node.split(".")[0]' 2> /dev/null)" = 22 ]
}

# Installs the newest Node.js 22 from nodejs.org to /opt/openstatuspage/node,
# checked against the SHA-256 in the release's SHASUMS256.txt.
install_node_runtime() {
  new_tmp
  local base="https://nodejs.org/dist/latest-v22.x" file current
  log "Checking the Node.js 22 runtime (nodejs.org)"
  fetch "$base/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
  file="$(awk -v s="-linux-$ARCH.tar.gz" '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-/ && substr($2, length($2) - length(s) + 1) == s { print $2; exit }' "$TMP/SHASUMS256.txt")"
  [ -n "$file" ] || die "no Node.js 22 build for linux-$ARCH in SHASUMS256.txt"
  current="$("$NODE_DIR/bin/node" --version 2> /dev/null || true)"
  if [ -n "$current" ] && [ "node-$current-linux-$ARCH.tar.gz" = "$file" ]; then
    log "Node.js $current is up to date"
    return 0
  fi
  fetch "$base/$file" "$TMP/$file"
  (cd "$TMP" && awk -v f="$file" '$2 == f' SHASUMS256.txt | sha256sum --check --strict --quiet -) || die "checksum of $file does not match"
  rm -rf -- "$NODE_DIR.new"
  install -d -m 0755 "$NODE_DIR.new"
  tar -xzf "$TMP/$file" -C "$NODE_DIR.new" --strip-components=1 --no-same-owner
  rm -rf -- "$NODE_DIR.old"
  if [ -d "$NODE_DIR" ]; then mv "$NODE_DIR" "$NODE_DIR.old"; fi
  mv "$NODE_DIR.new" "$NODE_DIR"
  rm -rf -- "$NODE_DIR.old"
  log "Installed Node.js $("$NODE_DIR/bin/node" --version) to $NODE_DIR"
}

ensure_node() {
  case "$NODE_CHOICE" in
    system) system_node_ok || die "--node system: 'node' on PATH is not Node.js 22" ;;
    bundled) install_node_runtime ;;
    auto)
      if [ -x "$NODE_DIR/bin/node" ]; then
        install_node_runtime
      elif system_node_ok; then
        log "Using Node.js $(node --version) from $(command -v node)"
      else
        install_node_runtime
      fi
      ;;
  esac
}

# --- Release ------------------------------------------------------------------------

resolve_version() {
  if [ -n "$VERSION" ]; then
    VERSION="${VERSION#v}"
    return 0
  fi
  local url
  url="$(curl -fsSLI --proto '=https' --tlsv1.2 -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")"
  VERSION="${url##*/tag/v}"
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "could not determine the latest release ($url)"
}

# Sets BUNDLE to the extracted release directory, verified against SHA256SUMS.
BUNDLE=""
get_bundle() {
  new_tmp
  local tarball sums name expected actual
  if [ -n "$TARBALL" ]; then
    [ -f "$TARBALL" ] || die "tarball not found: $TARBALL"
    tarball="$TARBALL"
    sums="$(dirname -- "$TARBALL")/SHA256SUMS"
    [ -f "$sums" ] || die "SHA256SUMS not found next to $TARBALL (download it from the same release)"
  else
    resolve_version
    name="openstatuspage-$VERSION-linux-$ARCH.tar.gz"
    log "Downloading $name"
    fetch "https://github.com/$REPO/releases/download/v$VERSION/$name" "$TMP/$name"
    fetch "https://github.com/$REPO/releases/download/v$VERSION/SHA256SUMS" "$TMP/SHA256SUMS"
    tarball="$TMP/$name"
    sums="$TMP/SHA256SUMS"
  fi
  name="$(basename -- "$tarball")"
  [[ "$name" == *"-linux-$ARCH.tar.gz" ]] || die "$name is not a build for linux-$ARCH"
  expected="$(awk -v f="$name" '$2 == f || $2 == "*" f { print $1; exit }' "$sums")"
  [ -n "$expected" ] || die "$name is not listed in $sums"
  actual="$(sha256sum "$tarball" | awk '{ print $1 }')"
  [ "$expected" = "$actual" ] || die "SHA-256 of $name does not match SHA256SUMS"
  log "Checksum of $name verified"
  install -d -m 0700 "$TMP/x"
  tar -xzf "$tarball" -C "$TMP/x" --no-same-owner
  BUNDLE="$TMP/x/${name%.tar.gz}"
  if [ ! -x "$BUNDLE/bin/openstatuspage" ] || [ ! -f "$BUNDLE/VERSION" ]; then die "unexpected tarball layout"; fi
  VERSION="$(cat "$BUNDLE/VERSION")"
}

install_app() {
  log "Installing OpenStatusPage $VERSION to $APP_DIR"
  rm -rf -- "$APP_DIR.new"
  cp -a "$BUNDLE" "$APP_DIR.new"
  chown -R root:root "$APP_DIR.new"
  chmod -R go-w,a+rX "$APP_DIR.new"
  if [ -d "$APP_DIR" ]; then
    rm -rf -- "$APP_DIR.previous"
    mv "$APP_DIR" "$APP_DIR.previous"
  fi
  mv "$APP_DIR.new" "$APP_DIR"
}

install_units() {
  local unit
  for unit in "${UNITS[@]}"; do
    install -m 0644 -o root -g root "$APP_DIR/share/systemd/$unit" "$UNIT_DIR/$unit"
  done
  if has_systemd; then systemctl daemon-reload; fi
}

# --- Settings -----------------------------------------------------------------------

env_has() { grep -Eq "^$1=.+" "$2" 2> /dev/null; }

# Adds KEY=VALUE unless the file sets KEY to a non-empty value already.
env_default() {
  local key="$1" value="$2" file="$3"
  env_has "$key" "$file" && return 0
  sed -i "/^$key=\$/d" "$file"
  printf '%s=%s\n' "$key" "$value" >> "$file"
}

env_get() { sed -n "s/^$1=//p" "$2" 2> /dev/null | tail -n 1; }

new_env_file() {
  local file="$1" group="$2" title="$3"
  if [ ! -f "$file" ]; then
    (
      umask 027
      printf '# %s\n# Written by scripts/install.sh; edit freely, reruns only add missing keys.\n# Reference: docs/configuration.md. Do not set APP_ROLE here.\n' "$title" > "$file"
    )
  fi
  chown root:"$group" "$file"
  chmod 0640 "$file"
}

current_mode() {
  if [ -f "$CONF_DIR/public.env" ]; then printf split; else printf all; fi
}

db_password() {
  # Generated once and kept in a root-only file, so reruns keep the passwords.
  local key="$1"
  if [ ! -f "$DB_SECRETS" ]; then
    (
      umask 077
      printf '# Database passwords generated by scripts/install.sh (root only).\nAPP_DB_PASSWORD=%s\nPUBLIC_DB_PASSWORD=%s\n' "$(rand_hex)" "$(rand_hex)" > "$DB_SECRETS"
    )
  fi
  env_get "$key" "$DB_SECRETS"
}

write_settings() {
  local mode="$1" public_url app_db public_db
  new_env_file "$ENV_FILE" "$APP_USER" "OpenStatusPage settings (admin and worker in split mode)"
  public_url="${BASE_URL:-$(env_get PUBLIC_BASE_URL "$ENV_FILE")}"
  public_url="${public_url:-$(env_get BASE_URL "$ENV_FILE")}"
  public_url="${public_url:-http://localhost:3000}"

  app_db="$DATABASE_URL"
  public_db="$PUBLIC_DATABASE_URL"
  if [ "$WITH_POSTGRES" = true ]; then
    app_db="${app_db:-postgres://osp_app:$(db_password APP_DB_PASSWORD)@127.0.0.1:5432/$DB_NAME}"
    public_db="${public_db:-postgres://osp_public:$(db_password PUBLIC_DB_PASSWORD)@127.0.0.1:5432/$DB_NAME}"
  fi
  if [ -n "$app_db" ] && env_has DATABASE_URL "$ENV_FILE" && [ "$(env_get DATABASE_URL "$ENV_FILE")" != "$app_db" ]; then
    warn "DATABASE_URL in $ENV_FILE is kept; change it by hand to switch databases (data is not moved)"
  fi

  env_default NODE_ENV production "$ENV_FILE"
  env_default HOST 127.0.0.1 "$ENV_FILE"
  env_default TRUST_PROXY 1 "$ENV_FILE"
  env_default SECRET_KEY "$(rand_b64)" "$ENV_FILE"
  env_default DATABASE_URL "${app_db:-sqlite:$DATA_DIR/openstatuspage.db}" "$ENV_FILE"

  if [ "$mode" = all ]; then
    env_default BASE_URL "$public_url" "$ENV_FILE"
    env_default PORT 3000 "$ENV_FILE"
  else
    case "$(env_get DATABASE_URL "$ENV_FILE")" in
      postgres://* | postgresql://*) ;;
      *) die "split mode needs PostgreSQL: use --with-postgres or --database-url and --public-database-url" ;;
    esac
    [ -n "$public_db" ] || [ -f "$CONF_DIR/public.env" ] || die "split mode needs --public-database-url (or --with-postgres)"
    local admin_url
    admin_url="${ADMIN_URL:-$(env_get BASE_URL "$CONF_DIR/admin.env")}"
    [ -n "$admin_url" ] || die "split mode needs --admin-url"
    env_default SUBSCRIPTION_TOKEN_KEY "$(rand_b64)" "$ENV_FILE"
    env_default PUBLIC_BASE_URL "$public_url" "$ENV_FILE"

    new_env_file "$CONF_DIR/admin.env" "$APP_USER" "Admin instance (read after openstatuspage.env)"
    env_default BASE_URL "$admin_url" "$CONF_DIR/admin.env"
    env_default PORT 3001 "$CONF_DIR/admin.env"

    new_env_file "$CONF_DIR/worker.env" "$APP_USER" "Worker (read after openstatuspage.env); its port serves /api/health only"
    env_default BASE_URL "$public_url" "$CONF_DIR/worker.env"
    env_default PORT 3002 "$CONF_DIR/worker.env"

    # The public instance gets only what it needs: never SECRET_KEY, the admin
    # password, SMTP credentials or the owner database login.
    new_env_file "$CONF_DIR/public.env" "$PUBLIC_USER" "Public instance (the only settings it reads)"
    env_default NODE_ENV production "$CONF_DIR/public.env"
    env_default HOST 127.0.0.1 "$CONF_DIR/public.env"
    env_default PORT 3000 "$CONF_DIR/public.env"
    env_default TRUST_PROXY 1 "$CONF_DIR/public.env"
    env_default BASE_URL "$public_url" "$CONF_DIR/public.env"
    env_default WORKER_ENABLED false "$CONF_DIR/public.env"
    env_default SUBSCRIPTION_TOKEN_KEY "$(env_get SUBSCRIPTION_TOKEN_KEY "$ENV_FILE")" "$CONF_DIR/public.env"
    [ -z "$public_db" ] || env_default DATABASE_URL "$public_db" "$CONF_DIR/public.env"
  fi
}

write_mail_settings() {
  local from="Status <status@$MAIL_DOMAIN>"
  env_default SMTP_HOST 127.0.0.1 "$ENV_FILE"
  env_default SMTP_PORT 25 "$ENV_FILE"
  env_default SMTP_FROM "\"$from\"" "$ENV_FILE"
  env_default MAIL_DKIM_DIR "$DKIM_PUBLIC_DIR" "$ENV_FILE"
  if [ -f "$CONF_DIR/public.env" ]; then
    env_default MAIL_TRANSPORT smtp "$CONF_DIR/public.env"
    env_default SMTP_FROM "\"$from\"" "$CONF_DIR/public.env"
  fi
}

# --- PostgreSQL ---------------------------------------------------------------------

as_postgres() { (cd / && runuser -u postgres -- "$@"); }

setup_postgres() {
  log "Setting up PostgreSQL"
  case "$OS_FAMILY" in
    debian) pkg_install postgresql ;;
    rhel)
      # RHEL 9 defaults to PostgreSQL 13, which lacks security_invoker views
      # (docs/security-model.md): prefer a newer module stream when there is one.
      if ! pkg_installed postgresql-server && command -v dnf > /dev/null 2>&1; then
        local stream
        for stream in 16 15; do
          if dnf -q module list postgresql 2> /dev/null | grep -Eq "^postgresql +$stream( |$)"; then
            log "Enabling the PostgreSQL $stream module stream"
            dnf -y -q module enable "postgresql:$stream"
            break
          fi
        done
      fi
      pkg_install postgresql-server postgresql
      if [ ! -f /var/lib/pgsql/data/PG_VERSION ]; then postgresql-setup --initdb; fi
      ;;
  esac
  has_systemd || die "--with-postgres needs systemd to run PostgreSQL"
  systemctl enable --now postgresql
  local i
  for i in $(seq 1 30); do
    as_postgres psql -XtAc 'SELECT 1' > /dev/null 2>&1 && break
    [ "$i" = 30 ] && die "PostgreSQL does not answer"
    sleep 1
  done
  if [ "$(as_postgres psql -XtAc 'SHOW server_version_num')" -lt 150000 ]; then
    warn "PostgreSQL older than 15: the public role gets owner-rights views instead of security_invoker views (15 or newer is recommended, see docs/security-model.md)"
  fi
  if [ "$(as_postgres psql -XtAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")" != 1 ]; then
    as_postgres createdb "$DB_NAME"
  fi
  # roles.sql through stdin, so the passwords do not show up in the process list.
  # \i runs the file itself, so its \ir harden.sql resolves next to it.
  {
    printf "\\\\set public_password '%s'\n" "$(db_password PUBLIC_DB_PASSWORD)"
    printf "\\\\set app_password '%s'\n" "$(db_password APP_DB_PASSWORD)"
    printf '\\i %s\n' "$APP_DIR/share/postgres/roles.sql"
  } | as_postgres env 'PGOPTIONS=-c password_encryption=scram-sha-256' psql -X -q -v ON_ERROR_STOP=1 -d "$DB_NAME" -f -

  # Password logins of the two roles over the loopback interface.
  local hba
  hba="$(as_postgres psql -XtAc 'SHOW hba_file')"
  if ! grep -q '^# openstatuspage (scripts/install.sh)' "$hba"; then
    {
      printf '# openstatuspage (scripts/install.sh)\n'
      printf 'host %s osp_app,osp_public 127.0.0.1/32 scram-sha-256\n' "$DB_NAME"
      printf 'host %s osp_app,osp_public ::1/128 scram-sha-256\n' "$DB_NAME"
      cat "$hba"
    } > "$hba.openstatuspage"
    cat "$hba.openstatuspage" > "$hba"
    rm -f -- "$hba.openstatuspage"
    as_postgres psql -XtAc 'SELECT pg_reload_conf()' > /dev/null
  fi
}

# --- Postfix ------------------------------------------------------------------------

setup_postfix() {
  local hostname="${MAIL_HOSTNAME:-$MAIL_DOMAIN}" marker="$CONF_DIR/.postfix-managed"
  log "Setting up a send-only Postfix with OpenDKIM for $MAIL_DOMAIN"
  if [ ! -f "$marker" ]; then
    # Never take over a mail server that someone else configured.
    local other
    for other in exim4-base exim4 sendmail opensmtpd; do
      if pkg_installed "$other"; then die "$other is installed: configure it to relay for 127.0.0.1 and set SMTP_* by hand instead of --with-postfix"; fi
    done
    if pkg_installed postfix; then die "Postfix is already installed and not managed by this script: set SMTP_* by hand instead of --with-postfix"; fi
    touch "$marker"
  fi
  case "$OS_FAMILY" in
    debian)
      printf 'postfix postfix/main_mailer_type select Internet Site\npostfix postfix/mailname string %s\n' "$hostname" | debconf-set-selections
      pkg_install postfix opendkim opendkim-tools
      ;;
    rhel)
      if ! dnf -q list opendkim > /dev/null 2>&1; then
        log "OpenDKIM is in EPEL: enabling it"
        pkg_install epel-release
      fi
      # EPEL's OpenDKIM needs libmemcached.so.11 from CodeReady Builder (CRB).
      if ! dnf -q repolist --enabled 2> /dev/null | grep -Eiq '(^| )(crb|codeready-builder)'; then
        log "OpenDKIM needs CodeReady Builder (CRB): enabling it"
        if command -v crb > /dev/null 2>&1; then
          crb enable
        else
          pkg_install dnf-plugins-core
          dnf config-manager --set-enabled crb
        fi
      fi
      pkg_install postfix opendkim opendkim-tools
      ;;
  esac

  # Every local process can reach 127.0.0.1:25, so relaying is limited to
  # senders of MAIL_DOMAIN, only mail received over SMTP is signed (no milter
  # for the sendmail command), and only root may use sendmail. The host must
  # still be single-tenant: any local user can submit over SMTP.
  postconf -e \
    'inet_interfaces = loopback-only' \
    'mynetworks = 127.0.0.0/8 [::1]/128' \
    "myhostname = $hostname" \
    "myorigin = $MAIL_DOMAIN" \
    'mydestination =' \
    'relay_domains =' \
    'local_transport = error:local delivery is disabled' \
    'smtpd_relay_restrictions = permit_mynetworks, reject' \
    'smtpd_recipient_restrictions = permit_mynetworks, reject' \
    "smtpd_sender_restrictions = check_sender_access inline:{ $MAIL_DOMAIN=OK }, reject" \
    'authorized_submit_users = root' \
    'smtpd_tls_security_level = none' \
    'smtp_tls_security_level = may' \
    'disable_vrfy_command = yes' \
    'milter_protocol = 6' \
    'milter_default_action = accept' \
    'smtpd_milters = inet:127.0.0.1:8891'
  # Older runs of this script also signed mail from the sendmail command.
  postconf -X non_smtpd_milters
  [ -z "$MAIL_RELAYHOST" ] || postconf -e "relayhost = $MAIL_RELAYHOST"

  # DKIM key, generated once.
  local keydir="/etc/opendkim/keys/$MAIL_DOMAIN"
  install -d -m 0750 -o opendkim -g opendkim /etc/opendkim/keys "$keydir"
  if [ ! -f "$keydir/$DKIM_SELECTOR.private" ]; then
    log "Generating the DKIM key ($DKIM_SELECTOR._domainkey.$MAIL_DOMAIN)"
    opendkim-genkey -b 2048 -d "$MAIL_DOMAIN" -s "$DKIM_SELECTOR" -D "$keydir"
  fi
  chown -R opendkim:opendkim "$keydir"
  chmod 0600 "$keydir/$DKIM_SELECTOR.private"
  if [ -f /etc/opendkim.conf ] && [ ! -f /etc/opendkim.conf.orig-openstatuspage ]; then
    cp -p /etc/opendkim.conf /etc/opendkim.conf.orig-openstatuspage
  fi
  cat > /etc/opendkim.conf << EOF
# Written by OpenStatusPage scripts/install.sh: signs the mails of $MAIL_DOMAIN.
# The original file is /etc/opendkim.conf.orig-openstatuspage.
Syslog                  yes
UMask                   007
Mode                    s
Canonicalization        relaxed/simple
Domain                  $MAIL_DOMAIN
Selector                $DKIM_SELECTOR
KeyFile                 $keydir/$DKIM_SELECTOR.private
Socket                  inet:8891@127.0.0.1
PidFile                 /run/opendkim/opendkim.pid
UserID                  opendkim
OversignHeaders         From
EOF
  # The same start command on Debian and RHEL, whatever their defaults say.
  install -d -m 0755 /etc/systemd/system/opendkim.service.d
  cat > /etc/systemd/system/opendkim.service.d/zz-openstatuspage.conf << 'EOF'
# Written by OpenStatusPage scripts/install.sh.
[Service]
Type=forking
PIDFile=/run/opendkim/opendkim.pid
RuntimeDirectory=opendkim
ExecStart=
ExecStart=/usr/sbin/opendkim -x /etc/opendkim.conf -P /run/opendkim/opendkim.pid
EOF

  # Only the public key goes where the app reads it (MAIL_DKIM_DIR).
  install -d -m 0755 -o root -g root "$DKIM_PUBLIC_DIR"
  install -m 0644 -o root -g root "$keydir/$DKIM_SELECTOR.txt" "$DKIM_PUBLIC_DIR/$MAIL_DOMAIN.$DKIM_SELECTOR.txt"

  if has_systemd; then
    systemctl daemon-reload
    systemctl enable opendkim postfix
    systemctl restart opendkim postfix
  else
    warn "no systemd: start opendkim and postfix yourself"
  fi
  write_mail_settings
}

# --- Services -----------------------------------------------------------------------

health_check() {
  local port="${1:-3000}" i
  for i in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$port/api/health"; then
      log "Health check on port $port passed"
      return 0
    fi
    [ "$i" = 60 ] || sleep 1
  done
  warn "no answer from http://127.0.0.1:$port/api/health; see: journalctl -u 'openstatuspage*'"
  return 1
}

start_services() {
  local mode="$1"
  if [ "$START" = false ]; then
    log "Not starting (--no-start)"
    return 0
  fi
  if ! has_systemd; then
    warn "systemd is not running: start the service yourself"
    return 0
  fi
  if [ "$mode" = all ]; then
    systemctl disable --now openstatuspage-split.target > /dev/null 2>&1 || true
    systemctl enable openstatuspage.service
    systemctl restart openstatuspage.service
    health_check "$(env_get PORT "$ENV_FILE")"
  else
    systemctl disable --now openstatuspage.service > /dev/null 2>&1 || true
    systemctl enable openstatuspage-split.target
    systemctl restart openstatuspage-admin.service
    health_check "$(env_get PORT "$CONF_DIR/admin.env")"
    systemctl restart openstatuspage-worker.service openstatuspage-public.service
    systemctl start openstatuspage-split.target
    health_check "$(env_get PORT "$CONF_DIR/public.env")"
  fi
}

restart_active() {
  has_systemd || return 0
  local unit restarted=false
  for unit in openstatuspage-admin.service openstatuspage.service openstatuspage-worker.service openstatuspage-public.service; do
    if systemctl is-active --quiet "$unit"; then
      systemctl restart "$unit"
      restarted=true
    fi
  done
  if [ "$restarted" = true ]; then
    if [ "$(current_mode)" = split ]; then
      health_check "$(env_get PORT "$CONF_DIR/public.env")"
    else
      health_check "$(env_get PORT "$ENV_FILE")"
    fi
  fi
}

# --- Commands -----------------------------------------------------------------------

cmd_install() {
  require_root
  detect_os
  validate_args
  installed_by_package && die "OpenStatusPage was installed from a package: use apt/dnf, or remove the package first"
  ensure_tools
  local mode
  mode="${MODE:-$(current_mode)}"
  if [ "$mode" = split ] && [ "$WITH_POSTGRES" = false ] && [ -z "$DATABASE_URL" ] && ! env_has DATABASE_URL "$ENV_FILE"; then
    die "split mode needs PostgreSQL: add --with-postgres or --database-url/--public-database-url"
  fi
  ensure_users
  ensure_dirs
  ensure_node
  get_bundle
  install_app
  install_units
  [ "$WITH_POSTGRES" = false ] || setup_postgres
  write_settings "$mode"
  [ "$WITH_POSTFIX" = false ] || setup_postfix
  start_services "$mode"
  log "Done. OpenStatusPage $VERSION ($mode mode)."
  printf '\n  Settings: %s\n  Data:     %s\n  Logs:     journalctl -u '"'"'openstatuspage*'"'"'\n' "$CONF_DIR" "$DATA_DIR"
  printf '  Next:     set ADMIN_EMAIL/ADMIN_PASSWORD (or use create-user), put a reverse\n            proxy in front (%s/share/proxy) and restart the service.\n' "$APP_DIR"
  if [ "$WITH_POSTFIX" = true ]; then
    printf '  Mail:     publish the DNS records shown in Settings -> Email delivery.\n'
  fi
}

cmd_update() {
  require_root
  detect_os
  validate_args
  [ -x "$APP_DIR/bin/openstatuspage" ] || die "OpenStatusPage is not installed in $APP_DIR (use: $0 install)"
  installed_by_package && die "OpenStatusPage was installed from a package: update it with apt/dnf"
  ensure_tools
  local old
  old="$(cat "$APP_DIR/VERSION" 2> /dev/null || printf unknown)"
  if [ -z "$TARBALL" ]; then
    resolve_version
    # Reinstalling the same release would replace app.previous with a copy of
    # it, and rollback could no longer return to the release before.
    if [ "$VERSION" = "$old" ]; then
      log "OpenStatusPage $VERSION is already installed (Node.js updates: $0 node)"
      return 0
    fi
  fi
  ensure_node
  get_bundle
  install_app
  install_units
  restart_active || die "the new release does not answer; '$0 rollback' returns to $old (database migrations are not undone)"
  log "Updated OpenStatusPage $old -> $VERSION"
}

cmd_rollback() {
  require_root
  [ -d "$APP_DIR.previous" ] || die "no previous release in $APP_DIR.previous"
  installed_by_package && die "installed from a package: use apt/dnf to install another version"
  local from to
  from="$(cat "$APP_DIR/VERSION" 2> /dev/null || printf unknown)"
  to="$(cat "$APP_DIR.previous/VERSION" 2> /dev/null || printf unknown)"
  mv "$APP_DIR" "$APP_DIR.rollback"
  mv "$APP_DIR.previous" "$APP_DIR"
  mv "$APP_DIR.rollback" "$APP_DIR.previous"
  install_units
  restart_active || true
  log "Rolled back $from -> $to. A release whose migrations ran may need the newer schema."
}

cmd_uninstall() {
  require_root
  installed_by_package && die "installed from a package: remove it with apt/dnf"
  local unit
  if has_systemd; then
    for unit in "${UNITS[@]}"; do systemctl disable --now "$unit" > /dev/null 2>&1 || true; done
  fi
  for unit in "${UNITS[@]}"; do rm -f -- "$UNIT_DIR/$unit"; done
  if has_systemd; then systemctl daemon-reload; fi
  rm -rf -- "$APP_DIR" "$APP_DIR.previous" "$APP_DIR.new" "$NODE_DIR"
  rmdir -- "$PREFIX" 2> /dev/null || true
  log "OpenStatusPage was removed. Kept: settings ($CONF_DIR), data ($DATA_DIR), the users"
  log "$APP_USER and $PUBLIC_USER, and PostgreSQL/Postfix if this script set them up."
}

cmd_node() {
  require_root
  detect_os
  ensure_tools
  install_node_runtime
}

main() {
  parse_args "$@"
  case "$COMMAND" in
    install) cmd_install ;;
    update) cmd_update ;;
    rollback) cmd_rollback ;;
    uninstall) cmd_uninstall ;;
    node) cmd_node ;;
    help | -h | --help) usage ;;
    *) die "unknown command '$COMMAND' (install, update, rollback, uninstall, node, help)" ;;
  esac
}

main "$@"

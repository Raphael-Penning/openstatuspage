#!/usr/bin/env bash
# Builds the release tarball openstatuspage-<version>-linux-<arch>.tar.gz for
# the installation without containers (scripts/install.sh, docs/releasing.md).
#
#   scripts/build-bundle.sh [version]
#
# Runs on Linux (GNU tar) for the architecture of the machine: the production
# dependencies contain native modules (argon2, better-sqlite3) that are built
# or downloaded for it. CI builds in a node:22-bullseye container (glibc 2.31),
# so the result runs on Debian 11+, Ubuntu 22.04+ and RHEL 9+.
#
# Layout (the same as the container image, plus the deployment files):
#   bin/openstatuspage        launcher (deploy/bare-metal/openstatuspage)
#   server/                   production node_modules and dist/
#   web/                      the built web client
#   share/systemd/            units (deploy/bare-metal/systemd)
#   share/postgres/           roles.sql, harden.sql
#   share/proxy/              Caddy and nginx templates
#   share/openstatuspage.env.example
#   scripts/install.sh, VERSION, LICENSE, README.md
#
# Output: dist/release/ (OUT_DIR overrides it).
set -euo pipefail

root="$(cd "$(dirname -- "$0")/.." && pwd -P)"
cd "$root"
version="${1:-$(node -p 'require("./package.json").version')}"
version="${version#v}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || {
  echo "invalid version: $version" >&2
  exit 1
}
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *)
    echo "unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac
[ "$(uname -s)" = Linux ] || {
  echo "build the bundle on Linux (native modules, GNU tar)" >&2
  exit 1
}
[ "$(node -p 'process.versions.node.split(".")[0]')" = 22 ] || {
  echo "Node.js 22 is required (the native modules are built for its ABI)" >&2
  exit 1
}

out="${OUT_DIR:-$root/dist/release}"
name="openstatuspage-$version-linux-$arch"
stage="$(mktemp -d)"
trap 'rm -rf -- "$stage"' EXIT
app="$stage/$name"

pnpm install --frozen-lockfile
pnpm build
pnpm --filter @openstatuspage/server deploy --prod --legacy "$app/server"
rm -rf -- "$app/server/dist"
cp -R apps/server/dist "$app/server/dist"
cp -R apps/web/dist "$app/web"

install -d "$app/bin" "$app/share/systemd" "$app/share/postgres" "$app/share/proxy" "$app/scripts"
install -m 0755 deploy/bare-metal/openstatuspage "$app/bin/openstatuspage"
install -m 0644 deploy/bare-metal/systemd/openstatuspage*.service deploy/bare-metal/systemd/openstatuspage-split.target "$app/share/systemd/"
install -m 0644 deploy/bare-metal/openstatuspage.env.example "$app/share/openstatuspage.env.example"
install -m 0644 deploy/postgres/roles.sql deploy/postgres/harden.sql "$app/share/postgres/"
install -m 0644 deploy/proxy/* "$app/share/proxy/"
install -m 0755 scripts/install.sh "$app/scripts/install.sh"
install -m 0644 LICENSE README.md "$app/"
printf '%s\n' "$version" > "$app/VERSION"

# Smoke test: the launcher finds Node.js and the server bundle loads its native modules.
"$app/bin/openstatuspage" version > /dev/null
(cd "$app/server" && node -e 'require("better-sqlite3"); require("@node-rs/argon2")')

mkdir -p "$out"
# Stable file order, owner and times: the same input gives the same archive.
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@${SOURCE_DATE_EPOCH:-0}" \
  -C "$stage" -czf "$out/$name.tar.gz" "$name"
echo "$out/$name.tar.gz"

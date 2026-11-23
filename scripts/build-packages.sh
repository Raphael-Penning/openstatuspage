#!/usr/bin/env bash
# Builds the .deb and .rpm packages from release tarballs with nfpm
# (deploy/bare-metal/nfpm.yaml). The packages contain exactly the tarball.
#
#   scripts/build-packages.sh dist/release/openstatuspage-<version>-linux-<arch>.tar.gz ...
#
# Needs nfpm on PATH (CI installs a pinned, checksum-verified release). Output:
# next to the tarballs (OUT_DIR overrides it).
set -euo pipefail

root="$(cd "$(dirname -- "$0")/.." && pwd -P)"
[ "$#" -gt 0 ] || {
  echo "usage: $0 <tarball>..." >&2
  exit 2
}
command -v nfpm > /dev/null || {
  echo "nfpm not found" >&2
  exit 1
}
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

for tarball in "$@"; do
  file="$(basename -- "$tarball")"
  if [[ ! "$file" =~ ^openstatuspage-([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)-linux-(x64|arm64)\.tar\.gz$ ]]; then
    echo "unexpected tarball name: $file" >&2
    exit 1
  fi
  version="${BASH_REMATCH[1]}"
  case "${BASH_REMATCH[3]}" in
    x64) arch=amd64 ;;
    arm64) arch=arm64 ;;
  esac
  out="${OUT_DIR:-$(cd "$(dirname -- "$tarball")" && pwd -P)}"
  dir="$work/$version-$arch"
  mkdir -p "$dir"
  tar -xzf "$tarball" -C "$dir" --no-same-owner
  bundle="$dir/${file%.tar.gz}"
  [ -x "$bundle/bin/openstatuspage" ] || {
    echo "unexpected tarball layout: $file" >&2
    exit 1
  }
  sed -e "s|@VERSION@|$version|g" -e "s|@ARCH@|$arch|g" -e "s|@BUNDLE@|$bundle|g" \
    -e "s|@SCRIPTS@|$root/deploy/bare-metal/package|g" \
    "$root/deploy/bare-metal/nfpm.yaml" > "$dir/nfpm.yaml"
  for packager in deb rpm; do
    nfpm package --config "$dir/nfpm.yaml" --packager "$packager" --target "$out/"
  done
done
ls -l "${OUT_DIR:-$(cd "$(dirname -- "$1")" && pwd -P)}"

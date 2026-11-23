#!/bin/sh
# .deb/.rpm preinstall: the system users of the services (idempotent).
set -e

nologin="$(command -v nologin || printf '/usr/sbin/nologin')"
if ! getent group openstatuspage > /dev/null; then groupadd --system openstatuspage; fi
if ! getent passwd openstatuspage > /dev/null; then
  useradd --system --gid openstatuspage --home-dir /var/lib/openstatuspage --no-create-home \
    --shell "$nologin" --comment "OpenStatusPage" openstatuspage
fi
# The public instance of the split deployment runs as its own user, which cannot
# read the main settings file (SECRET_KEY).
if ! getent group openstatuspage-public > /dev/null; then groupadd --system openstatuspage-public; fi
if ! getent passwd openstatuspage-public > /dev/null; then
  useradd --system --gid openstatuspage-public --home-dir /nonexistent --no-create-home \
    --shell "$nologin" --comment "OpenStatusPage public instance" openstatuspage-public
fi
exit 0

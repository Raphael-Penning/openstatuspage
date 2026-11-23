#!/bin/sh
# .deb/.rpm preremove: stops and disables the services when the package is
# removed, not on an upgrade.
#   deb: prerm remove|upgrade|deconfigure|failed-upgrade   rpm: %preun <count> (0 = erase)
set -e

case "${1:-}" in
  remove | 0)
    if [ -d /run/systemd/system ]; then
      systemctl disable --now openstatuspage-split.target openstatuspage.service \
        openstatuspage-public.service openstatuspage-admin.service openstatuspage-worker.service \
        > /dev/null 2>&1 || true
    fi
    ;;
esac
exit 0

#!/bin/sh
# .deb/.rpm postremove. Settings (/etc/openstatuspage), data
# (/var/lib/openstatuspage) and the users are kept, also on purge: delete
# them by hand when you no longer need them.
set -e

if [ -d /run/systemd/system ]; then systemctl daemon-reload || true; fi
case "${1:-}" in
  remove | purge | 0)
    echo "OpenStatusPage removed. Kept: /etc/openstatuspage, /var/lib/openstatuspage and the users openstatuspage, openstatuspage-public."
    ;;
esac
exit 0

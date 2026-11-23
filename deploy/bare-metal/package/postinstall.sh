#!/bin/sh
# .deb/.rpm postinstall. Creates the directories and, on the first install, the
# settings file with a generated SECRET_KEY. Existing settings and data are
# never changed. Services are not enabled or started on a new install; an
# upgrade restarts the services that are running.
#   deb: postinst configure [<old version>]   rpm: %post <count> (1 install, 2+ upgrade)
set -e

conf=/etc/openstatuspage
env_file=/etc/openstatuspage/openstatuspage.env

install -d -m 0750 -o root -g openstatuspage "$conf"
install -d -m 0750 -o openstatuspage -g openstatuspage /var/lib/openstatuspage
# Themes folder (docs/themes.md) and the mount point of the public instance.
install -d -m 0755 -o root -g root "$conf/themes" /opt/openstatuspage/themes

if [ ! -e "$env_file" ]; then
  key="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
  (
    umask 027
    sed "s|^SECRET_KEY=\$|SECRET_KEY=$key|" /opt/openstatuspage/app/share/openstatuspage.env.example > "$env_file"
  )
  chown root:openstatuspage "$env_file"
  chmod 0640 "$env_file"
fi

upgrade=false
case "${1:-}" in
  configure) [ -n "${2:-}" ] && upgrade=true ;;
  [2-9] | [1-9][0-9]*) upgrade=true ;;
esac

if [ -d /run/systemd/system ]; then
  systemctl daemon-reload || true
  if [ "$upgrade" = true ]; then
    systemctl try-restart openstatuspage.service openstatuspage-admin.service \
      openstatuspage-worker.service openstatuspage-public.service || true
  fi
fi

if [ "$upgrade" = false ]; then
  node_ok=false
  if [ -x /opt/openstatuspage/node/bin/node ]; then
    node_ok=true
  elif command -v node > /dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" = 22 ]; then
    node_ok=true
  fi
  cat << EOF

OpenStatusPage is installed but not started.
  1. Edit $env_file (BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, DATABASE_URL, mail).
  2. systemctl enable --now openstatuspage
     (split deployment: see docs/guide/en/13-installation-without-containers.md)
  3. Put a reverse proxy in front: /opt/openstatuspage/app/share/proxy
EOF
  if [ "$node_ok" = false ]; then
    cat << 'EOF'
Node.js 22 was not found. Install it from your distribution or NodeSource, or
run: /opt/openstatuspage/app/scripts/install.sh node
EOF
  fi
fi
exit 0

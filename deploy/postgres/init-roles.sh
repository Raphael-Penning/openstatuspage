#!/bin/sh
# Database init script of deploy/compose/compose.split.yaml. The official
# PostgreSQL image runs it once, when the data volume is created: it applies
# roles.sql, which creates the public role (password POSTGRES_PUBLIC_PASSWORD)
# and the app role osp_app of the admin and worker instances (password
# POSTGRES_APP_PASSWORD, not a superuser), and hardens the database.
# To change a password later, rerun this script (roles.sql is idempotent).
#
# The image runs this file as a program when it is executable (as in git) and
# sources it otherwise, so it sets no shell options and ends with `exit 1` on
# error in both cases. Run it by hand with `sh`, which works without the
# executable bit too:
#
#   docker compose -f compose.split.yaml exec db sh /docker-entrypoint-initdb.d/10-roles.sh
ROLES_SQL="${ROLES_SQL:-/osp-postgres/roles.sql}"
: "${POSTGRES_PUBLIC_PASSWORD:?POSTGRES_PUBLIC_PASSWORD is not set}"
: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD is not set}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v public_password="$POSTGRES_PUBLIC_PASSWORD" -v app_password="$POSTGRES_APP_PASSWORD" \
  -f "$ROLES_SQL" || exit 1

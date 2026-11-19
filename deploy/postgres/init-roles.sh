#!/bin/sh
# Database init script of deploy/compose/compose.split.yaml. The official
# PostgreSQL image runs it once, when the data volume is created: it applies
# roles.sql with the password of the public role from POSTGRES_PUBLIC_PASSWORD.
# To change that password later, rerun roles.sql by hand (it is idempotent):
#
#   psql -v ON_ERROR_STOP=1 -v public_password='<new password>' -f deploy/postgres/roles.sql
#
# The image sources this file (it is not executable), so it does not set shell
# options: a failing command ends the init with an error.
ROLES_SQL="${ROLES_SQL:-/osp-postgres/roles.sql}"
: "${POSTGRES_PUBLIC_PASSWORD:?POSTGRES_PUBLIC_PASSWORD is not set}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v public_password="$POSTGRES_PUBLIC_PASSWORD" -f "$ROLES_SQL" || exit 1

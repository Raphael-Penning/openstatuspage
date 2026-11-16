#!/bin/sh
# OpenStatusPage notification script for Icinga 2.
#
# Sends a host or service state change to the OpenStatusPage ingest API
# (POST <base>/api/ingest/<source-id>/icinga2). Requires: POSIX sh, curl, sed, awk, tr.
#
# Every value is read from environment variables (set them in the `env` block
# of the NotificationCommand, see openstatuspage.conf in this directory):
#
#   OSP_URL                   ingest URL, e.g. https://status.example.com/api/ingest/<source-id>/icinga2
#   OSP_TOKEN                 ingest token of the monitoring source
#   OSP_TYPE                  "host" or "service"
#   OSP_HOST                  $host.name$
#   OSP_HOST_DISPLAY_NAME     $host.display_name$            (optional)
#   OSP_SERVICE               $service.name$                 (services only)
#   OSP_SERVICE_DISPLAY_NAME  $service.display_name$         (optional)
#   OSP_STATE                 $host.state$ / $service.state$
#   OSP_STATE_ID              $host.state_id$ / $service.state_id$ (optional, preferred)
#   OSP_OUTPUT                $host.output$ / $service.output$  (optional)
#   OSP_TIMESTAMP             $icinga.timet$                 (optional)
#   OSP_NOTIFICATION_TYPE     $notification.type$            (optional)
#
# Optional:
#   OSP_CONFIG     file with OSP_URL=... and OSP_TOKEN=... lines (keeps the token out of
#                  the Icinga configuration); values from the environment take precedence
#   OSP_INSECURE   set to 1 to skip TLS certificate verification (self-signed certificates)
#   OSP_CURL_OPTS  extra curl options, e.g. "--cacert /etc/ssl/certs/internal-ca.pem"
#   OSP_TIMEOUT    request timeout in seconds (default 10)
#   OSP_DRY_RUN    set to 1 to print the JSON payload instead of sending it
#
# Exit codes: 0 sent, 1 rejected by the server / network error, 3 usage or configuration error.

set -u

die() {
  echo "openstatuspage-notify: $*" >&2
  exit 3
}

# Reads OSP_URL / OSP_TOKEN / OSP_INSECURE from a KEY=VALUE file without executing it.
read_config() {
  [ -r "$1" ] || die "cannot read config file $1"
  while IFS='=' read -r key value || [ -n "$key" ]; do
    value=$(printf '%s' "$value" | tr -d '\r')
    value=${value#\"}
    value=${value%\"}
    case $key in
      OSP_URL) [ -n "${OSP_URL:-}" ] || OSP_URL=$value ;;
      OSP_TOKEN) [ -n "${OSP_TOKEN:-}" ] || OSP_TOKEN=$value ;;
      OSP_INSECURE) [ -n "${OSP_INSECURE:-}" ] || OSP_INSECURE=$value ;;
    esac
  done < "$1"
}

# Escapes a string for use inside a JSON string literal.
json_escape() {
  printf '%s' "$1" \
    | tr -d '\000-\010\013\014\015\016-\037' \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' \
    | awk 'NR > 1 { printf "%s", "\\n" } { printf "%s", $0 }'
}

PAYLOAD=""
add_field() {
  [ -n "$2" ] || return 0
  PAYLOAD="$PAYLOAD,\"$1\":\"$(json_escape "$2")\""
}

[ -n "${OSP_CONFIG:-}" ] && read_config "$OSP_CONFIG"

OSP_TYPE=${OSP_TYPE:-}
OSP_HOST=${OSP_HOST:-}
OSP_SERVICE=${OSP_SERVICE:-}
OSP_STATE=${OSP_STATE:-}
OSP_STATE_ID=${OSP_STATE_ID:-}

if [ -z "$OSP_TYPE" ]; then
  if [ -n "$OSP_SERVICE" ]; then OSP_TYPE=service; else OSP_TYPE=host; fi
fi
case $OSP_TYPE in
  host | service) ;;
  *) die "OSP_TYPE must be 'host' or 'service'" ;;
esac
[ -n "$OSP_HOST" ] || die "OSP_HOST is required"
[ "$OSP_TYPE" = host ] || [ -n "$OSP_SERVICE" ] || die "OSP_SERVICE is required for service notifications"
[ -n "$OSP_STATE" ] || [ -n "$OSP_STATE_ID" ] || die "OSP_STATE or OSP_STATE_ID is required"

PAYLOAD="{\"type\":\"$OSP_TYPE\""
add_field host "$OSP_HOST"
add_field hostDisplayName "${OSP_HOST_DISPLAY_NAME:-}"
if [ "$OSP_TYPE" = service ]; then
  add_field service "$OSP_SERVICE"
  add_field displayName "${OSP_SERVICE_DISPLAY_NAME:-}"
fi
add_field state "$OSP_STATE"
add_field stateId "$OSP_STATE_ID"
add_field output "${OSP_OUTPUT:-}"
add_field timestamp "${OSP_TIMESTAMP:-}"
add_field notificationType "${OSP_NOTIFICATION_TYPE:-}"
PAYLOAD="$PAYLOAD}"

if [ "${OSP_DRY_RUN:-0}" = 1 ]; then
  printf '%s\n' "$PAYLOAD"
  exit 0
fi

[ -n "${OSP_URL:-}" ] || die "OSP_URL is required"
[ -n "${OSP_TOKEN:-}" ] || die "OSP_TOKEN is required"
command -v curl > /dev/null 2>&1 || die "curl is not installed"

INSECURE=""
[ "${OSP_INSECURE:-0}" = 1 ] && INSECURE="--insecure"

# The token is passed to curl on stdin (-K -) so it does not show up in the process list.
# OSP_CURL_OPTS and INSECURE are intentionally unquoted to allow several options.
# shellcheck disable=SC2086
HTTP_CODE=$(printf 'header = "Authorization: Bearer %s"\n' "$OSP_TOKEN" | curl -K - \
  --silent --show-error \
  --max-time "${OSP_TIMEOUT:-10}" \
  --retry 2 \
  --output /dev/null \
  --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --data-binary "$PAYLOAD" \
  $INSECURE ${OSP_CURL_OPTS:-} \
  "$OSP_URL")
CURL_EXIT=$?

if [ "$CURL_EXIT" -ne 0 ]; then
  echo "openstatuspage-notify: request failed (curl exit code $CURL_EXIT)" >&2
  exit 1
fi
case $HTTP_CODE in
  2??) exit 0 ;;
  *)
    echo "openstatuspage-notify: server responded with HTTP $HTTP_CODE" >&2
    exit 1
    ;;
esac

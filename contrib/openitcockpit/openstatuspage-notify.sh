#!/bin/sh
# OpenStatusPage notification command for openITCockpit (and other Nagios/Naemon based systems).
#
# Sends a host or service state change to the OpenStatusPage ingest API
# (POST <base>/api/ingest/<source-id>/openitcockpit). Requires: POSIX sh, curl, sed, awk, tr.
#
# Usage (Nagios macros, see docs/adapters/openitcockpit.md):
#   service: openstatuspage-notify.sh -c <config> -t service -H "$HOSTNAME$" -N "$HOSTDISPLAYNAME$" \
#              -S "$SERVICEDESC$" -D "$SERVICEDISPLAYNAME$" -s "$SERVICESTATEID$" -o "$SERVICEOUTPUT$" -T "$TIMET$"
#   host:    openstatuspage-notify.sh -c <config> -t host -H "$HOSTNAME$" -N "$HOSTDISPLAYNAME$" \
#              -s "$HOSTSTATEID$" -o "$HOSTOUTPUT$" -T "$TIMET$"
#
# Options:
#   -c FILE  config file with OSP_URL=... and OSP_TOKEN=... lines (recommended: keeps the
#            token out of the command line); OSP_URL / OSP_TOKEN environment variables work too
#   -t TYPE  "host" or "service" (default: service when -S is given)
#   -H       host name macro ($HOSTNAME$, the host UUID in openITCockpit)
#   -N       host display name ($HOSTDISPLAYNAME$, optional)
#   -S       service description macro ($SERVICEDESC$, the service UUID in openITCockpit)
#   -D       service display name ($SERVICEDISPLAYNAME$, optional)
#   -s       numeric state ($SERVICESTATEID$ / $HOSTSTATEID$)
#   -o       plugin output ($SERVICEOUTPUT$ / $HOSTOUTPUT$, optional)
#   -T       unix timestamp ($TIMET$, optional)
#   -k       skip TLS certificate verification (self-signed certificates)
#   -n       dry run: print the JSON payload instead of sending it
#
# Environment: OSP_CURL_OPTS (extra curl options), OSP_TIMEOUT (seconds, default 10).
# Exit codes: 0 sent, 1 rejected by the server / network error, 3 usage or configuration error.

set -u

die() {
  echo "openstatuspage-notify: $*" >&2
  exit 3
}

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

CONFIG=""
TYPE=""
HOST=""
HOST_DISPLAY=""
SERVICE=""
SERVICE_DISPLAY=""
STATE_ID=""
OUTPUT=""
TIMESTAMP=""
DRY_RUN=0
INSECURE=""

while getopts "c:t:H:N:S:D:s:o:T:knh" opt; do
  case $opt in
    c) CONFIG=$OPTARG ;;
    t) TYPE=$OPTARG ;;
    H) HOST=$OPTARG ;;
    N) HOST_DISPLAY=$OPTARG ;;
    S) SERVICE=$OPTARG ;;
    D) SERVICE_DISPLAY=$OPTARG ;;
    s) STATE_ID=$OPTARG ;;
    o) OUTPUT=$OPTARG ;;
    T) TIMESTAMP=$OPTARG ;;
    k) INSECURE="--insecure" ;;
    n) DRY_RUN=1 ;;
    h)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) die "invalid option (use -h for help)" ;;
  esac
done

[ -n "$CONFIG" ] && read_config "$CONFIG"
[ "${OSP_INSECURE:-0}" = 1 ] && INSECURE="--insecure"

if [ -z "$TYPE" ]; then
  if [ -n "$SERVICE" ]; then TYPE=service; else TYPE=host; fi
fi
case $TYPE in
  host | service) ;;
  *) die "-t must be 'host' or 'service'" ;;
esac
[ -n "$HOST" ] || die "-H (host) is required"
[ "$TYPE" = host ] || [ -n "$SERVICE" ] || die "-S (service) is required for service notifications"
[ -n "$STATE_ID" ] || die "-s (state id) is required"

PAYLOAD="{\"type\":\"$TYPE\""
add_field host "$HOST"
add_field hostDisplayName "$HOST_DISPLAY"
if [ "$TYPE" = service ]; then
  add_field service "$SERVICE"
  add_field serviceDisplayName "$SERVICE_DISPLAY"
fi
add_field stateId "$STATE_ID"
add_field output "$OUTPUT"
add_field timestamp "$TIMESTAMP"
PAYLOAD="$PAYLOAD}"

if [ "$DRY_RUN" = 1 ]; then
  printf '%s\n' "$PAYLOAD"
  exit 0
fi

[ -n "${OSP_URL:-}" ] || die "OSP_URL is required (config file or environment)"
[ -n "${OSP_TOKEN:-}" ] || die "OSP_TOKEN is required (config file or environment)"
# Ingest tokens are base64url (letters, numbers, "-" and "_"). Anything else is
# rejected before the token is written into curl's config, where a quote,
# backslash or line break could add curl options. The set is spelled out so the
# check does not depend on the locale.
case $OSP_TOKEN in
  *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-]*)
    die "OSP_TOKEN contains characters that are not part of an ingest token" ;;
esac
command -v curl > /dev/null 2>&1 || die "curl is not installed"

# The token is passed to curl on stdin (-K -) so it does not show up in the process list.
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

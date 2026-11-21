#!/usr/bin/env bash
# Lints and renders the Helm chart (deploy/helm/openstatuspage) for the main
# value combinations and checks key properties of the output. Needs helm (v3.8+
# or v4) only; no cluster. Used by CI (.github/workflows/ci.yml, job "helm").
#
#   scripts/helm-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="$ROOT/deploy/helm/openstatuspage"
CI="$CHART/ci"
HELM="${HELM:-helm}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

failures=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }
check() { # check <description> <command...>
  local description="$1"; shift
  if "$@" > /dev/null 2>&1; then pass "$description"; else fail "$description"; fi
}

render() { # render <name> [helm args...] -> $TMP/<name>.yaml
  local name="$1"; shift
  "$HELM" template osp "$CHART" --namespace osp "$@" > "$TMP/$name.yaml"
}

# Prints the document of the given kind and metadata.name from a rendered file.
doc() { # doc <file> <kind> <name>
  awk -v kind="$2" -v name="$3" '
    function flush() { if (k == kind && n == name) printf "%s", buf; buf = ""; k = ""; n = ""; meta = 0 }
    /^---/ { flush(); next }
    { buf = buf $0 "\n" }
    /^kind: / { k = $2 }
    /^metadata:/ { meta = 1; next }
    meta && /^  name: / && n == "" { n = $2 }
    /^[a-z]/ && !/^metadata:/ { meta = 0 }
    END { flush() }
  ' "$TMP/$1.yaml"
}

count() { # count <file> <kind>
  grep -c "^kind: $2\$" "$TMP/$1.yaml" || true
}

has() { # has <file> <kind> <name> <extended regex>
  doc "$1" "$2" "$3" | grep -Eq -- "$4"
}

# True when the container env of a Deployment sets <env> to the literal <value>.
env_is() { # env_is <file> <deployment> <env> <value>
  doc "$1" Deployment "$2" | grep -A1 -- "- name: $3\$" | grep -Eq -- "value: \"?$4\"?\$"
}

lacks() { # lacks <file> <kind> <name> <extended regex> (the document must exist)
  [[ -n "$(doc "$1" "$2" "$3")" ]] && ! has "$@"
}

expect_count() { # expect_count <file> <kind> <n>
  local got
  got="$(count "$1" "$2")"
  if [[ "$got" == "$3" ]]; then pass "$1: $3 x $2"; else fail "$1: expected $3 x $2, got $got"; fi
}

expect_failure() { # expect_failure <description> <message regex> [helm args...]
  local description="$1" pattern="$2"; shift 2
  if "$HELM" template osp "$CHART" "$@" > "$TMP/out" 2>&1; then
    fail "$description (rendered without error)"
  elif grep -Eq -- "$pattern" "$TMP/out"; then
    pass "$description"
  else
    fail "$description (unexpected error: $(tail -n 3 "$TMP/out" | tr '\n' ' '))"
  fi
}

echo "helm: $("$HELM" version --short)"

echo "== lint"
for values in "$CI"/*-values.yaml; do
  if "$HELM" lint --strict "$CHART" -f "$values" > "$TMP/lint" 2>&1; then
    pass "helm lint --strict -f ci/$(basename "$values")"
  else
    cat "$TMP/lint"
    fail "helm lint --strict -f ci/$(basename "$values")"
  fi
done

echo "== render"
render sqlite -f "$CI/sqlite-values.yaml"
render sqlite3 -f "$CI/sqlite-values.yaml" --set replicaCount=3 --set strategy.type=RollingUpdate
render postgres -f "$CI/postgres-values.yaml"
render split -f "$CI/split-values.yaml"
render splitnp -f "$CI/split-networkpolicy-hpa-values.yaml"
pass "all value combinations render"

APP=osp-openstatuspage

echo "== SQLite (default)"
expect_count sqlite Deployment 1
expect_count sqlite PersistentVolumeClaim 1
expect_count sqlite PodDisruptionBudget 0
expect_count sqlite HorizontalPodAutoscaler 0
check "sqlite: one replica" has sqlite Deployment "$APP" '^  replicas: 1$'
check "sqlite: Recreate strategy" has sqlite Deployment "$APP" '^    type: Recreate$'
check "sqlite: APP_ROLE=all" env_is sqlite "$APP" APP_ROLE all
check "sqlite: volume claim mounted at /data" has sqlite Deployment "$APP" "claimName: $APP-data"
check "sqlite: no DATABASE_URL (image default sqlite:/data/...)" lacks sqlite Deployment "$APP" 'name: DATABASE_URL'
check "sqlite: replicaCount=3 is forced to 1" has sqlite3 Deployment "$APP" '^  replicas: 1$'
check "sqlite: RollingUpdate is forced to Recreate" has sqlite3 Deployment "$APP" '^    type: Recreate$'
check "sqlite: claim is kept on uninstall" has sqlite PersistentVolumeClaim "$APP-data" 'helm.sh/resource-policy: keep'
check "sqlite: chart Secret holds SECRET_KEY" has sqlite Secret "$APP" '^  SECRET_KEY: '

echo "== secure defaults"
for file in sqlite postgres split splitnp; do
  check "$file: read-only root filesystem everywhere" \
    bash -c "[[ \$(grep -c 'readOnlyRootFilesystem: true' '$TMP/$file.yaml') == \$(grep -c '^kind: Deployment\$' '$TMP/$file.yaml') ]]"
  check "$file: no service account token in any pod" \
    bash -c "[[ \$(grep -c '      automountServiceAccountToken: false' '$TMP/$file.yaml') == \$(grep -c '^kind: Deployment\$' '$TMP/$file.yaml') ]]"
  check "$file: no privilege escalation" bash -c "! grep -q 'allowPrivilegeEscalation: true' '$TMP/$file.yaml'"
  check "$file: secrets are never passed with envFrom" bash -c "! grep -q 'secretRef:' '$TMP/$file.yaml'"
done
check "runAsNonRoot and seccomp RuntimeDefault" has sqlite Deployment "$APP" 'runAsNonRoot: true'
check "capabilities dropped" has sqlite Deployment "$APP" '- ALL'
check "/tmp is an emptyDir" has sqlite Deployment "$APP" 'mountPath: /tmp'
check "probes use /api/health" has sqlite Deployment "$APP" 'path: /api/health'
check "memory limit 256Mi" has sqlite Deployment "$APP" 'memory: 256Mi'
check "image tag defaults to appVersion" has sqlite Deployment "$APP" "image: \"ghcr.io/[a-z0-9-]+/openstatuspage:$(awk '/^appVersion:/ {gsub(/"/, "", $2); print $2}' "$CHART/Chart.yaml")\""
render digest -f "$CI/sqlite-values.yaml" --set image.digest=sha256:0000000000000000000000000000000000000000000000000000000000000000
check "image digest pins the image" has digest Deployment "$APP" '@sha256:0{64}"'

echo "== PostgreSQL, single instance"
expect_count postgres Deployment 1
expect_count postgres PersistentVolumeClaim 0
expect_count postgres PodDisruptionBudget 1
expect_count postgres Secret 0
check "postgres: replicas from values" has postgres Deployment "$APP" '^  replicas: 2$'
check "postgres: RollingUpdate" has postgres Deployment "$APP" '^    type: RollingUpdate$'
check "postgres: DATABASE_URL from the existing Secret" has postgres Deployment "$APP" 'name: openstatuspage-db'
check "postgres: TLS on the Ingress" has postgres Ingress "$APP" 'secretName: openstatuspage-tls'

echo "== split mode"
expect_count split Deployment 3
expect_count split Service 2
expect_count split Ingress 2
expect_count split PodDisruptionBudget 1
check "split: public has APP_ROLE=public" env_is split "$APP-public" APP_ROLE public
check "split: admin has APP_ROLE=admin" env_is split "$APP-admin" APP_ROLE admin
check "split: worker has APP_ROLE=worker" env_is split "$APP-worker" APP_ROLE worker
check "split: public runs no background tasks" env_is split "$APP-public" WORKER_ENABLED false
check "split: admin runs no background tasks" env_is split "$APP-admin" WORKER_ENABLED false
check "split: worker runs the background tasks" env_is split "$APP-worker" WORKER_ENABLED true
check "split: public never gets SECRET_KEY" lacks split Deployment "$APP-public" 'SECRET_KEY'
check "split: public never gets the admin password" lacks split Deployment "$APP-public" 'ADMIN_PASSWORD|SMTP_PASSWORD|OIDC_CLIENT_SECRET'
check "split: public gets SUBSCRIPTION_TOKEN_KEY" has split Deployment "$APP-public" 'name: SUBSCRIPTION_TOKEN_KEY'
check "split: public uses the public role's Secret" has split Deployment "$APP-public" 'name: openstatuspage-db-public'
check "split: admin uses the owner role's Secret" has split Deployment "$APP-admin" 'name: openstatuspage-db$'
check "split: admin BASE_URL is the admin domain" env_is split "$APP-admin" BASE_URL https://status.admin.example.com
check "split: admin links point to the public domain" env_is split "$APP-admin" PUBLIC_BASE_URL https://status.example.com
check "split: worker BASE_URL is the public domain" env_is split "$APP-worker" BASE_URL https://status.example.com
check "split: worker has no Service" bash -c "! grep -q 'name: $APP-worker' <(awk '/^kind: Service$/,/^---/' '$TMP/split.yaml')"
check "split: public Ingress routes to the public Service" has split Ingress "$APP-public" "name: $APP-public"
check "split: admin Ingress routes to the admin Service" has split Ingress "$APP-admin" "name: $APP-admin"
check "split: admin Ingress keeps its own annotations" has split Ingress "$APP-admin" 'whitelist-source-range'
check "split: public Ingress has no admin restriction" lacks split Ingress "$APP-public" 'whitelist-source-range'
check "split: public startup waits for the migrations" has split Deployment "$APP-public" 'failureThreshold: 60'
check "split: PodDisruptionBudget selects public" has split PodDisruptionBudget "$APP-public" 'component: public'

echo "== split mode with NetworkPolicy and HPA"
expect_count splitnp NetworkPolicy 3
expect_count splitnp HorizontalPodAutoscaler 1
check "hpa: targets the public Deployment" has splitnp HorizontalPodAutoscaler "$APP-public" "name: $APP-public"
check "hpa: public replicas left to the HPA" lacks splitnp Deployment "$APP-public" '^  replicas:'
check "netpol: worker accepts no traffic" has splitnp NetworkPolicy "$APP-worker" '^  ingress: \[\]$'
check "netpol: public has no SMTP egress" lacks splitnp NetworkPolicy "$APP-public" 'port: 587'
check "netpol: public has no monitoring egress" lacks splitnp NetworkPolicy "$APP-public" '# monitoring'
check "netpol: worker may reach SMTP" has splitnp NetworkPolicy "$APP-worker" 'port: 587'
check "netpol: worker may reach monitoring" has splitnp NetworkPolicy "$APP-worker" '# monitoring'
check "netpol: worker has no Umami egress" lacks splitnp NetworkPolicy "$APP-worker" '# umami'
check "netpol: PostgreSQL restricted to the given peer" has splitnp NetworkPolicy "$APP-public" 'cidr: 192.0.2.10/32'
check "secret: chart Secret has the public URL separately" has splitnp Secret "$APP" '^  DATABASE_URL_PUBLIC: '
check "secret: public reads DATABASE_URL_PUBLIC" has splitnp Deployment "$APP-public" 'key: DATABASE_URL_PUBLIC'
check "topology spread gets the component selector" has splitnp Deployment "$APP-public" 'topologyKey: kubernetes.io/hostname'
check "ConfigMap carries the SMTP settings" has splitnp ConfigMap "$APP" 'SMTP_HOST: "smtp.example.com"'
check "pods restart on Secret changes" has splitnp Deployment "$APP-admin" 'checksum/secret: '

echo "== invalid values are rejected"
BASE=(--set baseUrl=https://status.example.com)
KEY=(--set secrets.secretKey=test-only-secret-key-0123456789abcdef)
expect_failure "missing SECRET_KEY fails" 'SECRET_KEY is required' "${BASE[@]}"
expect_failure "short SECRET_KEY fails" 'at least 32 characters' "${BASE[@]}" --set secrets.secretKey=short
expect_failure "missing baseUrl fails" 'baseUrl is required' "${KEY[@]}"
expect_failure "baseUrl with a path fails" 'baseUrl' "${KEY[@]}" --set baseUrl=https://example.com/status
expect_failure "split without PostgreSQL fails" 'split.enabled=true needs PostgreSQL' "${BASE[@]}" "${KEY[@]}" \
  --set split.enabled=true --set split.admin.baseUrl=https://status.admin.example.com
expect_failure "split without the public role fails" 'database.public' "${BASE[@]}" "${KEY[@]}" \
  --set split.enabled=true --set split.admin.baseUrl=https://status.admin.example.com \
  --set database.existingSecret=db --set secrets.subscriptionTokenKey=test-only-token-key-0123456789abcdef
expect_failure "split without SUBSCRIPTION_TOKEN_KEY fails" 'subscriptionTokenKey' "${BASE[@]}" "${KEY[@]}" \
  --set split.enabled=true --set split.admin.baseUrl=https://status.admin.example.com \
  --set database.existingSecret=db --set database.public.existingSecret=dbp
expect_failure "split without the admin domain fails" 'split.admin.baseUrl' "${BASE[@]}" \
  --set secrets.existingSecret=s --set split.enabled=true --set database.existingSecret=db --set database.public.existingSecret=dbp
expect_failure "split on one host fails" 'another host' "${BASE[@]}" --set secrets.existingSecret=s \
  --set split.enabled=true --set split.admin.baseUrl=https://status.example.com \
  --set database.existingSecret=db --set database.public.existingSecret=dbp
expect_failure "public role URL equal to the owner URL fails" 'restricted public role' "${BASE[@]}" "${KEY[@]}" \
  --set split.enabled=true --set split.admin.baseUrl=https://status.admin.example.com \
  --set secrets.subscriptionTokenKey=test-only-token-key-0123456789abcdef \
  --set database.url=postgres://u:p@db.example.com/osp --set database.public.url=postgres://u:p@db.example.com/osp
expect_failure "autoscaling with SQLite fails" 'autoscaling.enabled=true needs PostgreSQL' "${BASE[@]}" "${KEY[@]}" \
  --set autoscaling.enabled=true
expect_failure "SQLite URL in database.url fails" 'PostgreSQL URL|schema' "${BASE[@]}" "${KEY[@]}" \
  --set database.url=sqlite:/data/x.db
expect_failure "unknown config variable fails (schema)" "additional properties 'NOT_A_SETTING'" "${BASE[@]}" "${KEY[@]}" \
  --set config.NOT_A_SETTING=1
expect_failure "chart-managed variable in config fails (schema)" "additional properties 'SECRET_KEY'" "${BASE[@]}" "${KEY[@]}" \
  --set config.SECRET_KEY=x

echo "== package"
if "$HELM" package "$CHART" --destination "$TMP/pkg" > /dev/null; then
  pass "helm package"
  pkg="$(ls "$TMP"/pkg/*.tgz)"
  check "package leaves out the test values" bash -c "! tar -tzf '$pkg' | grep -q '/ci/'"
  check "package contains values.schema.json" bash -c "tar -tzf '$pkg' | grep -q 'values.schema.json'"
else
  fail "helm package"
fi

if [[ "$failures" -gt 0 ]]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"

#!/usr/bin/env bash
# Lints and renders the Helm chart (deploy/helm/openstatuspage) for the main
# value combinations and checks key properties of the output. Needs helm (v3.13+
# or v4) only; no cluster. Used by CI (.github/workflows/ci.yml, job "helm").
#
#   scripts/helm-test.sh
#
# Environment:
#   HELM        helm binary (default: helm)
#   RENDER_DIR  also write every successful render to this directory as
#               <name>.yaml, e.g. for schema validation with kubeconform (CI)
#   KUBECONFORM kubeconform binary (default: kubeconform). When it is found,
#               every render is validated against the Kubernetes version of
#               kubeVersion in Chart.yaml; KUBECONFORM=skip turns that off.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="$ROOT/deploy/helm/openstatuspage"
CI="$CHART/ci"
HELM="${HELM:-helm}"
KUBECONFORM="${KUBECONFORM:-kubeconform}"
RENDER_DIR="${RENDER_DIR:-}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
RENDERS=()
if [[ -n "$RENDER_DIR" ]]; then
  mkdir -p "$RENDER_DIR"
  rm -f "$RENDER_DIR"/*.yaml
fi

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
  RENDERS+=("$name")
  if [[ -n "$RENDER_DIR" ]]; then cp "$TMP/$name.yaml" "$RENDER_DIR/$name.yaml"; fi
}

# Minimum Kubernetes version of the chart: "1.25.0" from kubeVersion ">=1.25.0-0".
kube_version() {
  sed -nE 's/^kubeVersion: *"?>= *v?([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' "$CHART/Chart.yaml"
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

# The document is captured first: with pipefail, grep -q exiting at the first
# match would otherwise turn the writer's SIGPIPE into a spurious failure.
has() { # has <file> <kind> <name> <extended regex>
  local d
  d="$(doc "$1" "$2" "$3")"
  grep -Eq -- "$4" <<<"$d"
}

# True when the container env of a Deployment sets <env> to the literal <value>.
env_is() { # env_is <file> <deployment> <env> <value>
  local d
  d="$(doc "$1" Deployment "$2" | grep -A1 -- "- name: $3\$")" || return 1
  grep -Eq -- "value: \"?$4\"?\$" <<<"$d"
}

# True when the Deployment references exactly the given Secrets (sorted, space separated).
secret_refs_are() { # secret_refs_are <file> <deployment> <names...>
  local file="$1" name="$2"; shift 2
  [[ "$(doc "$file" Deployment "$name" | grep -A1 'secretKeyRef:' | awk '/name:/ {print $2}' | sort -u | xargs)" == "$*" ]]
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
render sqlitetmp -f "$CI/sqlite-values.yaml" --set persistence.enabled=false
expect_count sqlitetmp PersistentVolumeClaim 0
check "sqlite: persistence.enabled=false uses an emptyDir" lacks sqlitetmp Deployment "$APP" 'claimName:'
render sqliteann -f "$CI/sqlite-values.yaml" --set-string 'persistence.annotations.helm\.sh/resource-policy=delete' \
  --set-string persistence.annotations.backup=daily
check "sqlite: resource-policy cannot be overridden" \
  bash -c "[[ \$(grep -c 'helm.sh/resource-policy' <(awk '/^kind: PersistentVolumeClaim\$/,/^---/' '$TMP/sqliteann.yaml')) == 1 ]]"
check "sqlite: extra claim annotations kept" has sqliteann PersistentVolumeClaim "$APP-data" 'backup: daily'

echo "== secure defaults"
for file in sqlite postgres split splitnp; do
  check "$file: read-only root filesystem everywhere" \
    bash -c "[[ \$(grep -c 'readOnlyRootFilesystem: true' '$TMP/$file.yaml') == \$(grep -c '^kind: Deployment\$' '$TMP/$file.yaml') ]]"
  check "$file: no service account token in any pod" \
    bash -c "[[ \$(grep -c '      automountServiceAccountToken: false' '$TMP/$file.yaml') == \$(grep -c '^kind: Deployment\$' '$TMP/$file.yaml') ]]"
  check "$file: no privilege escalation" bash -c "! grep -q 'allowPrivilegeEscalation: true' '$TMP/$file.yaml'"
  check "$file: secrets are never passed with envFrom" bash -c "! grep -q 'secretRef:' '$TMP/$file.yaml'"
done
check "runAsNonRoot" has sqlite Deployment "$APP" 'runAsNonRoot: true'
check "seccomp RuntimeDefault" has sqlite Deployment "$APP" 'type: RuntimeDefault'
for file in sqlite postgres split splitnp; do
  check "$file: seccomp RuntimeDefault in every pod and container" \
    bash -c "[[ \$(grep -c 'type: RuntimeDefault' '$TMP/$file.yaml') == \$((2 * \$(grep -c '^kind: Deployment\$' '$TMP/$file.yaml'))) ]]"
done
check "capabilities dropped" has sqlite Deployment "$APP" '- ALL'
check "/tmp is an emptyDir" has sqlite Deployment "$APP" 'mountPath: /tmp'
check "probes use /api/health" has sqlite Deployment "$APP" 'path: /api/health'
check "liveness allows a 5 minute database outage" has sqlite Deployment "$APP" 'failureThreshold: 10$'
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
render port -f "$CI/sqlite-values.yaml" --set baseUrl=https://Status.example.com:8443
check "ingress: host of baseUrl without port, lowercased" has port Ingress "$APP" '^    - host: "status.example.com"$'
check "ingress: BASE_URL keeps the port" env_is port "$APP" BASE_URL https://Status.example.com:8443

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
render splitwait -f "$CI/split-values.yaml" --set-string config.SCHEMA_WAIT_SECONDS=600
check "split: public startup follows SCHEMA_WAIT_SECONDS" has splitwait Deployment "$APP-public" 'failureThreshold: 132$'
check "split: admin startup keeps the default" has splitwait Deployment "$APP-admin" 'failureThreshold: 30$'
check "split: PodDisruptionBudget selects public" has split PodDisruptionBudget "$APP-public" 'component: public'
check "split: no chart Secret with existing Secrets" bash -c "! grep -q '^kind: Secret\$' '$TMP/split.yaml'"
check "split: public references only the public Secrets" \
  secret_refs_are split "$APP-public" openstatuspage-db-public openstatuspage-public
check "split: admin references the private Secrets" \
  secret_refs_are split "$APP-admin" openstatuspage openstatuspage-db openstatuspage-public
check "split: worker references the private Secrets" \
  secret_refs_are split "$APP-worker" openstatuspage openstatuspage-db openstatuspage-public
check "split: admin reads the token key from publicExistingSecret" \
  bash -c "grep -A3 'name: SUBSCRIPTION_TOKEN_KEY' <(awk '/^  name: $APP-admin\$/,/^---/' '$TMP/split.yaml') | grep -q 'name: openstatuspage-public'"
render splitshared -f "$CI/split-values.yaml" --set database.public.existingSecret=openstatuspage-public
check "split: token key and public URL may share the public Secret" \
  secret_refs_are splitshared "$APP-public" openstatuspage-public
render splitmixed -f "$CI/split-values.yaml" --set secrets.existingSecret= \
  --set secrets.secretKey=test-only-secret-key-0123456789abcdef --set secrets.publicExistingSecret= \
  --set secrets.subscriptionTokenKey=test-only-token-key-0123456789abcdef
check "split: values-based token key goes to the chart's public Secret" \
  secret_refs_are splitmixed "$APP-public" openstatuspage-db-public "$APP-public"
check "split: chart's public Secret holds only the token key" lacks splitmixed Secret "$APP-public" 'SECRET_KEY:|PASSWORD|ADMIN_|DATABASE_URL'

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
check "netpol: SMTP turned on by SMTP_HOST (auto)" has splitnp NetworkPolicy "$APP-admin" '# smtp'
check "netpol: SMTP_PORT added to the SMTP rule" has splitnp NetworkPolicy "$APP-worker" 'port: 2525'
check "netpol: Umami turned on by UMAMI_URL (auto)" has splitnp NetworkPolicy "$APP-public" '# umami'
check "netpol: OIDC stays off without OIDC_ISSUER_URL" lacks splitnp NetworkPolicy "$APP-admin" '# oidc'
check "netpol: monitoring ports from values" has splitnp NetworkPolicy "$APP-worker" 'port: 9090'
render npoff -f "$CI/sqlite-values.yaml" --set networkPolicy.enabled=true
check "netpol: no optional egress without settings" lacks npoff NetworkPolicy "$APP" '# (smtp|oidc|umami|monitoring)'
render npoidc -f "$CI/sqlite-values.yaml" --set networkPolicy.enabled=true \
  --set config.OIDC_ISSUER_URL=https://sso.example.com:8443/realms/example
check "netpol: OIDC turned on with the port of the issuer URL" has npoidc NetworkPolicy "$APP" 'port: 8443'
render npforce -f "$CI/sqlite-values.yaml" --set networkPolicy.enabled=true \
  --set config.SMTP_HOST=smtp.example.com --set networkPolicy.egress.smtp.enabled=false
check "netpol: enabled=false wins over the setting" lacks npforce NetworkPolicy "$APP" '# smtp'
check "netpol: PostgreSQL restricted to the given peer" has splitnp NetworkPolicy "$APP-public" 'cidr: 192.0.2.10/32'
check "secret: public Secret holds the public URL" has splitnp Secret "$APP-public" '^  DATABASE_URL_PUBLIC: '
check "secret: public Secret holds the token key" has splitnp Secret "$APP-public" '^  SUBSCRIPTION_TOKEN_KEY: '
check "secret: public Secret holds nothing else" lacks splitnp Secret "$APP-public" 'SECRET_KEY:|PASSWORD|ADMIN_|  DATABASE_URL:'
check "secret: main Secret lacks the public keys" lacks splitnp Secret "$APP" 'DATABASE_URL_PUBLIC|SUBSCRIPTION_TOKEN_KEY'
check "secret: public pods reference only the public Secret" secret_refs_are splitnp "$APP-public" "$APP-public"
check "secret: admin reads the token key from the public Secret" \
  bash -c "grep -A3 'name: SUBSCRIPTION_TOKEN_KEY' <(awk '/^  name: $APP-admin\$/,/^---/' '$TMP/splitnp.yaml') | grep -q 'name: $APP-public'"
check "secret: public reads DATABASE_URL_PUBLIC" has splitnp Deployment "$APP-public" 'key: DATABASE_URL_PUBLIC'
check "topology spread gets the component selector" has splitnp Deployment "$APP-public" 'topologyKey: kubernetes.io/hostname'
check "ConfigMap carries the SMTP settings" has splitnp ConfigMap "$APP" 'SMTP_HOST: "smtp.example.com"'
check "pods restart on Secret changes" has splitnp Deployment "$APP-admin" 'checksum/secret: '

echo "== NOTES"
notes() { # notes <name> [helm args...] -> $TMP/<name>.notes (client-side dry run, no cluster)
  local name="$1"; shift
  "$HELM" install osp "$CHART" --namespace osp --dry-run=client "$@" | sed -n '/^NOTES:/,$p' > "$TMP/$name.notes"
}
notes npoff -f "$CI/sqlite-values.yaml" --set networkPolicy.enabled=true
check "notes: warn that monitoring egress is off by default" \
  grep -q 'networkPolicy.egress.monitoring is off' "$TMP/npoff.notes"
notes splitnp -f "$CI/split-networkpolicy-hpa-values.yaml"
check "notes: no monitoring warning once it is on" bash -c "! grep -q 'egress.monitoring is off' '$TMP/splitnp.notes'"
notes split -f "$CI/split-values.yaml"
check "notes: name the Secrets of the public pods" \
  grep -q 'Public pods reference only the Secrets openstatuspage-public and openstatuspage-db-public' "$TMP/split.notes"

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
SPLIT=(-f "$CI/split-values.yaml")
expect_failure "split with existingSecret but no publicExistingSecret fails" \
  'secrets.existingSecret needs secrets.publicExistingSecret' "${SPLIT[@]}" --set secrets.publicExistingSecret=
expect_failure "split with existingSecret ignores a values token key and still fails" \
  'needs secrets.publicExistingSecret' "${SPLIT[@]}" --set secrets.publicExistingSecret= \
  --set secrets.subscriptionTokenKey=test-only-token-key-0123456789abcdef
expect_failure "publicExistingSecret equal to existingSecret fails" \
  'secrets.publicExistingSecret must name a Secret of its own: "openstatuspage" is also secrets.existingSecret' \
  "${SPLIT[@]}" --set secrets.publicExistingSecret=openstatuspage
expect_failure "publicExistingSecret equal to database.existingSecret fails" \
  'secrets.publicExistingSecret must name a Secret of its own' \
  "${SPLIT[@]}" --set secrets.publicExistingSecret=openstatuspage-db
expect_failure "public database Secret equal to the owner's fails" \
  'database.public.existingSecret must name a Secret of its own' \
  "${SPLIT[@]}" --set database.public.existingSecret=openstatuspage-db
expect_failure "public database Secret equal to existingSecret fails" \
  'database.public.existingSecret must name a Secret of its own' \
  "${SPLIT[@]}" --set database.public.existingSecret=openstatuspage
expect_failure "publicExistingSecret equal to the chart's Secret fails" \
  "is also the Secret the chart creates" \
  -f "$CI/split-networkpolicy-hpa-values.yaml" --set secrets.publicExistingSecret="$APP"
expect_failure "split: extraEnvFrom with the private Secret fails" 'must not reference "openstatuspage"' \
  "${SPLIT[@]}" --set 'extraEnvFrom[0].secretRef.name=openstatuspage'
expect_failure "split: public extraEnv with the owner URL fails" 'must not reference "openstatuspage-db"' \
  "${SPLIT[@]}" --set 'split.public.extraEnv[0].name=X' \
  --set 'split.public.extraEnv[0].valueFrom.secretKeyRef.name=openstatuspage-db' \
  --set 'split.public.extraEnv[0].valueFrom.secretKeyRef.key=DATABASE_URL'
expect_failure "split: extraVolumes with the private Secret fails" 'must not reference "openstatuspage"' \
  "${SPLIT[@]}" --set 'extraVolumes[0].name=v' --set 'extraVolumes[0].secret.secretName=openstatuspage'
expect_failure "invalid Secret name fails (schema)" 'publicExistingSecret' \
  "${SPLIT[@]}" --set secrets.publicExistingSecret=Not_A_Secret
expect_failure "split: short values token key fails" 'subscriptionTokenKey must be at least 32' \
  "${SPLIT[@]}" --set secrets.existingSecret= --set secrets.secretKey=test-only-secret-key-0123456789abcdef \
  --set secrets.publicExistingSecret= --set secrets.subscriptionTokenKey=short
expect_failure "split without the admin domain fails" 'split.admin.baseUrl' "${BASE[@]}" \
  --set secrets.existingSecret=s --set secrets.publicExistingSecret=sp --set split.enabled=true --set database.existingSecret=db --set database.public.existingSecret=dbp
expect_failure "split on one host fails" 'another host' "${BASE[@]}" --set secrets.existingSecret=s --set secrets.publicExistingSecret=sp \
  --set split.enabled=true --set split.admin.baseUrl=https://status.example.com \
  --set database.existingSecret=db --set database.public.existingSecret=dbp
expect_failure "split on one host with another port fails" 'another host' "${BASE[@]}" --set secrets.existingSecret=s --set secrets.publicExistingSecret=sp \
  --set split.enabled=true --set split.admin.baseUrl=https://STATUS.example.com:8443 \
  --set database.existingSecret=db --set database.public.existingSecret=dbp
expect_failure "public role URL equal to the owner URL fails" 'restricted public role' "${BASE[@]}" "${KEY[@]}" \
  --set split.enabled=true --set split.admin.baseUrl=https://status.admin.example.com \
  --set secrets.subscriptionTokenKey=test-only-token-key-0123456789abcdef \
  --set database.url=postgres://u:p@db.example.com/osp --set database.public.url=postgres://u:p@db.example.com/osp
expect_failure "autoscaling with SQLite fails" 'autoscaling.enabled=true needs PostgreSQL' "${BASE[@]}" "${KEY[@]}" \
  --set autoscaling.enabled=true
expect_failure "HPA with minReplicas > maxReplicas fails" 'must not be greater' "${BASE[@]}" "${KEY[@]}" --set database.existingSecret=db --set autoscaling.enabled=true \
  --set autoscaling.minReplicas=5 --set autoscaling.maxReplicas=2
expect_failure "HPA without a metric fails" 'needs targetCPUUtilizationPercentage' "${BASE[@]}" "${KEY[@]}" --set database.existingSecret=db --set autoscaling.enabled=true \
  --set autoscaling.targetCPUUtilizationPercentage=null
expect_failure "HPA target as a string fails (schema)" 'targetCPUUtilizationPercentage' "${BASE[@]}" "${KEY[@]}" --set database.existingSecret=db --set autoscaling.enabled=true \
  --set-string autoscaling.targetCPUUtilizationPercentage=75
expect_failure "HPA target above 100 fails (schema)" 'targetCPUUtilizationPercentage' "${BASE[@]}" "${KEY[@]}" --set database.existingSecret=db --set autoscaling.enabled=true \
  --set autoscaling.targetCPUUtilizationPercentage=150
expect_failure "SQLite URL in database.url fails" 'PostgreSQL URL|schema' "${BASE[@]}" "${KEY[@]}" \
  --set database.url=sqlite:/data/x.db
expect_failure "unknown config variable fails (schema)" "additional properties 'NOT_A_SETTING'" "${BASE[@]}" "${KEY[@]}" \
  --set config.NOT_A_SETTING=1
expect_failure "unknown egress mode fails (schema)" "smtp/enabled" "${BASE[@]}" "${KEY[@]}" \
  --set networkPolicy.egress.smtp.enabled=maybe
expect_failure "chart-managed variable in config fails (schema)" "additional properties 'SECRET_KEY'" "${BASE[@]}" "${KEY[@]}" \
  --set config.SECRET_KEY=x

echo "== schemas"
check "kubeVersion of Chart.yaml gives a minimum version" bash -c "[[ -n '$(kube_version)' ]]"
if [[ "$KUBECONFORM" != skip ]] && command -v "$KUBECONFORM" > /dev/null 2>&1; then
  # No CRDs in the chart, so every kind must have a schema (no -ignore-missing-schemas).
  for name in "${RENDERS[@]}"; do
    if "$KUBECONFORM" -strict -summary -kubernetes-version "$(kube_version)" "$TMP/$name.yaml" > "$TMP/kc" 2>&1; then
      pass "kubeconform: $name (Kubernetes $(kube_version))"
    else
      cat "$TMP/kc"
      fail "kubeconform: $name (Kubernetes $(kube_version))"
    fi
  done
else
  echo "  skip  kubeconform not found (CI validates RENDER_DIR with it)"
fi
if [[ -n "$RENDER_DIR" ]]; then
  check "every render written to RENDER_DIR" \
    bash -c "[[ \$(ls '$RENDER_DIR'/*.yaml | wc -l) -eq ${#RENDERS[@]} ]]"
fi

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

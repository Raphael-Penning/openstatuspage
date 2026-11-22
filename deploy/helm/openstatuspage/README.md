# OpenStatusPage Helm chart

Deploys [OpenStatusPage](https://github.com/Raphael-Penning/openstatuspage), a
self-hosted status page, on Kubernetes 1.25 or newer. License: AGPL-3.0-only.

- **Single instance** (default): one Deployment with `APP_ROLE=all`.
- **Split mode** (`split.enabled=true`): the public page, the admin instance and
  the background worker as three Deployments, each with its own `APP_ROLE` and
  database role ([split deployment](https://github.com/Raphael-Penning/openstatuspage/blob/main/docs/guide/en/02-installation.md#split-deployment)).
- **Database**: an external PostgreSQL (recommended), or SQLite on a
  PersistentVolumeClaim when no PostgreSQL is configured. The chart deploys no
  database. With SQLite the chart runs exactly one replica with the `Recreate`
  strategy and rejects split mode and autoscaling.
- **Secure defaults**: non-root user 1000, read-only root filesystem (`/tmp` and
  `/data` are volumes), no privilege escalation, all capabilities dropped,
  seccomp `RuntimeDefault`, a dedicated ServiceAccount without token, probes on
  `/api/health`, 128Mi request and 256Mi limit. Secrets reach each instance key
  by key, so the public instance never sees `SECRET_KEY`. In split mode the
  public pods reference only Secrets that hold their own two keys (see below).

## Install

The chart is published as an OCI artifact with every release:

```bash
kubectl create namespace openstatuspage
kubectl -n openstatuspage create secret generic openstatuspage \
  --from-literal=SECRET_KEY="$(openssl rand -base64 48)" \
  --from-literal=ADMIN_EMAIL=admin@example.com \
  --from-literal=ADMIN_PASSWORD='a-long-password'
kubectl -n openstatuspage create secret generic openstatuspage-db \
  --from-literal=DATABASE_URL='postgres://openstatuspage:<password>@postgres.example.com:5432/openstatuspage'

helm install openstatuspage oci://ghcr.io/raphael-penning/charts/openstatuspage \
  --version X.Y.Z --namespace openstatuspage \
  --set baseUrl=https://status.example.com \
  --set secrets.existingSecret=openstatuspage \
  --set database.existingSecret=openstatuspage-db \
  --set ingress.enabled=true --set ingress.className=nginx
```

Leave out `database.existingSecret` for SQLite on a volume. Back up
`SECRET_KEY` outside the cluster: a new key makes stored monitoring credentials
unreadable. The chart never generates secrets.

Migrations run when the app starts (the single instance, or admin and worker in
split mode; the public instance waits up to `SCHEMA_WAIT_SECONDS`), so no
migration Job is needed. Upgrade with `helm upgrade` and a new `--version`
after a backup ([Operations](https://github.com/Raphael-Penning/openstatuspage/blob/main/docs/guide/en/09-operations.md)).

### Split mode

Split mode needs PostgreSQL with the roles of
[`deploy/postgres/roles.sql`](https://github.com/Raphael-Penning/openstatuspage/blob/main/deploy/postgres/roles.sql):
`osp_app` (owner, no superuser) for admin and worker, and the restricted
`osp_public` for the public instance. Public and admin need **separate host names**: the public instance
answers the management UI, its assets, login, OIDC, the admin API and the
ingest webhooks with 404. The chart creates one Ingress per host (the port of
`baseUrl` is not part of the host); restrict the admin host, for example with
an IP allowlist annotation. Monitoring systems that push results use the ingest
URLs of the admin host.

The public pods get a Secret of their own. The kubelet of a node may read
every Secret that the pods on that node reference (not only the keys they
use), so the public pods must reference no Secret that holds `SECRET_KEY`,
`ADMIN_*`, `SMTP_PASSWORD`, `OIDC_CLIENT_SECRET` or the owner `DATABASE_URL`.
The chart enforces this:

- With `secrets.existingSecret`, `secrets.publicExistingSecret` is
  **required**: an existing Secret with only `SUBSCRIPTION_TOKEN_KEY`. Without
  it the install fails.
- `secrets.publicExistingSecret` and `database.public.existingSecret` must
  differ from `secrets.existingSecret`, `database.existingSecret` and the
  Secret the chart creates; they may be the same Secret.
- `extraEnv`, `extraEnvFrom`, `extraVolumes` and `split.public.extraEnv` reach
  the public pods too, so they must not reference those private Secrets
  either.
- With values instead of existing Secrets the chart creates
  `<release>-openstatuspage-public` with only `SUBSCRIPTION_TOKEN_KEY` and
  `database.public.url`; the private keys go into `<release>-openstatuspage`,
  which the public pods never reference.

NOTES lists the Secrets the public pods reference.

```bash
kubectl -n openstatuspage create secret generic openstatuspage \
  --from-literal=SECRET_KEY="$(openssl rand -base64 48)"
kubectl -n openstatuspage create secret generic openstatuspage-public \
  --from-literal=SUBSCRIPTION_TOKEN_KEY="$(openssl rand -base64 48)"
kubectl -n openstatuspage create secret generic openstatuspage-db \
  --from-literal=DATABASE_URL='postgres://osp_app:<password>@postgres.example.com:5432/openstatuspage'
kubectl -n openstatuspage create secret generic openstatuspage-db-public \
  --from-literal=DATABASE_URL='postgres://osp_public:<password>@postgres.example.com:5432/openstatuspage'

helm install openstatuspage oci://ghcr.io/raphael-penning/charts/openstatuspage \
  --version X.Y.Z --namespace openstatuspage -f my-values.yaml
```

```yaml
# my-values.yaml
baseUrl: https://status.example.com
secrets:
  existingSecret: openstatuspage
  publicExistingSecret: openstatuspage-public
database:
  existingSecret: openstatuspage-db
  public:
    existingSecret: openstatuspage-db-public
split:
  enabled: true
  admin:
    baseUrl: https://status.admin.example.com
ingress:
  enabled: true
  className: nginx
  admin:
    annotations:
      nginx.ingress.kubernetes.io/whitelist-source-range: 192.0.2.0/24
```

Which keys each instance reads from `secrets.existingSecret` (in split mode
`SUBSCRIPTION_TOKEN_KEY` comes from `secrets.publicExistingSecret`, or the
chart's public Secret, for every instance):

| Key | all | public | admin | worker |
| --- | :---: | :---: | :---: | :---: |
| `SECRET_KEY` (required) | ✓ | – | ✓ | ✓ |
| `SUBSCRIPTION_TOKEN_KEY` (required in split mode) | optional | ✓ | ✓ | ✓ |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `OIDC_CLIENT_SECRET` | optional | – | optional | – |
| `SMTP_PASSWORD` | optional | – | optional | optional |

## Values

| Key | Default | Description |
| --- | --- | --- |
| `baseUrl` | `""` | **Required.** Public URL of the status page (`BASE_URL`), no path or trailing slash. |
| `image.repository` | `ghcr.io/raphael-penning/openstatuspage` | Container image. |
| `image.tag` | `""` | Image tag; defaults to the chart's `appVersion`. |
| `image.digest` | `""` | Pins the image by digest (`sha256:...`). |
| `image.pullPolicy` | `IfNotPresent` | Pull policy. |
| `imagePullSecrets` | `[]` | Registry secrets. |
| `nameOverride`, `fullnameOverride` | `""` | Resource names. |
| `config` | `TRUST_PROXY: "1"`, `LOG_LEVEL: info` | Non-secret settings (ConfigMap). Keys are the variables of [configuration.md](https://github.com/Raphael-Penning/openstatuspage/blob/main/docs/configuration.md); the schema accepts `TRUST_PROXY`, `LOG_LEVEL`, `SCHEMA_WAIT_SECONDS`, `SESSION_TTL_HOURS`, `SESSION_MAX_AGE_HOURS`, `LOCAL_LOGIN_ENABLED`, `OIDC_*` (except the secret), `BUNDLE_PUSH_STALE_SECONDS`, `MAX_CHECKS_PER_SOURCE`, `POLL_MAX_RESPONSE_MB`, `POLL_MAX_VALUES`, `MAIL_TRANSPORT`, `SMTP_*` (except the password), `UMAMI_URL` and `ALLOW_UNRESTRICTED_PUBLIC_DB`. |
| `secrets.existingSecret` | `""` | Existing Secret (recommended), keys see above. In split mode it requires `secrets.publicExistingSecret`. |
| `secrets.publicExistingSecret` | `""` | Split mode: existing Secret with only `SUBSCRIPTION_TOKEN_KEY`, the one Secret besides the public database URL that the public pods reference. Required with `secrets.existingSecret`; must differ from it and from `database.existingSecret`. |
| `secrets.secretKey` | `""` | `SECRET_KEY` (≥ 32 characters) for a chart-created Secret. |
| `secrets.subscriptionTokenKey` | `""` | `SUBSCRIPTION_TOKEN_KEY` (≥ 32 characters); required in split mode, then stored in the Secret `<fullname>-public`. |
| `secrets.adminEmail`, `secrets.adminPassword` | `""` | First administrator. |
| `secrets.smtpPassword`, `secrets.oidcClientSecret` | `""` | SMTP password, OIDC client secret. |
| `database.url` | `""` | PostgreSQL URL of the owner role. Empty with `existingSecret` empty = SQLite. |
| `database.existingSecret`, `database.existingSecretKey` | `""`, `DATABASE_URL` | Secret and key with the owner URL. |
| `database.public.url` | `""` | Split mode: URL of the restricted public role (stored in the Secret `<fullname>-public`). |
| `database.public.existingSecret`, `database.public.existingSecretKey` | `""`, `DATABASE_URL` | Secret and key with the public role's URL. Must differ from `database.existingSecret` and `secrets.existingSecret`. |
| `database.public.role` | `osp_public` | `DB_PUBLIC_ROLE`. |
| `persistence.enabled` | `true` | SQLite: keep the database on a claim. `false` uses an emptyDir that loses the data with every pod restart (tests only). |
| `persistence.existingClaim` | `""` | SQLite: use an existing claim. |
| `persistence.storageClass` | `""` | SQLite: storage class (cluster default when empty). |
| `persistence.accessModes` | `[ReadWriteOnce]` | SQLite: access modes. |
| `persistence.size` | `1Gi` | SQLite: size. |
| `persistence.annotations` | `{}` | Extra claim annotations (the claim always carries `helm.sh/resource-policy: keep`; a `helm.sh/resource-policy` here is ignored). |
| `replicaCount` | `1` | Replicas of the single instance (1 with SQLite). |
| `strategy` | `{type: RollingUpdate}` | Strategy of the single instance (`Recreate` with SQLite). |
| `split.enabled` | `false` | Split mode. |
| `split.public.replicaCount` | `2` | Replicas of the public instance. |
| `split.admin.baseUrl` | `""` | Split mode: URL of the admin domain (required, another host than `baseUrl`). |
| `split.admin.replicaCount` | `1` | Replicas of the admin instance. |
| `split.admin.strategy` | `{type: Recreate}` | Strategy of the admin instance. |
| `split.worker.replicaCount` | `1` | Replicas of the worker. |
| `split.<role>.resources`, `.extraEnv`, `.nodeSelector`, `.tolerations`, `.affinity`, `.podAnnotations` | empty | Per-instance overrides. |
| `autoscaling.enabled` | `false` | HPA for the public instance (split) or the single instance (PostgreSQL only). |
| `autoscaling.minReplicas`, `maxReplicas` | `2`, `6` | Replica range (`minReplicas` ≤ `maxReplicas`). |
| `autoscaling.targetCPUUtilizationPercentage` | `75` | CPU target, integer 1–100 or `""`. |
| `autoscaling.targetMemoryUtilizationPercentage` | `""` | Optional memory target, integer 1–100. At least one target is required. |
| `podDisruptionBudget.enabled` | `true` | PDB for the public-facing instance (not with SQLite). |
| `podDisruptionBudget.minAvailable`, `maxUnavailable` | `""`, `1` | Budget. |
| `serviceAccount.create`, `name`, `annotations` | `true`, `""`, `{}` | Dedicated ServiceAccount (no token mounted). |
| `service.type`, `port`, `annotations` | `ClusterIP`, `80`, `{}` | Service of the single, public and admin instance (the worker has none). |
| `ingress.enabled` | `false` | Ingress for `baseUrl`. |
| `ingress.className`, `annotations`, `tls` | `""`, `{}`, `[]` | Ingress settings. |
| `ingress.hosts` | `[]` | Hosts (default: the host of `baseUrl`). |
| `ingress.path`, `pathType` | `/`, `Prefix` | Path of every host. |
| `ingress.admin.enabled` | `true` | Split mode: Ingress for the admin domain. |
| `ingress.admin.className`, `annotations`, `hosts`, `tls` | empty | Admin Ingress settings (hosts default to the host of `split.admin.baseUrl`). |
| `podSecurityContext` | non-root 1000, seccomp | Pod security context. |
| `securityContext` | read-only, no escalation, drop ALL | Container security context. |
| `resources` | 100m/128Mi request, 256Mi limit | Resources of every instance. |
| `probes.startup`, `readiness`, `liveness` | enabled | Probes on `/api/health`, which checks the database. The public instance allows twice the startup failures and at least `config.SCHEMA_WAIT_SECONDS` + 60 s. Liveness: 10 × 30 s, so a database outage restarts the pods after 5 minutes. |
| `tmpSizeLimit` | `64Mi` | Size limit of `/tmp`. |
| `podAnnotations`, `podLabels` | `{}` | Pod metadata. |
| `nodeSelector`, `tolerations`, `affinity` | empty | Scheduling. |
| `topologySpreadConstraints` | `[]` | Spread; the component's selector labels are added when `labelSelector` is missing. |
| `priorityClassName` | `""` | Priority class. |
| `terminationGracePeriodSeconds` | `30` | Shutdown time. |
| `extraEnv`, `extraEnvFrom`, `extraVolumes`, `extraVolumeMounts` | `[]` | Extra container settings for every instance (`extraEnvFrom` reaches the public instance too). |
| `networkPolicy.enabled` | `false` | NetworkPolicies (deny by default). |
| `networkPolicy.ingress.from` | namespace `ingress-nginx` | Who may reach the HTTP port (the worker accepts nothing). |
| `networkPolicy.egress.dns` | enabled, kube-dns | DNS. |
| `networkPolicy.egress.postgres` | enabled, port 5432 | PostgreSQL (all instances). |
| `networkPolicy.egress.smtp` | `auto`, 587/465 | SMTP (single, admin, worker). |
| `networkPolicy.egress.monitoring` | disabled, 443 | Monitoring systems (single, admin, worker). |
| `networkPolicy.egress.oidc` | `auto`, 443 | OIDC provider (single, admin). |
| `networkPolicy.egress.umami` | `auto`, 443 | Umami (single, public, admin). |
| `networkPolicy.egress.extra` | `[]` | Extra egress rules for every instance. |

An egress rule with an empty `to` allows any destination on its ports; set
`to` (for example an `ipBlock`) to narrow it down. The SMTP, OIDC and Umami
rules take `enabled: true`, `false` or `auto` (default): `auto` turns the rule
on when `config.SMTP_HOST`, `config.OIDC_ISSUER_URL` or `config.UMAMI_URL` is
set and adds `SMTP_PORT` or the port of the URL to its ports.

> **Monitoring egress is off by default.** The chart cannot know the
> monitoring systems the app polls, so it never opens them by itself. With
> `networkPolicy.enabled=true` every poll fails until you turn on
> `networkPolicy.egress.monitoring` and list the ports (and ideally the
> addresses in `to`) of every polled API, for example 443, 80, 9090 for
> Prometheus or 3000 for Grafana. NOTES prints a warning while it is off.

## Development

`scripts/helm-test.sh` lints and renders the chart for the value files in
`ci/` and checks the output; CI runs the same script. With `RENDER_DIR` set it
also writes every render there; CI then validates them with a pinned
[kubeconform](https://github.com/yannh/kubeconform) (`-strict`, against the
minimum Kubernetes version of `kubeVersion`). A local `kubeconform` on the
`PATH` is used by the script itself. Release tags `vX.Y.Z`
publish the chart to `oci://ghcr.io/<owner>/charts/openstatuspage`
([releasing](https://github.com/Raphael-Penning/openstatuspage/blob/main/docs/releasing.md)).

# OpenStatusPage Helm chart

Deploys [OpenStatusPage](https://github.com/Raphael-Penning/openstatuspage), a
self-hosted status page, on Kubernetes 1.25 or newer. License: AGPL-3.0-only.

- **Single instance** (default): one Deployment with `APP_ROLE=all`.
- **Split mode** (`split.enabled=true`): the public page, the admin instance and
  the background worker as three Deployments, each with its own `APP_ROLE` and
  database role ([split deployment](../../../docs/guide/en/02-installation.md#split-deployment)).
- **Database**: an external PostgreSQL (recommended), or SQLite on a
  PersistentVolumeClaim when no PostgreSQL is configured. The chart deploys no
  database. With SQLite the chart runs exactly one replica with the `Recreate`
  strategy and rejects split mode and autoscaling.
- **Secure defaults**: non-root user 1000, read-only root filesystem (`/tmp` and
  `/data` are volumes), no privilege escalation, all capabilities dropped,
  seccomp `RuntimeDefault`, a dedicated ServiceAccount without token, probes on
  `/api/health`, 128Mi request and 256Mi limit. Secrets reach each instance key
  by key, so the public instance never sees `SECRET_KEY`.

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
after a backup ([Operations](../../../docs/guide/en/09-operations.md)).

### Split mode

Split mode needs PostgreSQL with the roles of
[`deploy/postgres/roles.sql`](../../postgres/roles.sql): `osp_app` (owner, no
superuser) for admin and worker, and the restricted `osp_public` for the public
instance. Public and admin need **separate host names**: the public instance
answers the management UI, its assets, login, OIDC, the admin API and the
ingest webhooks with 404. The chart creates one Ingress per host; restrict the
admin host, for example with an IP allowlist annotation. Monitoring systems
that push results use the ingest URLs of the admin host.

```bash
TOKEN_KEY="$(openssl rand -base64 48)"
kubectl -n openstatuspage create secret generic openstatuspage \
  --from-literal=SECRET_KEY="$(openssl rand -base64 48)" \
  --from-literal=SUBSCRIPTION_TOKEN_KEY="$TOKEN_KEY"
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

Which keys each instance reads from `secrets.existingSecret`:

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
| `config` | `TRUST_PROXY: "1"`, `LOG_LEVEL: info` | Non-secret settings (ConfigMap). Keys are the variables of [configuration.md](../../../docs/configuration.md); the schema accepts `TRUST_PROXY`, `LOG_LEVEL`, `SCHEMA_WAIT_SECONDS`, `SESSION_TTL_HOURS`, `SESSION_MAX_AGE_HOURS`, `LOCAL_LOGIN_ENABLED`, `OIDC_*` (except the secret), `BUNDLE_PUSH_STALE_SECONDS`, `MAIL_TRANSPORT`, `SMTP_*` (except the password), `UMAMI_URL` and `ALLOW_UNRESTRICTED_PUBLIC_DB`. |
| `secrets.existingSecret` | `""` | Existing Secret (recommended), keys see above. |
| `secrets.secretKey` | `""` | `SECRET_KEY` (≥ 32 characters) for a chart-created Secret. |
| `secrets.subscriptionTokenKey` | `""` | `SUBSCRIPTION_TOKEN_KEY` (≥ 32 characters); required in split mode. |
| `secrets.adminEmail`, `secrets.adminPassword` | `""` | First administrator. |
| `secrets.smtpPassword`, `secrets.oidcClientSecret` | `""` | SMTP password, OIDC client secret. |
| `database.url` | `""` | PostgreSQL URL of the owner role. Empty with `existingSecret` empty = SQLite. |
| `database.existingSecret`, `database.existingSecretKey` | `""`, `DATABASE_URL` | Secret and key with the owner URL. |
| `database.public.url` | `""` | Split mode: URL of the restricted public role. |
| `database.public.existingSecret`, `database.public.existingSecretKey` | `""`, `DATABASE_URL` | Secret and key with the public role's URL. |
| `database.public.role` | `osp_public` | `DB_PUBLIC_ROLE`. |
| `persistence.existingClaim` | `""` | SQLite: use an existing claim. |
| `persistence.storageClass` | `""` | SQLite: storage class (cluster default when empty). |
| `persistence.accessModes` | `[ReadWriteOnce]` | SQLite: access modes. |
| `persistence.size` | `1Gi` | SQLite: size. |
| `persistence.annotations` | `{}` | Extra claim annotations (the claim always carries `helm.sh/resource-policy: keep`). |
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
| `autoscaling.minReplicas`, `maxReplicas` | `2`, `6` | Replica range. |
| `autoscaling.targetCPUUtilizationPercentage` | `75` | CPU target. |
| `autoscaling.targetMemoryUtilizationPercentage` | `""` | Optional memory target. |
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
| `probes.startup`, `readiness`, `liveness` | enabled | Probes on `/api/health` (the public instance gets twice the startup failures). |
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
| `networkPolicy.egress.smtp` | disabled, 587/465 | SMTP (single, admin, worker). |
| `networkPolicy.egress.monitoring` | disabled, 443 | Monitoring systems (single, admin, worker). |
| `networkPolicy.egress.oidc` | disabled, 443 | OIDC provider (single, admin). |
| `networkPolicy.egress.umami` | disabled, 443 | Umami (single, public, admin). |
| `networkPolicy.egress.extra` | `[]` | Extra egress rules for every instance. |

An egress rule with an empty `to` allows any destination on its ports; set
`to` (for example an `ipBlock`) to narrow it down.

## Development

`scripts/helm-test.sh` lints and renders the chart for the value files in
`ci/` and checks the output; CI runs the same script. Release tags `vX.Y.Z`
publish the chart to `oci://ghcr.io/<owner>/charts/openstatuspage`
([releasing](../../../docs/releasing.md)).

{{/*
Chart name, truncated to the 63 characters of a DNS label.
*/}}
{{- define "openstatuspage.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Full name of the release resources. Leaves room for the "-public", "-admin"
and "-worker" suffixes of split mode.
*/}}
{{- define "openstatuspage.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 56 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 56 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 56 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "openstatuspage.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "openstatuspage.labels" -}}
helm.sh/chart: {{ include "openstatuspage.chart" . }}
{{ include "openstatuspage.selectorLabels" . }}
app.kubernetes.io/version: {{ include "openstatuspage.imageTag" . | trunc 63 | trimSuffix "-" | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: openstatuspage
{{- end }}

{{- define "openstatuspage.selectorLabels" -}}
app.kubernetes.io/name: {{ include "openstatuspage.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Labels and selector labels of one component. Argument: dict "root" $ "component" <name>.
*/}}
{{- define "openstatuspage.componentLabels" -}}
{{ include "openstatuspage.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "openstatuspage.componentSelectorLabels" -}}
{{ include "openstatuspage.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Resource name of one component: the full name for the single instance,
"<fullname>-<role>" in split mode.
*/}}
{{- define "openstatuspage.componentName" -}}
{{- if eq .component "app" }}
{{- include "openstatuspage.fullname" .root }}
{{- else }}
{{- printf "%s-%s" (include "openstatuspage.fullname" .root) .component }}
{{- end }}
{{- end }}

{{- define "openstatuspage.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "openstatuspage.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "openstatuspage.imageTag" -}}
{{- default .Chart.AppVersion .Values.image.tag }}
{{- end }}

{{- define "openstatuspage.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s:%s@%s" .Values.image.repository (include "openstatuspage.imageTag" .) .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository (include "openstatuspage.imageTag" .) }}
{{- end }}
{{- end }}

{{/*
"true" when PostgreSQL is configured, "" for SQLite.
*/}}
{{- define "openstatuspage.postgres" -}}
{{- if or .Values.database.url .Values.database.existingSecret }}true{{ end }}
{{- end }}

{{- define "openstatuspage.secretName" -}}
{{- default (include "openstatuspage.fullname" .) .Values.secrets.existingSecret }}
{{- end }}

{{/*
Secret and key of the owner database URL, and of the public role's URL.
*/}}
{{- define "openstatuspage.dbSecretName" -}}
{{- default (include "openstatuspage.fullname" .) .Values.database.existingSecret }}
{{- end }}

{{- define "openstatuspage.dbSecretKey" -}}
{{- if .Values.database.existingSecret }}{{ .Values.database.existingSecretKey }}{{ else }}DATABASE_URL{{ end }}
{{- end }}

{{- define "openstatuspage.dbPublicSecretName" -}}
{{- default (include "openstatuspage.publicSecretName" .) .Values.database.public.existingSecret }}
{{- end }}

{{- define "openstatuspage.dbPublicSecretKey" -}}
{{- if .Values.database.public.existingSecret }}{{ .Values.database.public.existingSecretKey }}{{ else }}DATABASE_URL_PUBLIC{{ end }}
{{- end }}

{{/*
Name of the chart-created Secret of the public instance (split mode). It holds
only SUBSCRIPTION_TOKEN_KEY and DATABASE_URL_PUBLIC, so the kubelet of a node
that runs public pods can read nothing else.
*/}}
{{- define "openstatuspage.publicSecretName" -}}
{{- printf "%s-public" (include "openstatuspage.fullname" .) }}
{{- end }}

{{/*
Secret that holds SUBSCRIPTION_TOKEN_KEY. In split mode every instance reads
it from the same Secret that the public instance references:
secrets.publicExistingSecret, else secrets.existingSecret, else the chart's
public Secret.
*/}}
{{- define "openstatuspage.tokenSecretName" -}}
{{- if .Values.split.enabled }}
{{- coalesce .Values.secrets.publicExistingSecret .Values.secrets.existingSecret (include "openstatuspage.publicSecretName" .) }}
{{- else }}
{{- include "openstatuspage.secretName" . }}
{{- end }}
{{- end }}

{{/*
"true" when the chart has to create its own Secret.
*/}}
{{- define "openstatuspage.createSecret" -}}
{{- if or (not .Values.secrets.existingSecret) (and .Values.database.url (not .Values.database.existingSecret)) }}true{{ end }}
{{- end }}

{{/*
"true" when split mode needs the chart's public Secret: SUBSCRIPTION_TOKEN_KEY
or the public role's URL came from values.
*/}}
{{- define "openstatuspage.createPublicSecret" -}}
{{- $s := .Values.secrets }}
{{- if and .Values.split.enabled (or (and (not $s.publicExistingSecret) (not $s.existingSecret)) (and .Values.database.public.url (not .Values.database.public.existingSecret))) }}true{{ end }}
{{- end }}

{{/*
Host name of a URL without port, lowercased
("https://Status.example.com:8443" -> "status.example.com"). Ingress hosts
must not carry a port.
*/}}
{{- define "openstatuspage.urlHost" -}}
{{- regexReplaceAll ":[0-9]*$" (urlParse .).host "" | lower }}
{{- end }}

{{/*
Port of an http(s) URL: the explicit one, else 443 for https and 80 for http.
*/}}
{{- define "openstatuspage.urlPort" -}}
{{- $u := urlParse . }}
{{- $port := regexFind "[0-9]+$" (regexFind ":[0-9]+$" $u.host) }}
{{- if $port }}{{ $port }}{{ else if eq $u.scheme "http" }}80{{ else }}443{{ end }}
{{- end }}

{{/*
Optional egress rules of the NetworkPolicies and the setting that turns an
"auto" rule on. Argument: root context. Returns YAML: kind -> setting value.
*/}}
{{- define "openstatuspage.egressSettings" -}}
smtp: {{ .Values.config.SMTP_HOST | default "" | quote }}
oidc: {{ .Values.config.OIDC_ISSUER_URL | default "" | quote }}
umami: {{ .Values.config.UMAMI_URL | default "" | quote }}
monitoring: ""
{{- end }}

{{/*
"true" when an optional egress rule is on: enabled=true, or enabled=auto and
its setting (config.SMTP_HOST, OIDC_ISSUER_URL, UMAMI_URL) is set.
Argument: dict "root" $ "kind" <smtp|oidc|umami|monitoring>.
*/}}
{{- define "openstatuspage.egressOn" -}}
{{- $enabled := (index .root.Values.networkPolicy.egress .kind).enabled }}
{{- $setting := index (include "openstatuspage.egressSettings" .root | fromYaml) .kind }}
{{- if or (eq (toString $enabled) "true") (and (eq (toString $enabled) "auto") $setting) }}true{{ end }}
{{- end }}

{{/*
Port the app uses for an optional egress rule, from its setting: SMTP_PORT,
or the port of OIDC_ISSUER_URL / UMAMI_URL. Empty when unknown.
Argument: dict "root" $ "kind" <smtp|oidc|umami|monitoring>.
*/}}
{{- define "openstatuspage.egressPort" -}}
{{- $c := .root.Values.config }}
{{- if eq .kind "smtp" }}{{ $c.SMTP_PORT | default "" }}
{{- else if and (eq .kind "oidc") $c.OIDC_ISSUER_URL }}{{ include "openstatuspage.urlPort" $c.OIDC_ISSUER_URL }}
{{- else if and (eq .kind "umami") $c.UMAMI_URL }}{{ include "openstatuspage.urlPort" $c.UMAMI_URL }}
{{- end }}
{{- end }}

{{/*
Validates the values combination and fails with a clear message. Rendered
by every template that depends on it (through the Deployment template).
*/}}
{{- define "openstatuspage.validate" -}}
{{- $pg := include "openstatuspage.postgres" . }}
{{- if not .Values.baseUrl }}
{{- fail "baseUrl is required: the public URL of the status page, e.g. --set baseUrl=https://status.example.com" }}
{{- end }}
{{- if not (regexMatch "^https?://[^/?#]+$" .Values.baseUrl) }}
{{- fail (printf "baseUrl must be an http(s) URL without path or trailing slash, got %q" .Values.baseUrl) }}
{{- end }}
{{- if and (not .Values.secrets.existingSecret) (not .Values.secrets.secretKey) }}
{{- fail "SECRET_KEY is required: set secrets.existingSecret (recommended, a Secret with the key SECRET_KEY) or secrets.secretKey (at least 32 characters, e.g. `openssl rand -base64 48`)" }}
{{- end }}
{{- if and (not .Values.secrets.existingSecret) (lt (len .Values.secrets.secretKey) 32) }}
{{- fail "secrets.secretKey must be at least 32 characters long" }}
{{- end }}
{{- if and (not .Values.secrets.existingSecret) .Values.secrets.subscriptionTokenKey (lt (len .Values.secrets.subscriptionTokenKey) 32) }}
{{- fail "secrets.subscriptionTokenKey must be at least 32 characters long" }}
{{- end }}
{{- if and (not .Values.secrets.existingSecret) .Values.secrets.adminPassword (lt (len .Values.secrets.adminPassword) 10) }}
{{- fail "secrets.adminPassword must be at least 10 characters long" }}
{{- end }}
{{- if and .Values.database.url (not (regexMatch "^postgres(ql)?://" .Values.database.url)) }}
{{- fail "database.url must be a PostgreSQL URL (postgres://...). Leave it empty for SQLite on the volume." }}
{{- end }}
{{- if .Values.split.enabled }}
{{- if not $pg }}
{{- fail "split.enabled=true needs PostgreSQL: set database.url or database.existingSecret (SQLite supports only one instance with APP_ROLE=all)" }}
{{- end }}
{{- if not (or .Values.database.public.url .Values.database.public.existingSecret) }}
{{- fail "split.enabled=true needs the URL of the restricted public role: set database.public.url or database.public.existingSecret (deploy/postgres/roles.sql)" }}
{{- end }}
{{- if and .Values.database.public.url (not (regexMatch "^postgres(ql)?://" .Values.database.public.url)) }}
{{- fail "database.public.url must be a PostgreSQL URL (postgres://...)" }}
{{- end }}
{{- if and .Values.database.url .Values.database.public.url (eq .Values.database.url .Values.database.public.url) }}
{{- fail "database.public.url must use the restricted public role, not the same URL as database.url" }}
{{- end }}
{{- if and (not .Values.secrets.existingSecret) (not .Values.secrets.publicExistingSecret) (not .Values.secrets.subscriptionTokenKey) }}
{{- fail "split.enabled=true needs secrets.subscriptionTokenKey (or the key SUBSCRIPTION_TOKEN_KEY in secrets.publicExistingSecret or secrets.existingSecret): the public instance never gets SECRET_KEY" }}
{{- end }}
{{- if not .Values.split.admin.baseUrl }}
{{- fail "split.enabled=true needs split.admin.baseUrl, the URL of the admin domain (e.g. https://status.admin.example.com)" }}
{{- end }}
{{- if not (regexMatch "^https?://[^/?#]+$" .Values.split.admin.baseUrl) }}
{{- fail (printf "split.admin.baseUrl must be an http(s) URL without path or trailing slash, got %q" .Values.split.admin.baseUrl) }}
{{- end }}
{{- if eq (include "openstatuspage.urlHost" .Values.baseUrl) (include "openstatuspage.urlHost" .Values.split.admin.baseUrl) }}
{{- fail "split.admin.baseUrl must use another host than baseUrl: the public instance does not serve the management UI or its assets, so admin and public cannot share a domain" }}
{{- end }}
{{- end }}
{{- if and (not $pg) .Values.autoscaling.enabled }}
{{- fail "autoscaling.enabled=true needs PostgreSQL: SQLite runs exactly one replica" }}
{{- end }}
{{- end }}

{{/*
Volumes and mounts shared by every pod: /tmp, and /data (the SQLite volume, or
an emptyDir with PostgreSQL).
*/}}
{{- define "openstatuspage.volumes" -}}
{{- $root := .root }}
- name: tmp
  emptyDir:
    sizeLimit: {{ $root.Values.tmpSizeLimit }}
- name: data
{{- if and .sqlite }}
  persistentVolumeClaim:
    claimName: {{ default (printf "%s-data" (include "openstatuspage.fullname" $root)) $root.Values.persistence.existingClaim }}
{{- else }}
  emptyDir:
    sizeLimit: 64Mi
{{- end }}
{{- with $root.Values.extraVolumes }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/*
secretKeyRef env entry. Argument: dict "name" <env> "secret" <secret> "key" <key> "optional" <bool>.
*/}}
{{- define "openstatuspage.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .secret }}
      key: {{ .key }}
      {{- if .optional }}
      optional: true
      {{- end }}
{{- end }}

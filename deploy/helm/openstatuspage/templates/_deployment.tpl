{{/*
Environment of one instance. Secrets are referenced key by key (never with
envFrom), so every instance receives only the keys its role needs: the public
instance of split mode gets SUBSCRIPTION_TOKEN_KEY and the public role's
database URL, never SECRET_KEY.
Argument: dict "root" $ "role" <all|public|admin|worker>.
*/}}
{{- define "openstatuspage.env" -}}
{{- $root := .root }}
{{- $v := $root.Values }}
{{- $role := .role }}
{{- $pg := include "openstatuspage.postgres" $root }}
{{- $existing := $v.secrets.existingSecret }}
{{- $secret := include "openstatuspage.secretName" $root }}
- name: APP_ROLE
  value: {{ $role }}
{{- if eq $role "public" }}
- name: WORKER_ENABLED
  value: "false"
{{- else if eq $role "admin" }}
- name: WORKER_ENABLED
  value: "false"
{{- else if eq $role "worker" }}
- name: WORKER_ENABLED
  value: "true"
{{- end }}
- name: BASE_URL
  value: {{ ternary $v.split.admin.baseUrl $v.baseUrl (eq $role "admin") | quote }}
- name: PUBLIC_BASE_URL
  value: {{ $v.baseUrl | quote }}
{{- if $pg }}
- name: DB_PUBLIC_ROLE
  value: {{ $v.database.public.role | quote }}
{{- if eq $role "public" }}
{{ include "openstatuspage.secretEnv" (dict "name" "DATABASE_URL" "secret" (include "openstatuspage.dbPublicSecretName" $root) "key" (include "openstatuspage.dbPublicSecretKey" $root)) }}
{{- else }}
{{ include "openstatuspage.secretEnv" (dict "name" "DATABASE_URL" "secret" (include "openstatuspage.dbSecretName" $root) "key" (include "openstatuspage.dbSecretKey" $root)) }}
{{- end }}
{{- end }}
{{- /* SECRET_KEY: every role except public. */}}
{{- if ne $role "public" }}
{{ include "openstatuspage.secretEnv" (dict "name" "SECRET_KEY" "secret" $secret "key" "SECRET_KEY") }}
{{- end }}
{{- /* SUBSCRIPTION_TOKEN_KEY: required in split mode, optional otherwise. */}}
{{- if or $existing $v.secrets.subscriptionTokenKey }}
{{ include "openstatuspage.secretEnv" (dict "name" "SUBSCRIPTION_TOKEN_KEY" "secret" $secret "key" "SUBSCRIPTION_TOKEN_KEY" "optional" (and $existing (not $v.split.enabled))) }}
{{- end }}
{{- /* First administrator and OIDC client secret: where login is served. */}}
{{- if or (eq $role "all") (eq $role "admin") }}
{{- range $env, $value := dict "ADMIN_EMAIL" $v.secrets.adminEmail "ADMIN_PASSWORD" $v.secrets.adminPassword "OIDC_CLIENT_SECRET" $v.secrets.oidcClientSecret }}
{{- if or $existing $value }}
{{ include "openstatuspage.secretEnv" (dict "name" $env "secret" $secret "key" $env "optional" $existing) }}
{{- end }}
{{- end }}
{{- end }}
{{- /* SMTP password: the instances that send mails (the public one only queues them). */}}
{{- if and (ne $role "public") (or $existing $v.secrets.smtpPassword) }}
{{ include "openstatuspage.secretEnv" (dict "name" "SMTP_PASSWORD" "secret" $secret "key" "SMTP_PASSWORD" "optional" $existing) }}
{{- end }}
{{- with $v.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- with .component.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/*
One Deployment. Argument: dict
  "root" $                 chart root context
  "component" <name>       app (single instance) | public | admin | worker
  "role" <APP_ROLE>
  "values" <dict>          per-component overrides (split.<role>, or {} for app)
  "replicas" <int>
  "strategy" <dict>
  "sqlite" <bool>
*/}}
{{- define "openstatuspage.deployment" -}}
{{- $root := .root }}
{{- $v := $root.Values }}
{{- $c := .values }}
{{- $ctx := dict "root" $root "component" .component }}
{{- $name := include "openstatuspage.componentName" $ctx }}
{{- $startupFailures := int $v.probes.startup.failureThreshold }}
{{- if eq .role "public" }}{{ $startupFailures = mul $startupFailures 2 }}{{ end }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $name }}
  namespace: {{ $root.Release.Namespace }}
  labels:
    {{- include "openstatuspage.componentLabels" $ctx | nindent 4 }}
spec:
  {{- if not .autoscaled }}
  replicas: {{ .replicas }}
  {{- end }}
  revisionHistoryLimit: 5
  strategy:
    {{- toYaml .strategy | nindent 4 }}
  selector:
    matchLabels:
      {{- include "openstatuspage.componentSelectorLabels" $ctx | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "openstatuspage.componentSelectorLabels" $ctx | nindent 8 }}
        {{- with $v.podLabels }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      annotations:
        checksum/config: {{ include (print $root.Template.BasePath "/configmap.yaml") $root | sha256sum }}
        {{- if include "openstatuspage.createSecret" $root }}
        checksum/secret: {{ include (print $root.Template.BasePath "/secret.yaml") $root | sha256sum }}
        {{- end }}
        {{- with $v.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
        {{- with $c.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
    spec:
      serviceAccountName: {{ include "openstatuspage.serviceAccountName" $root }}
      # The app never talks to the Kubernetes API.
      automountServiceAccountToken: false
      enableServiceLinks: false
      {{- with $v.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $v.priorityClassName }}
      priorityClassName: {{ . }}
      {{- end }}
      terminationGracePeriodSeconds: {{ $v.terminationGracePeriodSeconds }}
      securityContext:
        {{- toYaml $v.podSecurityContext | nindent 8 }}
      containers:
        - name: openstatuspage
          image: {{ include "openstatuspage.image" $root | quote }}
          imagePullPolicy: {{ $v.image.pullPolicy }}
          ports:
            - name: http
              containerPort: 3000
              protocol: TCP
          env:
            {{- include "openstatuspage.env" (dict "root" $root "role" .role "component" $c) | trim | nindent 12 }}
          envFrom:
            - configMapRef:
                name: {{ include "openstatuspage.fullname" $root }}
            {{- with $v.extraEnvFrom }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
          {{- if $v.probes.startup.enabled }}
          startupProbe:
            httpGet:
              path: /api/health
              port: http
            periodSeconds: {{ $v.probes.startup.periodSeconds }}
            timeoutSeconds: {{ $v.probes.startup.timeoutSeconds }}
            failureThreshold: {{ $startupFailures }}
          {{- end }}
          {{- if $v.probes.readiness.enabled }}
          readinessProbe:
            httpGet:
              path: /api/health
              port: http
            periodSeconds: {{ $v.probes.readiness.periodSeconds }}
            timeoutSeconds: {{ $v.probes.readiness.timeoutSeconds }}
            failureThreshold: {{ $v.probes.readiness.failureThreshold }}
          {{- end }}
          {{- if $v.probes.liveness.enabled }}
          livenessProbe:
            httpGet:
              path: /api/health
              port: http
            periodSeconds: {{ $v.probes.liveness.periodSeconds }}
            timeoutSeconds: {{ $v.probes.liveness.timeoutSeconds }}
            failureThreshold: {{ $v.probes.liveness.failureThreshold }}
          {{- end }}
          resources:
            {{- toYaml (default $v.resources $c.resources) | nindent 12 }}
          securityContext:
            {{- toYaml $v.securityContext | nindent 12 }}
          volumeMounts:
            - name: tmp
              mountPath: /tmp
            - name: data
              mountPath: /data
            {{- with $v.extraVolumeMounts }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
      volumes:
        {{- include "openstatuspage.volumes" (dict "root" $root "sqlite" .sqlite) | trim | nindent 8 }}
      {{- with (default $v.nodeSelector $c.nodeSelector) }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with (default $v.tolerations $c.tolerations) }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with (default $v.affinity $c.affinity) }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $v.topologySpreadConstraints }}
      topologySpreadConstraints:
        {{- range . }}
        - {{- toYaml (omit . "labelSelector") | nindent 10 }}
          labelSelector:
            {{- if .labelSelector }}
            {{- toYaml .labelSelector | nindent 12 }}
            {{- else }}
            matchLabels:
              {{- include "openstatuspage.componentSelectorLabels" $ctx | nindent 14 }}
            {{- end }}
        {{- end }}
      {{- end }}
{{- end }}

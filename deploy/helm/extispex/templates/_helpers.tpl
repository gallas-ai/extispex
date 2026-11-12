{{/* The prefix of every resource name: the release name, with "extispex" unless it has it. */}}
{{- define "extispex.fullname" -}}
{{- if contains "extispex" .Release.Name -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-extispex" .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "extispex.labels" -}}
app.kubernetes.io/name: extispex
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ include "extispex.imageTag" . | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* Selector labels of one component; call with (dict "root" $ "component" "identity"). */}}
{{- define "extispex.selectorLabels" -}}
app.kubernetes.io/name: extispex
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "extispex.imageTag" -}}
{{- .Values.image.tag | default .Chart.AppVersion -}}
{{- end -}}

{{/* The image of one service; call with (dict "root" $ "image" "evaluation-worker"). */}}
{{- define "extispex.image" -}}
{{- printf "%s/%s-%s:%s" .root.Values.image.registry .root.Values.image.repository .image (include "extispex.imageTag" .root) -}}
{{- end -}}

{{- define "extispex.serviceUrl" -}}
{{- printf "http://%s-%s:%v" (include "extispex.fullname" .root) .component .port -}}
{{- end -}}

{{- define "extispex.serviceClientsSecretName" -}}
{{- .Values.serviceClients.existingSecret | default (printf "%s-service-clients" (include "extispex.fullname" .)) -}}
{{- end -}}

{{- define "extispex.requiredSecrets" -}}
{{- if not .Values.masterKey.existingSecret -}}
{{- fail "masterKey.existingSecret is required: create a Secret with the master key first, see deploy/helm/extispex/README.md." -}}
{{- end -}}
{{- if not .Values.database.existingSecret -}}
{{- fail "database.existingSecret is required: create a Secret with each service's database URL first, see deploy/helm/extispex/README.md." -}}
{{- end -}}
{{- end -}}

{{/* DATABASE_URL of one service from the database Secret; call with (dict "root" $ "service" "identity"). */}}
{{- define "extispex.databaseUrlEnv" -}}
- name: {{ upper .service }}_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .root.Values.database.existingSecret }}
      key: {{ index .root.Values.database.secretKeys .service }}
{{- end -}}

{{- define "extispex.masterKeyEnv" -}}
- name: MASTER_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.masterKey.existingSecret }}
      key: {{ .Values.masterKey.secretKey }}
{{- end -}}

{{/* Identity's address and the client secret of one service; call with (dict "root" $ "client" "prompt"). */}}
{{- define "extispex.identityClientEnv" -}}
- name: IDENTITY_URL
  value: {{ include "extispex.serviceUrl" (dict "root" .root "component" "identity" "port" 8082) }}
- name: IDENTITY_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "extispex.serviceClientsSecretName" .root }}
      key: {{ .client }}
{{- end -}}

{{- define "extispex.dataLifecycleEnv" -}}
{{- with .Values.dataLifecycle.intervalMilliseconds }}
- name: DATA_LIFECYCLE_INTERVAL_MILLISECONDS
  value: {{ . | quote }}
{{- end }}
{{- end -}}

{{/* HTTPS_PROXY, HTTP_PROXY and NO_PROXY, with the chart's own Services always direct. */}}
{{- define "extispex.proxyEnv" -}}
{{- if or .Values.proxy.httpsProxy .Values.proxy.httpProxy -}}
{{- $fullname := include "extispex.fullname" . -}}
{{- $internal := list "localhost" "127.0.0.1" "::1" -}}
{{- range list "identity" "telemetry" "prompt" "evaluation" "gateway" -}}
{{- $internal = append $internal (printf "%s-%s" $fullname .) -}}
{{- $internal = append $internal (printf "%s-%s.%s.svc" $fullname . $.Release.Namespace) -}}
{{- end -}}
{{- $noProxy := join "," (compact (append $internal .Values.proxy.noProxy)) }}
{{- if .Values.proxy.httpsProxy }}
- name: HTTPS_PROXY
  value: {{ .Values.proxy.httpsProxy | quote }}
{{- end }}
{{- if .Values.proxy.httpProxy }}
- name: HTTP_PROXY
  value: {{ .Values.proxy.httpProxy | quote }}
{{- end }}
- name: NO_PROXY
  value: {{ $noProxy | quote }}
{{- end -}}
{{- end -}}

{{/* The parts of a pod spec that every component shares. */}}
{{- define "extispex.podSpecCommon" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- if .Values.serviceAccountName }}
serviceAccountName: {{ .Values.serviceAccountName }}
{{- end }}
automountServiceAccountToken: false
securityContext:
  {{- toYaml .Values.podSecurityContext | nindent 2 }}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* The deno command of one entry point, with the permissions the Dockerfiles give it. */}}
{{- define "extispex.denoCommand" -}}
- deno
- run
- --cached-only
- --allow-net
- --allow-env
- --allow-read
- --allow-write
- --allow-ffi
- --allow-sys
- {{ . }}
{{- end -}}

{{/* A writable /tmp, as the root file system is read-only. */}}
{{- define "extispex.tmpVolumeMount" -}}
- name: tmp
  mountPath: /tmp
{{- end -}}
{{- define "extispex.tmpVolume" -}}
- name: tmp
  emptyDir: {}
{{- end -}}

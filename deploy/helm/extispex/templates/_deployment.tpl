{{/*
A Deployment of one component. Call with a dict:
  root, component, image, entryPoint, values (the component's values), env (YAML list as text),
  and optionally ports (list of dicts with name and port), volumeMounts and volumes (YAML text).
*/}}
{{- define "extispex.deployment" -}}
{{- $root := .root -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "extispex.fullname" $root }}-{{ .component }}
  labels:
    {{- include "extispex.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ .component }}
spec:
  replicas: {{ .values.replicas }}
  selector:
    matchLabels:
      {{- include "extispex.selectorLabels" (dict "root" $root "component" .component) | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "extispex.selectorLabels" (dict "root" $root "component" .component) | nindent 8 }}
      {{- with $root.Values.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
    spec:
      {{- include "extispex.podSpecCommon" $root | nindent 6 }}
      containers:
        - name: {{ .component }}
          image: {{ include "extispex.image" (dict "root" $root "image" .image) }}
          imagePullPolicy: {{ $root.Values.image.pullPolicy }}
          command:
            {{- include "extispex.denoCommand" .entryPoint | nindent 12 }}
          securityContext:
            {{- toYaml $root.Values.securityContext | nindent 12 }}
          env:
            - name: NO_COLOR
              value: "1"
            {{- .env | nindent 12 }}
            {{- with .values.extraEnv }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
          {{- with .ports }}
          ports:
            {{- range . }}
            - name: {{ .name }}
              containerPort: {{ .port }}
            {{- end }}
          {{- end }}
          {{- if .healthPort }}
          readinessProbe:
            httpGet:
              path: /health
              port: {{ .healthPort }}
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /health
              port: {{ .healthPort }}
            initialDelaySeconds: 30
            periodSeconds: 10
          {{- end }}
          {{- with .values.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          volumeMounts:
            {{- include "extispex.tmpVolumeMount" $root | nindent 12 }}
            {{- with .volumeMounts }}
            {{- . | nindent 12 }}
            {{- end }}
      volumes:
        {{- include "extispex.tmpVolume" $root | nindent 8 }}
        {{- with .volumes }}
        {{- . | nindent 8 }}
        {{- end }}
{{- end -}}

{{/* A ClusterIP Service for one component; call with (dict "root" $ "component" "prompt" "ports" (list ...)). */}}
{{- define "extispex.service" -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "extispex.fullname" .root }}-{{ .component }}
  labels:
    {{- include "extispex.labels" .root | nindent 4 }}
    app.kubernetes.io/component: {{ .component }}
spec:
  type: ClusterIP
  selector:
    {{- include "extispex.selectorLabels" (dict "root" .root "component" .component) | nindent 4 }}
  ports:
    {{- range .ports }}
    - name: {{ .name }}
      port: {{ .port }}
      targetPort: {{ .name }}
      {{- if .appProtocol }}
      appProtocol: {{ .appProtocol }}
      {{- end }}
    {{- end }}
{{- end -}}

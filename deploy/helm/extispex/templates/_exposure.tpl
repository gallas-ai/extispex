{{/* The exposed endpoints: name, values, the Service and port behind them, and Ingress annotations. */}}
{{- define "extispex.exposedEndpoints" -}}
{{- $exposure := .Values.exposure -}}
- name: gateway
  host: {{ $exposure.gateway.host | quote }}
  tlsSecretName: {{ $exposure.gateway.tlsSecretName | quote }}
  component: gateway
  port: http
  annotations: {{ $exposure.ingress.gatewayAnnotations | toJson }}
- name: otlp-http
  host: {{ $exposure.otlpHttp.host | quote }}
  tlsSecretName: {{ $exposure.otlpHttp.tlsSecretName | quote }}
  component: telemetry
  port: otlp-http
  annotations: {{ $exposure.ingress.otlpHttpAnnotations | toJson }}
- name: otlp-grpc
  host: {{ $exposure.otlpGrpc.host | quote }}
  tlsSecretName: {{ $exposure.otlpGrpc.tlsSecretName | quote }}
  component: telemetry
  port: otlp-grpc
  annotations: {{ $exposure.ingress.otlpGrpcAnnotations | toJson }}
{{- end -}}

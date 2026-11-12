#!/usr/bin/env bash
# Lints the chart and checks what each exposure type renders. Needs helm. The CI job
# `End-to-end tests (Helm)` runs it before installing the chart into kind.
set -euo pipefail

chart="$(cd "$(dirname "$0")" && pwd)/extispex"
required=(--set masterKey.existingSecret=master-key --set database.existingSecret=database)
hosts=(--set exposure.gateway.host=extispex.example --set exposure.otlpHttp.host=otlp.example
  --set exposure.otlpGrpc.host=otlp-grpc.example)

fail() { echo "check-chart: $*" >&2; exit 1; }
count_kind() { grep -c "^kind: $1\$" || true; }

helm lint --strict "$chart" "${required[@]}"

rendered="$(helm template extispex "$chart" "${required[@]}" "${hosts[@]}")"
[ "$(count_kind Ingress <<< "$rendered")" = 3 ] || fail "ingress should render three Ingresses"
[ "$(count_kind Route <<< "$rendered")" = 0 ] || fail "ingress should render no Route"
[ "$(count_kind Job <<< "$rendered")" = 4 ] || fail "every service should have a migration Job"
grep -q "helm.sh/hook: pre-install,pre-upgrade" <<< "$rendered" || fail "the Jobs should be hooks"
[ "$(grep -c "value: check" <<< "$rendered")" = 5 ] ||
  fail "every service with a database should start with DATABASE_MIGRATIONS=check"
if grep -q "runAsUser" <<< "$rendered"; then fail "the chart should leave the UID to the cluster"; fi

rendered="$(helm template extispex "$chart" "${required[@]}" "${hosts[@]}" \
  --set exposure.type=route --set telemetry.grpcTls.existingSecret=otlp-grpc-tls)"
[ "$(count_kind Route <<< "$rendered")" = 3 ] || fail "route should render three Routes"
[ "$(count_kind Ingress <<< "$rendered")" = 0 ] || fail "route should render no Ingress"
grep -q "termination: passthrough" <<< "$rendered" || fail "OTLP/gRPC should pass TLS through"

if helm template extispex "$chart" "${required[@]}" "${hosts[@]}" --set exposure.type=route \
  > /dev/null 2>&1; then
  fail "a Route for OTLP/gRPC without telemetry.grpcTls should be refused"
fi

rendered="$(helm template extispex "$chart" "${required[@]}" "${hosts[@]}" --set exposure.type=none)"
[ "$(count_kind Ingress <<< "$rendered")$(count_kind Route <<< "$rendered")" = 00 ] ||
  fail "none should render neither Ingress nor Route"

if helm template extispex "$chart" "${required[@]}" --set exposure.type=gateway > /dev/null 2>&1; then
  fail "an unknown exposure type should be refused"
fi
if helm template extispex "$chart" > /dev/null 2>&1; then
  fail "the master key and database Secrets should be required"
fi

rendered="$(helm template extispex "$chart" "${required[@]}" --set proxy.httpsProxy=http://proxy:3128 \
  --set proxy.noProxy=.company.example)"
grep -q 'value: "localhost,127.0.0.1,::1,extispex-identity,.*,.company.example"' <<< "$rendered" ||
  fail "NO_PROXY should keep the chart's Services direct and add proxy.noProxy"

echo "check-chart: the chart renders as expected"

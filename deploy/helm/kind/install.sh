#!/usr/bin/env bash
# Installs the Helm chart into a local kind cluster for the end-to-end tests, as the
# `End-to-end tests (Helm)` CI job does, and writes the E2E_* variables that point the tests at it.
#
#   deploy/helm/kind/install.sh
#   set -a && . "$E2E_WORK_DIR/e2e.env" && set +a && E2E_DEPLOYMENT=external deno task test:e2e
#
# Needs docker, kind, kubectl, helm and openssl. Environment:
#   KIND_CLUSTER_NAME   the cluster, created when missing (default extispex)
#   E2E_WORK_DIR        where the TLS files and e2e.env go (default: a new temporary directory)
#   SKIP_IMAGE_BUILD=1  reuse the images tagged :kind that are already built
#
# The cluster runs PostgreSQL in place of the customer's, ingress-nginx in front of the Gateway and
# Telemetry, an HTTP proxy that the Evaluation worker must use, and the sample Target behind it.
set -euo pipefail

cluster_name="${KIND_CLUSTER_NAME:-extispex}"
namespace=extispex
release=extispex
kind_directory="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$kind_directory/../../.." && pwd)"
work_directory="${E2E_WORK_DIR:-$(mktemp -d)}"
mkdir -p "$work_directory"
ingress_nginx_manifest="https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.13.3/deploy/static/provider/kind/deploy.yaml"
images=(identity telemetry prompt evaluation evaluation-worker gateway)

# The values the e2e tests sign in and send telemetry with.
api_key="extispex_e2eProjectApiKey00000000000000000000000"
admin_email="admin@e2e.extispex.test"
admin_password="e2e-admin-password"

log() { printf '\n== %s\n' "$*"; }

if ! kind get clusters | grep -qx "$cluster_name"; then
  log "Creating the kind cluster $cluster_name"
  kind create cluster --name "$cluster_name" --config "$kind_directory/kind-config.yaml" --wait 120s
fi
kubectl config use-context "kind-$cluster_name" > /dev/null

if [ "${SKIP_IMAGE_BUILD:-}" != "1" ]; then
  for image in "${images[@]}"; do
    log "Building the $image image"
    docker build -q -f "$repository_root/deploy/docker/$image.Dockerfile" \
      -t "ghcr.io/gallas-ai/extispex-$image:kind" "$repository_root"
  done
fi
log "Loading the images into the cluster"
image_references=()
for image in "${images[@]}"; do image_references+=("ghcr.io/gallas-ai/extispex-$image:kind"); done
kind load docker-image --name "$cluster_name" "${image_references[@]}"

log "Installing ingress-nginx"
kubectl apply -f "$ingress_nginx_manifest" > /dev/null
# The controller mounts the certificate that the admission Jobs create, so its readiness covers
# them; the Jobs delete themselves once finished.
kubectl wait --namespace ingress-nginx --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller --timeout=180s

log "Starting PostgreSQL and the egress proxy"
kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f - > /dev/null
kubectl -n "$namespace" apply -f "$kind_directory/postgres.yaml" -f "$kind_directory/egress-proxy.yaml"
kubectl -n "$namespace" rollout status deployment/postgres deployment/egress-proxy --timeout=600s

log "Creating the Secrets the chart expects"
apply_secret() { kubectl -n "$namespace" create secret "$@" --dry-run=client -o yaml | kubectl apply -f - > /dev/null; }
if ! kubectl -n "$namespace" get secret extispex-master-key > /dev/null 2>&1; then
  apply_secret generic extispex-master-key --from-literal=master-key="$(openssl rand -base64 32)"
fi
database_server="postgresql://extispex:extispex@postgres:5432"
apply_secret generic extispex-database \
  --from-literal=identity-database-url="$database_server/identity" \
  --from-literal=telemetry-database-url="$database_server/telemetry" \
  --from-literal=prompt-database-url="$database_server/prompt" \
  --from-literal=evaluation-database-url="$database_server/evaluation"
apply_secret generic extispex-bootstrap \
  --from-literal=project-api-key="$api_key" \
  --from-literal=admin-email="$admin_email" \
  --from-literal=admin-password="$admin_password"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=otlp-grpc.extispex.localhost \
  -addext "subjectAltName=DNS:otlp-grpc.extispex.localhost" \
  -keyout "$work_directory/otlp-grpc.key" -out "$work_directory/otlp-grpc.crt" 2> /dev/null
apply_secret tls extispex-otlp-grpc-tls \
  --cert="$work_directory/otlp-grpc.crt" --key="$work_directory/otlp-grpc.key"

log "Installing the chart"
helm upgrade --install "$release" "$repository_root/deploy/helm/extispex" -n "$namespace" \
  -f "$kind_directory/values.yaml" --wait --timeout 10m
# A second release is an upgrade: the migration Jobs run again and find nothing to do, and the
# changed annotation rolls every Deployment, whose new pods start in check mode.
log "Upgrading the release"
helm upgrade "$release" "$repository_root/deploy/helm/extispex" -n "$namespace" \
  -f "$kind_directory/values.yaml" --set-string podAnnotations.upgrade-check="$(date +%s)" \
  --wait --timeout 10m

log "Starting the sample Target"
kubectl -n "$namespace" apply -f "$kind_directory/sample-target.yaml"
kubectl -n "$namespace" rollout status deployment/sample-target --timeout=180s

for attempt in $(seq 1 60); do
  if curl -sf http://extispex.localhost:18080/health > /dev/null &&
    curl -sf http://otlp.extispex.localhost:18080/health > /dev/null; then
    break
  fi
  if [ "$attempt" = 60 ]; then
    echo "The Ingress did not reach the Gateway and Telemetry." >&2
    exit 1
  fi
  sleep 2
done

cat > "$work_directory/e2e.env" << ENVIRONMENT
E2E_DEPLOYMENT=external
E2E_GATEWAY_URL=http://extispex.localhost:18080
E2E_OTLP_HTTP_URL=http://otlp.extispex.localhost:18080
E2E_OTLP_GRPC_ADDRESS=otlp-grpc.extispex.localhost:18443
E2E_GRPC_ROOT_CERTIFICATE_FILE=$work_directory/otlp-grpc.crt
E2E_API_KEY=$api_key
E2E_ADMIN_EMAIL=$admin_email
E2E_ADMIN_PASSWORD=$admin_password
E2E_SAMPLE_TARGET_URL=http://sample-target.$namespace.svc.cluster.local:8090/evaluate
ENVIRONMENT
log "Ready. The e2e variables are in $work_directory/e2e.env"

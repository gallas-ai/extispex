#!/usr/bin/env bash
# Rotates the master key of the chart that install.sh installed, as an operator would, and checks
# that nothing sealed is lost: the reseal Jobs seal the signing keys and Target credentials again,
# and after the previous key is removed Identity starts, which it refuses when it cannot open a
# signing key, and people sign in. Run it after the e2e tests, which leave signing keys and Target
# credentials behind.
#
#   deploy/helm/kind/rotate-master-key.sh
set -euo pipefail

namespace=extispex
release=extispex
kind_directory="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$kind_directory/../../.." && pwd)"
chart="$repository_root/deploy/helm/extispex"

log() { printf '\n== %s\n' "$*"; }

log "Creating a new master key and keeping the old one as the previous key"
kubectl -n "$namespace" get secret extispex-master-key -o json |
  jq '.metadata = {name: "extispex-previous-master-key"}' | kubectl -n "$namespace" apply -f - > /dev/null
kubectl -n "$namespace" create secret generic extispex-master-key \
  --from-literal=master-key="$(openssl rand -base64 32)" --dry-run=client -o yaml |
  kubectl apply -f - > /dev/null

log "Upgrading with both keys; the reseal Jobs run after the rollout"
helm upgrade "$release" "$chart" -n "$namespace" -f "$kind_directory/values.yaml" \
  --set masterKey.previous.existingSecret=extispex-previous-master-key \
  --set-string podAnnotations.master-key-rotation=both-keys --wait --timeout 10m
for service in identity evaluation; do
  kubectl -n "$namespace" logs "job/$release-reseal-$service"
done
kubectl -n "$namespace" logs "job/$release-reseal-identity" |
  grep -q '"signingKeys":{"resealedCount":[1-9]' || {
  echo "The reseal Job sealed no signing key again." >&2
  exit 1
}
kubectl -n "$namespace" logs "job/$release-reseal-evaluation" |
  grep -q '"targetCredentials":{"resealedCount":[1-9]' || {
  echo "The reseal Job sealed no Target credential again." >&2
  exit 1
}

log "Upgrading with the new key alone"
helm upgrade "$release" "$chart" -n "$namespace" -f "$kind_directory/values.yaml" \
  --set-string podAnnotations.master-key-rotation=new-key --wait --timeout 10m

log "Signing in, which opens the signing key with the new master key alone"
cookie_jar="$(mktemp)"
curl -sf -c "$cookie_jar" -H 'content-type: application/json' \
  -d '{"email":"admin@e2e.extispex.test","password":"e2e-admin-password"}' \
  http://extispex.localhost:18080/v1/sign-in > /dev/null
access_token="$(curl -sf -b "$cookie_jar" -H 'content-type: application/json' -d '{}' \
  http://extispex.localhost:18080/v1/sign-in/access-tokens | jq -r .accessToken)"
curl -sf -H "authorization: Bearer $access_token" http://extispex.localhost:18080/v1/signing-keys |
  jq -e '.keys | map(select(.state == "signing")) | length == 1' > /dev/null
log "The master key was rotated without losing a signing key or a Target credential"

# Extispex Helm chart

Deploys every Extispex service from its own image to Kubernetes or OpenShift, on your PostgreSQL.
The chart does not install PostgreSQL. Containers run as non-root with whatever UID the cluster
assigns, as OpenShift requires by default. All values are in [values.yaml](values.yaml).

## Before installing

Create two Secrets in the release's namespace:

```sh
# The master key encrypts Target credentials and Identity's signing keys. Keep a copy.
kubectl create secret generic extispex-master-key \
  --from-literal=master-key="$(openssl rand -base64 32)"

# Each service's own database; one server may host all four.
kubectl create secret generic extispex-database \
  --from-literal=identity-database-url=postgresql://extispex:…@db.company.example:5432/identity \
  --from-literal=telemetry-database-url=postgresql://extispex:…@db.company.example:5432/telemetry \
  --from-literal=prompt-database-url=postgresql://extispex:…@db.company.example:5432/prompt \
  --from-literal=evaluation-database-url=postgresql://extispex:…@db.company.example:5432/evaluation
```

A user that may create databases gets them created on first install. Otherwise create the four
databases first; the user then needs to own them, or at least to create tables in them.

## Installing

```sh
helm install extispex oci://ghcr.io/gallas-ai/charts/extispex --version 1.2.3 \
  --set masterKey.existingSecret=extispex-master-key \
  --set database.existingSecret=extispex-database \
  --set exposure.gateway.host=extispex.company.example \
  --set exposure.otlpHttp.host=otlp.extispex.company.example \
  --set exposure.otlpGrpc.host=otlp-grpc.extispex.company.example \
  --set exposure.otlpGrpc.tlsSecretName=otlp-grpc-tls
```

The chart's version and its images' tag are the same release: chart 1.2.3 runs the images `1.2.3`.

## Database migrations

Before every install and upgrade, a Job per service applies that service's migrations (Helm hooks
`pre-install` and `pre-upgrade`). The services then start with `DATABASE_MIGRATIONS=check` and
refuse to start while a migration is pending. A failed Job stops the release and leaves the previous
version running; its pod stays for `kubectl logs` until the next attempt. `helm rollback` does not
undo migrations. See
[ADR 0019](../../../docs/adr/0019-migrations-in-a-helm-hook-job-and-services-that-only-check.md).

## Exposure

`exposure.type` chooses how the Instance is reached; a host left empty is not exposed.

| `exposure.type`     | Renders                                    | OTLP/gRPC                                                                                                                                                                             |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingress` (default) | One Ingress per host                       | The Ingress controller balances each call. The default annotations suit ingress-nginx, which speaks HTTP/2 only with TLS, so set `exposure.otlpGrpc.tlsSecretName`                    |
| `route`             | One OpenShift Route per host               | Passthrough: Telemetry terminates TLS with `telemetry.grpcTls.existingSecret`, a `kubernetes.io/tls` Secret, so the router keeps HTTP/2 end to end. The UI and OTLP/HTTP use edge TLS |
| `none`              | Nothing; point your load balancer yourself | Use an L7 load balancer or client-side balancing: a gRPC client keeps one long-lived HTTP/2 connection, so an L4 balancer sends all of its calls to one replica                       |

The Gateway counts `gateway.trustedProxyCount` proxies in `X-Forwarded-For`, 1 by default for the
Ingress controller or router.

## Calling Targets, LLM providers and webhooks from the cluster

The Evaluation worker calls Targets for Server-Driven Execution, LLM providers for Grading
Evaluators and LLM Summaries, and SMTP servers and Teams webhooks for Reports. It calls only what
`evaluationWorker.allowedDestinations`, `llmProviderAllowedDestinations` and
`reportAllowedDestinations` list, such as `agent.company.example:443,*.internal.example`. It reaches
them through the cluster's network, so the namespace's egress rules (NetworkPolicy, an egress
firewall) must allow them too. Report links point to `evaluationWorker.publicUiUrl`, by default
`https://<exposure.gateway.host>`.

When these destinations are reachable only through an HTTP proxy, set `proxy.httpsProxy` and
`proxy.httpProxy`, for example `http://proxy.company.example:3128`, and `proxy.noProxy` for
destinations to call directly. The worker sends `https://` destinations through a CONNECT tunnel and
still checks their certificate itself; a private certificate authority goes in the ConfigMap that
`evaluationWorker.extraCaCertificates` names. SMTP does not go through the proxy. Identity uses the
same proxy to reach the OIDC provider. The chart adds its own Services to `NO_PROXY`, so calls
inside the Instance stay direct.

Through a proxy, the proxy resolves the destination's name, so the allowlist must name the host: a
CIDR range then allows only an address written in the URL.

## First start

`bootstrap.existingSecret` names a Secret with `project-api-key` (the first Project's API key, at
least 32 characters), and `admin-email` and `admin-password` (a first administrator, which needs
`identity.localAccounts: enabled`). For OIDC sign-in set `identity.oidc.*`.

## Testing the chart

`deploy/helm/check-chart.sh` lints the chart and checks what each exposure type renders.
`deploy/helm/kind/install.sh` installs it into a local kind cluster with ingress-nginx, PostgreSQL,
an egress proxy and the sample Target, upgrades it once, and writes the variables that run the
end-to-end tests against it, as the CI job `End-to-end tests (Helm)` does.

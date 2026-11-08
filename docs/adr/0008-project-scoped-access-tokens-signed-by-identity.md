---
status: accepted
---

# Project-scoped access tokens, signed by Identity with ES256 and verified through its JWKS

Identity signs short-lived access tokens, ES256 JWTs that last five minutes. A token carries at most
one Project and the caller's Role there, so the REST paths keep no Project in them and a request's
Project comes from its credentials, as it does for an API key. The browser keeps only an HttpOnly
sign-in cookie and asks for a new token when the user switches Projects. Identity keeps its key pair
in its own database and publishes the public key at `/internal/v1/jwks.json`; every service verifies
tokens locally with the keys it read from there.

```text
POST /v1/sign-in/access-tokens {"projectId": "0195…"}  + cookie extispex_sign_in
→ {"accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6IjAxOTUuLi4ifQ…", "role": "editor"}

{ "alg": "ES256", "kid": "0195…" }
{ "sub": "user:0195…", "project": "0195…", "role": "editor",
  "iss": "extispex-identity", "aud": "extispex", "iat": 1794211200, "exp": 1794211500 }
```

```ts
// packages/service-runtime: what Telemetry and Prompt run for every request with a JWT
const { payload } = await jwtVerify(token, localKeySet, {
  algorithms: ["ES256"],
  issuer,
  audience,
});
// → { projectId: payload.project, role: payload.role }; a token without a Project gets 401
```

This is how OpenStack Keystone scopes a token to one project after an unscoped sign-in, and how a
Kubernetes service account token or an AWS STS session is bound to one audience. Keycloak, Ory Hydra
and Auth0 publish their keys as a JWKS the same way, and Hydra keeps them in its database. A token
stays small however many Projects a user has, and a service's check is a signature and two claims.
Services use the same scoping: a service token for a Project carries `viewer` there.

## Considered Options

- **Project in every path, such as `/v1/projects/{projectId}/prompts` (rejected):** GitLab and
  Sentry do this. The URL says which Project a request touches, and one token can carry every Role.
  It was rejected because it breaks every existing endpoint, API keys would have to match the path,
  and a token with all Roles grows with the number of Projects.
- **A key shared through configuration, or HS256 with a shared secret (rejected):** No endpoint is
  needed. But every service holding the secret could sign tokens, rotating it means restarting every
  service, and the local image would have to generate and distribute it.
- **The JWT in an HttpOnly cookie that every service reads (rejected):** No token handling in the
  UI. But every service would need CSRF protection, and the Gateway would have to forward cookies to
  all of them. The cookie now reaches only Identity's sign-in endpoints.
- **EdDSA (rejected for now):** Smaller keys and signatures, and WebCrypto supports it. ES256 was
  chosen because every JWT library, including those in older JVMs and .NET versions that customers'
  tools may use, verifies it.

## Consequences

- Switching Projects in the UI gets a new token, and pages for the previous Project reload.
- A removed Role or a deactivated user keeps working in other services for up to five minutes.
  Identity's own endpoints read the user from the database on every request, so access management is
  never stale.
- Whoever can read Identity's database can sign tokens, because the private key is stored there in
  plain form. Encrypting it with the master key that step 6 introduces would close that.
- Rotation needs only a second row in `signing_keys` and a rule for which key signs; services
  already read the keys again when they meet an unknown key ID.
- Scripts keep API keys, which are long-lived and need no sign-in; tokens are for the UI and for
  services.

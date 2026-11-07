---
status: accepted
---

# Prefixed random API keys, stored as SHA-256 hashes and resolved through Identity

A Project API key is `extispex_` followed by 43 random base62 characters (256 bits), for example
`extispex_7Hq2kP9xVb3mRt8LwN4cYf6ZjD1sGa5eUo0iKh2QpXr`. Identity stores only the key's SHA-256 hash,
under a unique index, and its first 17 characters for display. Telemetry and Prompt do not read
Identity's tables. They ask Identity which Project a key belongs to and cache each answer, positive
or negative, for 60 seconds.

```ts
// packages/service-runtime: what Telemetry and Prompt run for every request
const projectId = await projectResolver.resolveProjectId(apiKey);
//   cached for 60 s, keyed by SHA-256(apiKey), otherwise:
//   POST /internal/v1/api-keys/resolve {"apiKey": "extispex_…"} → 200 {"projectId"} | 404

// services/identity: the lookup is one indexed query
apiKeys.findOne({ keyHash: sha256Hex(apiKey), revokedAt: null });
```

The prefix makes a leaked key recognisable to people and to secret scanners, as GitHub's `ghp_` and
GitLab's `glpat-` do. A fast hash is enough because the key is long and random: unlike a password,
it cannot be guessed, so a slow hash such as argon2 would only add latency to every OTLP batch.
GitHub stores its tokens' SHA-256 hashes for the same reason. The 60-second cache bounds how late a
revocation takes effect, which is what [architecture.md](../architecture.md#requests) promises.

## Considered Options

- **A slow password hash such as argon2 or bcrypt (rejected):** It protects low-entropy secrets
  against offline guessing, which 256 random bits do not need. It would also rule out a lookup by
  hash: the key would have to carry an ID to find the row, and each cache miss would cost tens of
  milliseconds of CPU.
- **Signed keys that services verify themselves, like a JWT or a Biscuit token (rejected):** No call
  to Identity would be needed. But revoking a key still needs a list that every service checks,
  which brings back the call or a broker that
  [ADR 0003](0003-independent-services-without-a-broker.md) rules out, and such keys are much longer
  than a header value people paste.
- **Telling services about a revocation at once instead of caching (rejected):** It needs a broker
  or a list of every service replica, neither of which v1 has. A minute's delay is acceptable for
  revocation and matches what the architecture already promised.
- **Keys without a prefix, as `STATIC_API_KEYS` allowed (rejected):** Any string worked, so a leaked
  key could not be recognised, and the UI could not show which key a row is without storing it.

## Consequences

- The key format becomes part of every customer's configuration. A later format needs a new prefix
  so that old keys keep working.
- A revoked key, or any key of a deleted Project, keeps working for up to 60 seconds in each service
  replica that used it recently.
- While Identity is down, keys used in the last minute keep working; others get `503` with
  `Retry-After`, and gRPC `UNAVAILABLE`, which OTLP exporters retry.
- A configured key such as `BOOTSTRAP_PROJECT_API_KEY` may lack the prefix. It must be at least 32
  characters long, and its first 8 characters are shown.
- The resolution endpoint is internal and unauthenticated until service tokens exist (roadmap step
  3), so Identity's port must stay inside the Instance's network.

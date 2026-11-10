---
status: accepted
---

# Secrets are sealed with keys derived from one master key

Evaluation stores Target credentials, and step 7 adds LLM provider keys. Identity stores the private
key that signs every access token. Anyone who can read a database backup must not be able to call a
customer's application or sign a token, so these values are encrypted before they are stored.

We use one master key per Instance, 32 random bytes from `MASTER_KEY` (a Kubernetes Secret in
production) or, in the local image, from `/data/master-key`, which it creates on first start. Each
purpose derives its own AES-256-GCM key from it with HKDF-SHA256: `evaluation-target-credential` and
`identity-signing-key` today. Each sealed value is bound to its record as associated data: a Target
credential to the Target's ID, a signing key to its key ID. It is stored as
`aes256gcm.v1.<IV>.<ciphertext>`.

```ts
const cipher = await createSecretCipher(masterKey, "evaluation-target-credential");
const sealed = await cipher.seal("Bearer abc", targetId); // aes256gcm.v1.…
await cipher.open(sealed, targetId); // "Bearer abc"
await cipher.open(sealed, otherTargetId); // rejects
```

## Considered Options

- **One master key with a derived key per purpose (chosen):** one secret to provision and back up,
  and a value sealed for one purpose cannot be opened for another, even though every service that
  needs the key holds the same one.
- **A separate key per service:** limits what one leaked environment exposes, but triples what an
  operator provisions, and the all-in-one process would hold every key anyway.
- **An external key service such as Vault or a cloud KMS:** the strongest separation, but Vault
  integrations are outside v1, and the local image must work without dependencies.

## Consequences

- Losing the master key loses every Target credential and provider key; users enter them again.
  Identity refuses to start with a key that cannot open its signing key, rather than failing at the
  first sign-in. Deleting the rows of `signing_keys` then creates a new key, and every token issued
  before stops working within five minutes.
- Signing keys stored in plain text by an earlier version are encrypted when Identity starts. The
  update applies only to a value that is still plain text, so replicas starting together are safe.
- Rotating the master key is not built. The version in the stored prefix leaves room for a key ID
  and for re-encrypting values with a new key.
- The binding to a record means a sealed value copied to another row does not open, so restoring one
  table from an older backup keeps working only for rows whose IDs did not change.

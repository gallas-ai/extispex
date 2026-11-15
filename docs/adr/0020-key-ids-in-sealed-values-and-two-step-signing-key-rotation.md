---
status: accepted
---

# Sealed values name their master key, and signing keys rotate in two steps

ADR 0013 left two rotations open. The master key encrypts every stored secret; replacing it meant
losing them. Identity's signing key signs every access token; replacing it meant deleting its row
and breaking every token for up to five minutes.

## Master key

A sealed value now names the master key that sealed it: `aes256gcm.v2.<key ID>.<IV>.<ciphertext>`.
The key ID is eight bytes derived from the master key with HKDF under its own label, so it
identifies the key without revealing anything about it and needs no configuration. During a rotation
a service holds two keys: `MASTER_KEY` seals and opens, `PREVIOUS_MASTER_KEY` only opens. A value
from before key IDs (`aes256gcm.v1.…`) is tried with both.

```text
1. MASTER_KEY=new, PREVIOUS_MASTER_KEY=old   every value opens; new values are sealed with new
2. reseal-secrets (Identity, Evaluation)     every value is sealed again with new
3. MASTER_KEY=new                            old is gone
```

The `reseal-secrets` command of Identity and of Evaluation opens each stored value and seals it
again with the current key, replacing it only if it is still the value read, so it is safe beside
running replicas and safe to run twice. It covers Identity's signing keys and Evaluation's Target
credentials, SMTP passwords, Teams webhook URLs and LLM provider API keys. The Helm chart runs it in
a `post-install`/`post-upgrade` Job when `masterKey.previous` is set; the all-in-one process runs it
at start when `PREVIOUS_MASTER_KEY` is set.

## Signing key

Identity keeps several keys and publishes all of them in its JWKS. The key activated last signs;
keys from before rotation were never activated, and then the oldest signs, as before. An Instance
admin rotates in two steps, in the UI or through `/v1/signing-keys`:

1. **Add** a key. It is published at once but may sign only after a minute
   (`SIGNING_KEY_PUBLICATION_SECONDS`): a service reads the keys again for an unknown key ID at most
   every 30 seconds, so by then every service can know it.
2. **Activate** it. The previous key retires and stays published for the longest token lifetime
   (five minutes), plus the 30 seconds other replicas may still sign with it, plus a minute for
   clocks, and is then removed.

## Considered Options

- **A key ID that the operator names**, such as `MASTER_KEY_ID=2026-11`: readable, but one more
  value to keep in step with the key, and a wrong one would make values unreadable. A derived ID
  cannot be wrong.
- **Re-encrypting inside every service at start**: no command, but replicas of a rolling upgrade
  would all do it at once, and a failure would show only as a pod that does not start.
- **Rotating the signing key on a schedule**: no human step, but it needs a scheduler in Identity
  and a decision nobody asked for; companies rotate when their policy or an incident says so.
- **One step for the signing key** (add and sign at once): simpler, but a service that read the keys
  less than 30 seconds earlier refuses the new tokens until it may read them again.

## Consequences

- Every value sealed from now on carries a key ID, so an older version cannot open it. Downgrading
  past this version after secrets were written is not possible without re-entering them.
- A value whose key ID matches neither key fails with a message that names both variables.
- The UI shows the keys and their state to Instance admins only; the private keys never leave
  Identity.

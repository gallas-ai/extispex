---
status: accepted
---

# A user from the directory is linked to their first OIDC sign-in by email, once

SCIM and imported files create users before they ever sign in, so such a user has an email but no
`iss` and `sub`. The first OIDC sign-in whose verified email matches a user that the directory or a
file created, and who has neither a password nor an `iss` and `sub`, takes over that user. From then
on `iss` and `sub` identify them, as [ADR 0011](0011-oidc-users-identified-by-issuer-and-subject.md)
says, and a later sign-in with the same email but another subject is refused as before.

```text
POST /scim/v2/Users {"userName": "grace@acme.example", ...}
  → users: grace@acme.example, directory_source = scim, oidc_issuer = null, password_hash = null

ID token {"iss": "https://sso.acme.example", "sub": "4711", "email": "grace@acme.example"}
  → the same row, now with oidc_issuer and oidc_subject; her Company groups apply at once
```

The directory is the company's own record of its people, so an address it gives is trusted for the
one step that ties it to the identity provider. A local account is never matched, which keeps the
reason ADR 0011 rejected email matching: whoever controls an address at the identity provider must
not get a break-glass account.

The directory's Company groups are kept as a copy (`company_groups` and `company_group_members`) and
never hold permissions. A Group that an Instance admin maps to a Company group gets its members,
exactly like a Company group in an ID token, and a membership counts when either source lists it.

## Considered Options

- **Map SCIM `externalId` to the ID token's `sub` (rejected):** It would avoid any email match. It
  was rejected because the two values come from different places: Microsoft Entra puts the object ID
  in `externalId`, while its `sub` differs for every application, so the mapping would depend on the
  provider and break quietly.
- **Never link (rejected):** The first sign-in of anyone the directory created would end with
  `email_taken`, so SCIM and OIDC could not be used together.
- **Link any user with the same email (rejected):** This is what ADR 0011 rejects for local
  accounts, for the reason given there.
- **Let SCIM write Group members directly (rejected):** The directory would then decide who gets a
  Role, which [architecture.md](../architecture.md#identity) leaves to Instance and Project admins.

## Consequences

- An ID token without `email_verified` is accepted, as for every OIDC sign-in, because Microsoft
  Entra does not send the claim. A provider that lets people choose their own unverified address
  should send `email_verified: false`, which is refused.
- Whoever first signs in with a directory user's email at the identity provider gets that user. The
  directory and the identity provider are normally the same system, which is why this is accepted.
- SCIM `active: false` and `DELETE` both deactivate: memberships from Company groups and sign-ins
  end at once, access tokens within five minutes, and the record stays. `DELETE` also hides the user
  from SCIM, and creating them again reactivates the same record. Deleting personal data for good is
  a later feature.

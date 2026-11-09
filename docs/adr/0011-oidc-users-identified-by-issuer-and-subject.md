---
status: accepted
---

# OIDC users are identified by issuer and subject, and their Groups follow Company groups at sign-in

A user who signs in through the company's identity provider is found by the ID token's `iss` and
`sub`, stored on the user, and never by email. An email already held by another user refuses the
sign-in. A Company group is mapped to a Group by an Instance admin, and each sign-in adds the user
to the Groups of their Company groups and removes them from the Groups they joined that way and no
longer qualify for. A member added by hand stays.

```text
ID token: { "iss": "https://sso.acme.example", "sub": "248289761001",
            "email": "ada@acme.example", "groups": ["team-engineering", "all-staff"] }

company_group_mappings: team-engineering → Engineers
group_members for Ada:  Engineers (is_from_company_group = true)     ← added at this sign-in
                        Reviewers (is_from_company_group = true)     ← removed, no longer entitled
                        On-call   (is_from_company_group = false)    ← added by hand, stays
```

OIDC Core says that `iss` and `sub` are the only stable identifier of a user. Grafana looked users
up by email until CVE-2023-3128, where an Azure AD tenant could set another person's address and
take over their account, and now refuses it by default (`oauth_allow_insecure_email_lookup`). The
`is_from_company_group` flag is the `external` column of Grafana's Team Sync.

## Considered Options

- **Link a user to an existing local account with the same email (rejected):** Saves a step when a
  local account moves to OIDC. It was rejected because whoever controls that address at the identity
  provider gets the account, including a break-glass Instance admin.
- **Replace all of a user's memberships at sign-in (rejected):** Simpler, with no flag. It was
  rejected because a Group's manual members would vanish whenever one of them signed in.
- **Import a Role from a claim, such as Grafana's `role_attribute_path` (rejected):** Would give
  company-managed Roles at once. It was rejected because
  [architecture.md](../architecture.md#identity) keeps permissions out of the import: the company
  decides who is in a group, and a Project admin decides what that group may do.
- **A claim or setting that makes a user an Instance admin at first sign-in (rejected for now):** It
  would remove the bootstrap step below. It was rejected because that is an imported permission too.

## Consequences

- Group membership changes reach Extispex at the next sign-in, so someone removed from a Company
  group keeps their access until their sign-in ends, up to 12 hours without use. SCIM in step 10 is
  what closes that gap.
- A local account cannot be turned into an OIDC user. It needs a user with a different email.
- An Instance without local accounts has nobody who can map Company groups. Set
  `LOCAL_ACCOUNTS=enabled` with `BOOTSTRAP_ADMIN_EMAIL` for the first start, make an OIDC user an
  Instance admin, and then remove the variable or keep the account for emergencies.
- Changing `OIDC_ISSUER_URL` makes every user a new user, and their old email blocks the new sign-in
  until the old user's email is free.

# Repository settings

Settings of [gallas-ai/extispex](https://github.com/gallas-ai/extispex) that live on GitHub, not in
the repository. Set on 2026-11-07. When you change one of them, update this document.

**Goal:** only the owner, `@GALLLASMILAN`, pushes to `main` and approves pull requests. Everyone
else contributes through a pull request that the owner approves.

## Access

The repository is public and owned by the `gallas-ai` organization. `@GALLLASMILAN` is the only
organization member, the only organization admin and the only collaborator. Members of the
organization get `read` on repositories by default. Anyone else contributes from a fork.

## `Protect main` ruleset

The [ruleset](https://github.com/gallas-ai/extispex/rules/26775518) (id `26775518`) applies to the
default branch:

| Rule                   | Setting                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| Deletion               | blocked                                                                        |
| Force push             | blocked                                                                        |
| Pull request           | required, 1 approval from a code owner                                         |
| Stale approvals        | dismissed on a new push; the last pusher cannot approve                        |
| Review threads         | must be resolved                                                               |
| Merge methods          | merge, squash and rebase                                                       |
| Required status checks | the four CI jobs below, reported by GitHub Actions                             |
| Bypass                 | the `Organization admin` role, always: direct pushes and merges without review |

The owner pushes to `main` directly through the bypass. GitHub does not let anyone approve their own
pull request, so the owner merges their own pull requests with "Merge without waiting for
requirements to be met (bypass rules)".

### Required status checks follow the CI job names

The ruleset requires these check names, which are the `name:` of the jobs in
[pull-request.yml](../.github/workflows/pull-request.yml):

- `Static checks and unit tests`
- `End-to-end tests (all-in-one)`
- `End-to-end tests (services)`
- `Container images`

When a job is renamed, added, removed or gets a new matrix value, update the ruleset in the same
change. A required check that no job reports any more never arrives, and every pull request from a
contributor waits on it forever. The owner's bypass hides this, so it shows up only on someone
else's pull request.

To update the checks, edit `required_status_checks` in the ruleset and send it back:

```sh
gh api repos/gallas-ai/extispex/rulesets/26775518 \
  --jq '{name, target, enforcement, conditions, bypass_actors, rules}' > ruleset.json
# edit ruleset.json
gh api -X PUT repos/gallas-ai/extispex/rulesets/26775518 --input ruleset.json
```

Keep `integration_id: 15368` (GitHub Actions) on each check, so that only GitHub Actions can report
it.

## Code owners

[.github/CODEOWNERS](../.github/CODEOWNERS) makes `@GALLLASMILAN` the owner of every file. With
"code owner review" in the ruleset, an approval from anyone else does not satisfy it, even from a
future collaborator with write access. A change to `CODEOWNERS` itself also needs the owner's
approval.

## GitHub Actions

- Workflows of a pull request from any outside contributor run only after the owner approves them in
  the pull request (`approval_policy: all_external_contributors`).
- The default `GITHUB_TOKEN` is read-only and cannot approve pull requests.

## Security

- Secret scanning and push protection are on: GitHub rejects a push that contains a known credential
  format.
- Private vulnerability reporting is on: anyone can report a vulnerability privately from the
  Security tab.
- Dependabot vulnerability alerts are on.

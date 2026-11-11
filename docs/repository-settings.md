# Repository settings

Settings of [gallas-ai/extispex](https://github.com/gallas-ai/extispex) that live on GitHub, not in
the repository. Set on 2026-11-07 and changed on 2026-11-11 for auto-merge. When you change one of
them, update this document.

**Goal:** only the owner, `@GALLLASMILAN`, pushes to `main` and approves pull requests. The owner's
own pull requests merge by themselves once CI passes. Everyone else contributes through a pull
request that the owner approves.

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
| Pull request           | required, no approving review; the `Owner approval` check stands in for it     |
| Review threads         | must be resolved                                                               |
| Merge methods          | merge, squash and rebase                                                       |
| Required status checks | the five jobs below, reported by GitHub Actions                                |
| Bypass                 | the `Organization admin` role, always: direct pushes and merges without review |

The owner pushes to `main` directly through the bypass.

### Required status checks follow the job names

The ruleset requires these check names, which are the `name:` of jobs in
[pull-request.yml](../.github/workflows/pull-request.yml) and
[owner-approval.yml](../.github/workflows/owner-approval.yml):

- `Static checks and unit tests`
- `End-to-end tests (all-in-one)`
- `End-to-end tests (services)`
- `Container images`
- `Owner approval`

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

## Owner approval and auto-merge

GitHub lets nobody approve their own pull request, and auto-merge never uses the bypass. With a
required code owner review, an auto-merge on the owner's pull request would wait forever. The
ruleset therefore requires no review, and the `Owner approval` job decides instead:

- A pull request opened by `@GALLLASMILAN` passes at once.
- Anyone else's passes only when the owner's latest review approves the pull request's latest
  commit. A new push makes it fail again until the owner approves that commit.

The job runs on `pull_request_target`, which uses the workflow from `main` and the base branch's
permissions, and checks nothing out. It runs again when a review is submitted, edited or dismissed.

**Auto-merge** is allowed in the repository. It is enabled per pull request, for example with
`gh pr merge <number> --auto --merge`, by the owner, so that the merge counts as the owner's and the
push to `main` starts CI. A merge made with the workflow's `GITHUB_TOKEN` would start no workflow.

**Known weakness:** the review step runs on `pull_request_review`, which takes the workflow file
from the pull request. A contributor could add a job named `Owner approval` that always passes. It
runs only when the owner approves running that contributor's workflows (see below), so check a pull
request that changes `.github/` before approving its workflows.

## Code owners

[.github/CODEOWNERS](../.github/CODEOWNERS) makes `@GALLLASMILAN` the owner of every file, so GitHub
asks the owner to review every pull request. The ruleset no longer requires a code owner review;
`Owner approval` requires the owner's approval instead.

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

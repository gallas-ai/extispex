---
status: accepted
---

# Migrations run in a Helm hook Job, and services in the chart only check them

Each service applied its own migrations when it started. With several replicas starting together,
they raced to create the database and run the same migrations, and the losers tried again after
recognising a failure as a lost race (step 4). That hid the race instead of removing it, and only
the Evaluation service had a test. A Kubernetes upgrade adds a second problem: the new schema has to
be in place before the new version serves requests, while the previous version still runs.

The Helm chart runs one Job per service, `services/<service>/src/migrate.ts`, as a `pre-install` and
`pre-upgrade` hook. Helm waits for each Job before it changes a Deployment, and a failed Job stops
the release while the previous version keeps running. The services in the chart start with
`DATABASE_MIGRATIONS=check`: they change nothing and refuse to start while a migration is pending,
so a pod can never run against a schema older than its code.

```text
helm upgrade
  ├─ Job migrate-identity    deno run services/identity/src/migrate.ts     ┐ one after another,
  ├─ Job migrate-telemetry   …                                             │ each waited for
  ├─ Job migrate-prompt      …                                             │
  ├─ Job migrate-evaluation  …                                             ┘
  └─ Deployments roll        DATABASE_MIGRATIONS=check: refuse a pending migration,
                             accept migrations from a newer version
```

Compose, the all-in-one process and the tests keep `DATABASE_MIGRATIONS=apply`, the default. There,
and in the `migrate` command itself, replicas no longer race: on PostgreSQL each takes an advisory
lock in the service's database before reading which migrations are pending, and a missing database
is created under a lock in the server's `postgres` database. The retry is gone.

## Considered Options

- **A Helm hook Job per service (chosen):** migrations run once per release, before any new pod, and
  their logs are in one place. Hooks are a Helm feature; Argo CD maps them to its own sync hooks.
- **An init container in each pod:** no hook needed, but every replica of every rollout runs the
  migrations, so they still need the lock, and a slow migration delays each pod's start. A failed
  migration shows as pods that never start rather than as a failed release.
- **Migrating at start under a lock everywhere:** the smallest change, and Compose still does it. In
  a cluster it lets new pods change the schema while the rollout is half done, with no single place
  that says whether the migration succeeded.

## Consequences

- During an upgrade the previous version runs against the new schema until its pods are replaced.
  Migrations must therefore be backward compatible: add tables, columns and indexes; remove or
  rename only in a later release, once no running version reads them. This is the same rule as the
  backward-compatible `/v1` contracts that rolling updates already need.
- `helm rollback` does not undo migrations. A service of the previous version starts against the
  newer schema, because `check` accepts applied migrations it does not know.
- pg-boss creates and migrates its own schema when the Evaluation API or worker starts, under its
  own advisory lock. The `migrate` command covers only Extispex's tables.
- A Job needs the database URL before the release exists, so the chart reads it, and the master key,
  only from Secrets that the operator creates first. A Secret rendered by the chart would not exist
  yet when a `pre-install` hook runs.
- The `migrate` command needs a user that may create the database only when it does not exist yet. A
  user that can only use existing databases works when they are created beforehand, and the lock for
  creating one is taken only when the database is missing.

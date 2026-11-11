# Migrations on parallel branches

Several roadmap steps can be built at the same time, each on its own branch, and the owner's pull
requests merge by themselves once CI passes (see [repository-settings.md](repository-settings.md)).
Two branches that both add "the next" migration to a service would collide. These rules keep them
apart.

## Rules

1. **Reserve the number before writing the migration.** Each branch that changes a service's storage
   takes the next free number for that service from the table below and records it there in its
   first commit. A number in the table is taken even while its pull request is still open.
2. **One number per branch and service.** The same number names the PostgreSQL and the SQLite
   migration, for example `migration-0004-add-llm-providers.ts` in both
   `services/evaluation/src/storage/migrations/postgres` and `.../sqlite`.
3. **Parallel migrations stay independent.** A migration must not depend on a migration with a
   reserved number below its own that has not merged yet. It creates or changes only its own tables
   and columns, so the migrations give the same schema in whichever order the pull requests merge.
   When a step needs another step's schema, it waits for that step to merge.
4. **Keep the list in the service's database file in number order.** Each service registers its
   migrations in an ordered list, for example in
   `services/evaluation/src/storage/evaluation-database.ts`. A branch that merges after a higher
   number inserts its entry in number order when it rebases.
5. **Never renumber a merged migration.** Once a migration is on `main`, a database may have applied
   it under that name.
6. **Branches are up to date before they merge.** The `Protect main` ruleset requires each pull
   request to be up to date with `main`, so CI always runs the combination that will land. After a
   merge, the other open pull requests rebase onto `main` and run CI again.

## Reserved numbers

A branch adds its rows when it starts and leaves them when it merges, so parallel branches never
edit the same rows. Whoever merges the last listed branch clears the table. A number that is neither
in this table nor on `main` is free.

| Service    | Number | Branch               | Roadmap step                       |
| ---------- | ------ | -------------------- | ---------------------------------- |
| evaluation | 0004   | `feat/llm-providers` | 7. LLM providers                   |
| evaluation | 0005   | `feat/reports`       | 8. Reports                         |
| evaluation | 0006   | `feat/retention`     | 13. Retention and Project deletion |
| identity   | 0005   | `feat/retention`     | 13. Retention and Project deletion |
| identity   | 0006   | `feat/key-rotation`  | 14. Helm chart (key rotation)      |
| prompt     | 0002   | `feat/retention`     | 13. Retention and Project deletion |
| telemetry  | 0005   | `feat/retention`     | 13. Retention and Project deletion |

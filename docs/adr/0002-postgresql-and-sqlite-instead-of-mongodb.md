---
status: accepted
---

# Use PostgreSQL and SQLite instead of MongoDB

The business specification proposed MongoDB with an ORM so that the local image could fall back to SQLite. We chose MikroORM with PostgreSQL in production and SQLite in the local image. PostgreSQL and SQLite share most of their SQL. A three-database setup, by contrast, would force us to write every aggregation twice and hide behavioural differences behind one interface.

## Evidence

We ran one MikroORM 7.2.6 entity against all three databases on Deno 2.9.5 on 2026-11-04.

| Check | PostgreSQL | SQLite | MongoDB |
|---|---|---|---|
| Create and find through the same entity | Worked | Worked | Worked only after renaming the primary key to `_id` |
| Filter on JSON attribute `gen_ai.request.model` | 2 records | 2 records | 0 records, with no error |
| Grouping and counting | Query builder | Query builder | No query builder; needed a separate aggregation pipeline |

MongoDB reads a dot in a key as a path into nested objects. GenAI telemetry attributes such as `gen_ai.*` all contain dots, so the most important filters would silently return wrong results unless handled separately. According to its documentation, MongoDB also needs a replica set for transactions, which adds to every customer's operations.

## Consequences

- Every service tests its storage against both PostgreSQL and SQLite.
- Telemetry storage sits behind its own interface, so a store such as ClickHouse or MongoDB can be added later for a specific customer or measured need.
- Neither MikroORM migrations nor the native `better-sqlite3` driver inside a container has been tested yet. The first implementation step must cover both.

---
status: accepted
---

# Telemetry Evaluator conditions are declarative JSON, not a query language

A Telemetry Evaluator says which spans should exist in an Iteration's traces. We write that as JSON
in the same shape as every other Evaluator, instead of as text in a query language such as TraceQL.

```json
{
  "type": "telemetry",
  "name": "called-refund-tool",
  "match": { "name": "execute_tool", "attributes": { "gen_ai.tool.name": "lookup_refund" } },
  "count": { "min": 1 }
}
```

The same check in the style of Grafana Tempo's TraceQL would be
`{ span.gen_ai.tool.name = "lookup_refund" } | count() >= 1`.

- **Why JSON:** the Test Case schema validates it with no parser on either side, misspelt fields are
  refused, and the UI builds it from a form. Conditions are stored in Test Cases and copied into
  runs, so a text language would have to stay compatible with every condition ever stored.
- **What we give up:** expressing relations between spans, such as one span being a child of
  another, and arithmetic over attributes. A span matches when it meets every given condition, and
  values are compared exactly.
- **How it can grow:** `match` can gain optional fields, and a query language could later arrive as
  a new Evaluator `type` next to this one, without touching stored conditions.

Counting covers both "this happened" (`{ "min": 1 }`) and "this must not happen"
(`{ "min": 0, "max": 0 }`).

---
status: accepted
---

# AGPLv3 for the platform, Apache 2.0 for instrumentation code

Extispex is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). The
code that users copy into their own applications, `packages/telemetry-ids` and `examples/`, is
licensed under Apache 2.0.

We want anyone to be able to run, change and build on Extispex, and we want to stop someone from
taking the project, closing it and selling it as their own product. No OSI-approved open source
licence forbids selling. AGPLv3 comes closest: anyone may sell or host Extispex, but anyone who
distributes it, or lets users interact with a modified version over a network, must publish the
complete source of that version under the same licence. A closed competing product or hosted service
is therefore not possible, while internal use, even commercial, carries no obligation.

Instrumentation code is the exception. It runs inside the user's own application, and under AGPLv3
copying it there could oblige the user to publish that application's source. That would defeat the
purpose of an observability tool, so this code uses Apache 2.0, which also grants a patent licence.
Grafana splits its licences the same way.

## Considered Options

- **AGPLv3 platform, Apache 2.0 instrumentation (chosen):** Open source by the OSI definition and
  blocks closed forks, including hosted ones. Some companies forbid AGPL software by policy, and
  anyone may still sell an open, AGPL-licensed copy.
- **MIT or Apache 2.0 for everything:** Simplest and most widely accepted, used by Langfuse's core,
  Helicone and Opik. Rejected because anyone could sell a closed copy.
- **Functional Source License (FSL):** Forbids competing use outright, and each release becomes
  Apache 2.0 or MIT after two years. Used by Sentry. Rejected because it is source-available rather
  than open source, and the open source label matters to us.
- **Elastic License 2.0 or Business Source License:** Forbid hosted or competing offerings, used by
  Arize Phoenix, Elasticsearch and HashiCorp. Rejected for the same reason as the FSL.

## Consequences

- The root `LICENSE` holds the AGPLv3 text. `packages/telemetry-ids/LICENSE` and `examples/LICENSE`
  hold the Apache 2.0 text. Every `deno.json` that sets `license` matches its directory, and the
  container images carry the `org.opencontainers.image.licenses` label.
- New code that is meant to be copied into, or imported by, user applications, such as SDKs and
  instrumentation helpers, belongs under Apache 2.0. Everything else is AGPLv3.
- `-only` rather than `-or-later` keeps the choice of any future licence version with the project.
- Every dependency must be compatible with AGPLv3. On 2026-11-07 all dependencies were MIT, ISC,
  BSD-3-Clause or Apache 2.0, plus CC-BY-4.0 data in build tooling.
- The licence protects the code, not the name. Registering "Extispex" as a trademark is a separate
  step that stops others from selling a copy under our name.
- Accepting outside contributions without a contributor licence agreement means that any later
  change of licence, including dual licensing, needs the consent of every contributor. Decide on a
  CLA before merging the first outside pull request.

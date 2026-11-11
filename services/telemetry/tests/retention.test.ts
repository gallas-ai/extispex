import { assert, assertEquals } from "@std/assert";
import { createRequestAuthenticator, createStructuredLogger } from "@extispex/service-runtime";
import {
  createTestAccessTokens,
  createTestProjectLifecycle,
  type TestProjectLifecycle,
} from "@extispex/service-runtime/testing";
import { createBackgroundLease } from "@extispex/service-storage";
import { listTestDatabases } from "@extispex/service-storage/testing";
import {
  createTelemetryService,
  openTelemetryDatabase,
  type TelemetryDatabase,
  type TelemetryService,
} from "../src/create-service.ts";

const API_KEYS: Record<string, string> = { "key-one": "project-one", "key-two": "project-two" };
const MINUTE = 60_000;
const DAY = 86_400_000;
const INTERVAL = 10 * MINUTE;
const START = Date.parse("2026-11-11T12:00:00.000Z");
const TELEMETRY_TABLES = [
  "spans",
  "correlation_evaluations",
  "logs",
  "metric_points",
  "metric_series",
  "rejection_counts",
  "background_leases",
];

const testAccessTokens = await createTestAccessTokens();
const testRequestAuthenticator = createRequestAuthenticator({
  projectResolver: { resolveProjectId: (apiKey) => Promise.resolve(API_KEYS[apiKey] ?? null) },
  accessTokenVerifier: testAccessTokens.accessTokenVerifier,
});

interface RetentionTestContext {
  database: TelemetryDatabase;
  clock: { now(): Date; advance(milliseconds: number): void };
  projectLifecycle: TestProjectLifecycle;
  createService(leaseHolder: string): TelemetryService;
  telemetryService: TelemetryService;
}

function defineRetentionTest(
  testName: string,
  testBody: (context: RetentionTestContext) => Promise<void>,
): void {
  for (const testDatabase of listTestDatabases("telemetry")) {
    Deno.test(`${testName} (${testDatabase.label})`, async () => {
      const database = await openTelemetryDatabase(testDatabase.url);
      try {
        for (const tableName of TELEMETRY_TABLES) {
          await database.orm.em.fork().execute(`delete from ${tableName}`);
        }
        let clockMilliseconds = START;
        const clock = {
          now: () => new Date(clockMilliseconds),
          advance: (milliseconds: number) => clockMilliseconds += milliseconds,
        };
        const projectLifecycle = createTestProjectLifecycle({
          projects: [
            { projectId: "project-one", retentionDays: 1 },
            { projectId: "project-two", retentionDays: 30 },
          ],
          projectsToRemove: [],
        });
        const createService = (leaseHolder: string) =>
          createTelemetryService({
            database,
            requestAuthenticator: testRequestAuthenticator,
            projectLifecycle,
            logger: createStructuredLogger("telemetry-test"),
            readCurrentTime: clock.now,
            dataLifecycleIntervalMilliseconds: INTERVAL,
            leaseHolder,
          });
        await testBody({
          database,
          clock,
          projectLifecycle,
          createService,
          telemetryService: createService("replica-one"),
        });
      } finally {
        await database.close();
      }
    });
  }
}

function toUnixNano(unixMilliseconds: number): string {
  return (BigInt(unixMilliseconds) * 1_000_000n).toString();
}

function stringAttribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

async function postJson(
  telemetryService: TelemetryService,
  path: string,
  apiKey: string,
  payload: unknown,
): Promise<void> {
  const response = await telemetryService.handleRequest(
    new Request(`http://telemetry.test${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  const responseText = await response.text();
  assertEquals(response.status, 200, responseText);
  assertEquals(JSON.parse(responseText), {}, `${path} rejected records`);
}

/** One span, one Log Record and one gauge point of the Project at a time. */
async function sendTelemetryAt(
  telemetryService: TelemetryService,
  apiKey: string,
  unixMilliseconds: number,
  label: string,
): Promise<void> {
  const timeUnixNano = toUnixNano(unixMilliseconds);
  const traceId = crypto.randomUUID().replaceAll("-", "");
  await postJson(telemetryService, "/v1/traces", apiKey, {
    resourceSpans: [{
      resource: { attributes: [stringAttribute("service.name", "support-bot")] },
      scopeSpans: [{
        spans: [{
          traceId,
          spanId: traceId.slice(0, 16),
          name: label,
          kind: 1,
          startTimeUnixNano: timeUnixNano,
          endTimeUnixNano: timeUnixNano,
          attributes: [stringAttribute("correlation.id", label)],
        }],
      }],
    }],
  });
  await postJson(telemetryService, "/v1/logs", apiKey, {
    resourceLogs: [{
      resource: { attributes: [stringAttribute("service.name", "support-bot")] },
      scopeLogs: [{
        logRecords: [{ timeUnixNano, severityNumber: 9, body: { stringValue: label } }],
      }],
    }],
  });
  await postJson(telemetryService, "/v1/metrics", apiKey, {
    resourceMetrics: [{
      resource: { attributes: [stringAttribute("service.name", "support-bot")] },
      scopeMetrics: [{
        metrics: [{
          name: "queue.depth",
          unit: "1",
          gauge: {
            dataPoints: [{
              timeUnixNano,
              asDouble: 3,
              attributes: [stringAttribute("age", label)],
            }],
          },
        }],
      }],
    }],
  });
}

async function countRows(
  database: TelemetryDatabase,
  tableName: string,
  projectId: string,
): Promise<number> {
  const rows = await database.orm.em.fork().execute<{ row_count: number | string }[]>(
    `select count(*) as row_count from ${tableName} where project_id = ?`,
    [projectId],
  );
  return Number(rows[0].row_count);
}

async function countProjectRows(database: TelemetryDatabase, projectId: string) {
  return {
    spans: await countRows(database, "spans", projectId),
    logs: await countRows(database, "logs", projectId),
    metricPoints: await countRows(database, "metric_points", projectId),
    metricSeries: await countRows(database, "metric_series", projectId),
  };
}

defineRetentionTest(
  "deletes each Project's records older than its own Retention Period",
  async ({ database, telemetryService }) => {
    for (const apiKey of ["key-one", "key-two"]) {
      await sendTelemetryAt(telemetryService, apiKey, START - 2 * DAY, "two-days-old");
      await sendTelemetryAt(telemetryService, apiKey, START - 10 * MINUTE, "recent");
    }
    const everyRecordTwice = { spans: 2, logs: 2, metricPoints: 2, metricSeries: 2 };
    assertEquals(await countProjectRows(database, "project-one"), everyRecordTwice);

    const outcome = await telemetryService.runDataLifecycle();
    assertEquals(outcome.status, "ran");
    assertEquals(await countProjectRows(database, "project-one"), {
      spans: 1,
      logs: 1,
      metricPoints: 1,
      metricSeries: 1,
    });
    assertEquals(await countProjectRows(database, "project-two"), everyRecordTwice);
    const remainingLogs = await database.orm.em.fork().execute<{ body_text: string }[]>(
      "select body_text from logs where project_id = 'project-one'",
    );
    assertEquals(remainingLogs.map((row) => row.body_text), ["recent"]);
    if (database.dialect === "sqlite") {
      // The search index loses the deleted record too.
      const searchRows = await database.orm.em.fork().execute<unknown[]>(
        "select rowid from logs_search where logs_search match '\"two\"'",
      );
      assertEquals(searchRows.length, 1);
    }
  },
);

defineRetentionTest(
  "removes a deleted Project's telemetry and reports it",
  async ({ database, telemetryService, projectLifecycle }) => {
    await sendTelemetryAt(telemetryService, "key-one", START - MINUTE, "kept");
    await sendTelemetryAt(telemetryService, "key-two", START - MINUTE, "removed");
    const rejection = await telemetryService.handleRequest(
      new Request("http://telemetry.test/v1/logs", {
        method: "POST",
        headers: { authorization: "Bearer key-two", "content-type": "application/json" },
        body: JSON.stringify({
          resourceLogs: [{
            scopeLogs: [{
              logRecords: [{
                timeUnixNano: toUnixNano(START),
                traceId: "5b8efff798038103d269b633813fc60c",
                body: { stringValue: "no correlation id" },
              }],
            }],
          }],
        }),
      }),
    );
    await rejection.body?.cancel();
    assertEquals(await countRows(database, "rejection_counts", "project-two"), 1);

    projectLifecycle.lifecycle = {
      projects: [{ projectId: "project-one", retentionDays: 30 }],
      projectsToRemove: [{ projectId: "project-two", deletedAt: new Date(START).toISOString() }],
    };
    const outcome = await telemetryService.runDataLifecycle();
    assert(outcome.status === "ran");
    assertEquals(outcome.removedProjectIds, ["project-two"]);
    assertEquals(projectLifecycle.recordedRemovals, ["project-two"]);
    assertEquals(await countProjectRows(database, "project-two"), {
      spans: 0,
      logs: 0,
      metricPoints: 0,
      metricSeries: 0,
    });
    assertEquals(await countRows(database, "rejection_counts", "project-two"), 0);
    assertEquals(await countProjectRows(database, "project-one"), {
      spans: 1,
      logs: 1,
      metricPoints: 1,
      metricSeries: 1,
    });
  },
);

defineRetentionTest(
  "forgets rejected counts older than the 24 hours they are shown for",
  async ({ database, telemetryService, clock }) => {
    const insertCount = (hourStart: string) =>
      database.orm.em.fork().execute(
        `insert into rejection_counts
          (project_id, signal, hour_start, rejected_count, last_reason, last_rejected_at)
          values ('project-one', 'spans', ?, 1, 'test', ?)`,
        [hourStart, hourStart],
      );
    await insertCount(new Date(START - 25 * 60 * MINUTE).toISOString());
    await insertCount(new Date(START - 23 * 60 * MINUTE).toISOString());
    await telemetryService.runDataLifecycle();
    assertEquals(await countRows(database, "rejection_counts", "project-one"), 1);
    clock.advance(DAY);
    await telemetryService.runDataLifecycle();
    assertEquals(await countRows(database, "rejection_counts", "project-one"), 0);
  },
);

defineRetentionTest(
  "drops whole days on PostgreSQL only past the longest Retention Period and the ingestion window",
  async ({ database, telemetryService, projectLifecycle, clock }) => {
    // Accepted, because it is just inside the 30-day window.
    const oldTime = START - 29 * DAY - 12 * 60 * MINUTE;
    await sendTelemetryAt(telemetryService, "key-two", oldTime, "old");
    const oldDay = new Date(oldTime).toISOString().slice(0, 10).replaceAll("-", "");
    projectLifecycle.lifecycle = {
      projects: [
        { projectId: "project-one", retentionDays: 1 },
        { projectId: "project-two", retentionDays: 60 },
      ],
      projectsToRemove: [],
    };
    clock.advance(2 * DAY);
    let outcome = await telemetryService.runDataLifecycle();
    assert(outcome.status === "ran");
    assertEquals(outcome.droppedPartitions.filter((name) => name.endsWith(oldDay)), []);
    assertEquals((await countProjectRows(database, "project-two")).logs, 1);

    projectLifecycle.lifecycle.projects[1].retentionDays = 30;
    outcome = await telemetryService.runDataLifecycle();
    assert(outcome.status === "ran");
    assertEquals(await countProjectRows(database, "project-two"), {
      spans: 0,
      logs: 0,
      metricPoints: 0,
      metricSeries: 0,
    });
    if (database.dialect === "postgresql") {
      assertEquals(
        outcome.droppedPartitions.filter((name) => name.endsWith(oldDay)).sort(),
        [`logs_${oldDay}`, `metric_points_${oldDay}`],
      );
    } else {
      assertEquals(outcome.droppedPartitions, []);
    }
  },
);

defineRetentionTest(
  "lets one replica at a time run the data lifecycle",
  async ({ database, telemetryService, createService, clock }) => {
    const secondReplica = createService("replica-two");
    assertEquals((await telemetryService.runDataLifecycle()).status, "ran");
    assertEquals(await secondReplica.runDataLifecycle(), { status: "skipped" });
    clock.advance(INTERVAL);
    assertEquals((await telemetryService.runDataLifecycle()).status, "ran");
    clock.advance(2 * INTERVAL);
    assertEquals((await secondReplica.runDataLifecycle()).status, "ran");
    assertEquals(await telemetryService.runDataLifecycle(), { status: "skipped" });

    // Many replicas asking at once: exactly one gets the lease.
    clock.advance(3 * INTERVAL);
    const replicaLeases = Array.from(
      { length: 8 },
      (_, replicaIndex) =>
        createBackgroundLease(database, {
          name: "data-lifecycle",
          holder: `racing-replica-${replicaIndex}`,
          durationMilliseconds: INTERVAL,
        }),
    );
    const acquired = await Promise.all(replicaLeases.map((lease) => lease.tryAcquire(clock.now())));
    assertEquals(acquired.filter(Boolean).length, 1);
  },
);

import { assert, assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import {
  createRequestAuthenticator,
  createStructuredLogger,
  type ProjectResolver,
} from "@extispex/service-runtime";
import {
  createTestAccessTokens,
  createTestProjectLifecycle,
} from "@extispex/service-runtime/testing";
import { listTestDatabases } from "@extispex/service-storage/testing";
import type { ListLogsResponse, RejectedTelemetry } from "@extispex/contracts";
import protobuf from "protobufjs";
import {
  createTelemetryService,
  openTelemetryDatabase,
  type TelemetryDatabase,
  type TelemetryService,
} from "../src/create-service.ts";
import otlpDescriptor from "../src/ingestion/generated/otlp-descriptor.json" with { type: "json" };

const API_KEY = "test-api-key";
const OTHER_PROJECT_API_KEY = "other-project-api-key";
const TRACE_ID = "5b8efff798038103d269b633813fc60c";
const SPAN_ID = "eee19b7ec3c1b174";
const NOW = new Date("2026-11-09T12:00:00.000Z");
const NOW_NANOSECONDS = BigInt(NOW.getTime()) * 1_000_000n;
const NANOSECONDS_PER_MINUTE = 60_000_000_000n;
const NANOSECONDS_PER_DAY = 86_400_000_000_000n;

const testProjectResolver: ProjectResolver = {
  resolveProjectId: (apiKey) =>
    Promise.resolve(
      ({ [API_KEY]: "project-one", [OTHER_PROJECT_API_KEY]: "project-two" })[apiKey] ?? null,
    ),
};
const testAccessTokens = await createTestAccessTokens();
const testRequestAuthenticator = createRequestAuthenticator({
  projectResolver: testProjectResolver,
  accessTokenVerifier: testAccessTokens.accessTokenVerifier,
});

function createService(database: TelemetryDatabase, readCurrentTime = () => NOW) {
  return createTelemetryService({
    database,
    requestAuthenticator: testRequestAuthenticator,
    projectLifecycle: createTestProjectLifecycle(),
    logger: createStructuredLogger("telemetry-test"),
    readCurrentTime,
  });
}

async function clearTelemetry(database: TelemetryDatabase): Promise<void> {
  const entityManager = database.orm.em.fork();
  await entityManager.execute("delete from logs");
  await entityManager.execute("delete from rejection_counts");
  await entityManager.execute("delete from spans");
}

type LogTestBody = (service: TelemetryService, database: TelemetryDatabase) => Promise<void>;

function defineLogTest(testName: string, testBody: LogTestBody): void {
  for (const testDatabase of listTestDatabases("telemetry")) {
    Deno.test(`${testName} (${testDatabase.label})`, async () => {
      const database = await openTelemetryDatabase(testDatabase.url);
      try {
        await clearTelemetry(database);
        await testBody(createService(database), database);
      } finally {
        await database.close();
      }
    });
  }
}

function stringAttribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

interface TestLogRecord {
  body?: unknown;
  timeUnixNano?: string;
  observedTimeUnixNano?: string;
  severityNumber?: number | string;
  severityText?: string;
  traceId?: string;
  spanId?: string;
  attributes?: unknown[];
}

function nanosecondsBeforeNow(minutes: bigint): string {
  return (NOW_NANOSECONDS - minutes * NANOSECONDS_PER_MINUTE).toString();
}

function createLogsRequest(logRecords: TestLogRecord[], serviceName = "support-bot") {
  return {
    resourceLogs: [{
      resource: { attributes: [stringAttribute("service.name", serviceName)] },
      scopeLogs: [{
        logRecords: logRecords.map((logRecord) => ({
          timeUnixNano: nanosecondsBeforeNow(1n),
          ...logRecord,
        })),
      }],
    }],
  };
}

function textBody(text: string) {
  return { stringValue: text };
}

function sendRequest(
  service: TelemetryService,
  path: string,
  init: RequestInit & { apiKey?: string } = {},
) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${init.apiKey ?? API_KEY}`);
  return service.handleRequest(new Request(`http://telemetry.test${path}`, { ...init, headers }));
}

function postJsonLogs(service: TelemetryService, payload: unknown, apiKey?: string) {
  return sendRequest(service, "/v1/logs", {
    method: "POST",
    apiKey,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function postJsonLogsAccepted(service: TelemetryService, payload: unknown, apiKey?: string) {
  const response = await postJsonLogs(service, payload, apiKey);
  assertEquals(response.status, 200, await response.clone().text());
  assertEquals(await response.json(), {});
}

async function queryLogs(service: TelemetryService, query = "", apiKey?: string) {
  const response = await sendRequest(service, `/v1/logs${query}`, { apiKey });
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as ListLogsResponse;
}

async function queryBodies(service: TelemetryService, query = "") {
  return (await queryLogs(service, query)).logs.map((logRecord) => logRecord.body);
}

defineLogTest("stores OTLP/JSON log records and returns them through the API", async (service) => {
  await postJsonLogsAccepted(
    service,
    createLogsRequest([{
      body: textBody("Refund created for order 42"),
      severityNumber: 17,
      severityText: "ERROR",
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      attributes: [
        stringAttribute("correlation.id", "order-42"),
        { key: "attempt", value: { intValue: 2 } },
      ],
    }]),
  );
  const { logs, nextCursor } = await queryLogs(service);
  assertEquals(nextCursor, null);
  assertEquals(logs.length, 1);
  assertExists(logs[0].logId);
  const { logId: _logId, ...logWithoutId } = logs[0];
  assertEquals(logWithoutId, {
    timeUnixNano: nanosecondsBeforeNow(1n),
    severity: "error",
    severityNumber: 17,
    severityText: "ERROR",
    body: "Refund created for order 42",
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    correlationId: "order-42",
    serviceName: "support-bot",
    attributes: { "correlation.id": "order-42", attempt: 2 },
    resourceAttributes: { "service.name": "support-bot" },
  });
});

defineLogTest("stores OTLP/protobuf log records and answers in protobuf", async (service) => {
  const otlpRoot = protobuf.Root.fromJSON(otlpDescriptor as protobuf.INamespace);
  const requestType = otlpRoot.lookupType(
    "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest",
  );
  const responseType = otlpRoot.lookupType(
    "opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse",
  );
  const traceIdBytes = Uint8Array.from(
    TRACE_ID.match(/../g) as string[],
    (hexByte) => parseInt(hexByte, 16),
  );
  const payload = requestType.encode(requestType.fromObject({
    resourceLogs: [{
      scopeLogs: [{
        logRecords: [
          {
            timeUnixNano: nanosecondsBeforeNow(1n),
            body: textBody("kept"),
            severityNumber: 9,
            attributes: [stringAttribute("correlation.id", "order-7")],
            traceId: traceIdBytes,
          },
          {
            timeUnixNano: nanosecondsBeforeNow(1n),
            body: textBody("refused"),
            traceId: traceIdBytes,
          },
        ],
      }],
    }],
  })).finish();
  const response = await sendRequest(service, "/v1/logs", {
    method: "POST",
    headers: { "content-type": "application/x-protobuf" },
    body: payload as Uint8Array<ArrayBuffer>,
  });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "application/x-protobuf");
  const decodedResponse = responseType.toObject(
    responseType.decode(new Uint8Array(await response.arrayBuffer())),
    { longs: Number },
  );
  assertEquals(decodedResponse.partialSuccess.rejectedLogRecords, 1);

  const { logs } = await queryLogs(service);
  assertEquals(logs.map((logRecord) => [logRecord.body, logRecord.traceId, logRecord.severity]), [
    ["kept", TRACE_ID, "info"],
  ]);
});

defineLogTest(
  "rejects a log with a trace but no Correlation ID and keeps logs without a trace",
  async (service) => {
    const response = await postJsonLogs(
      service,
      createLogsRequest([
        { body: textBody("no correlation"), traceId: TRACE_ID },
        { body: textBody("startup message") },
        { body: textBody("malformed trace id"), traceId: "abc" },
        { body: textBody("zero trace id"), traceId: "0".repeat(32), spanId: SPAN_ID },
      ]),
    );
    assertEquals(response.status, 200);
    const { partialSuccess } = await response.json();
    assertEquals(partialSuccess.rejectedLogRecords, 1);
    assertStringIncludes(partialSuccess.errorMessage, "missing required attribute correlation.id");
    const { logs } = await queryLogs(service, "?search=message");
    assertEquals(logs.map((logRecord) => logRecord.correlationId), [null]);
    const allLogs = (await queryLogs(service)).logs;
    assertEquals(allLogs.length, 3);
    assert(allLogs.every((logRecord) => logRecord.traceId === null && logRecord.spanId === null));
  },
);

defineLogTest("counts rejected spans and log records per Project", async (service) => {
  const emptyCounts = { rejectedCount: 0, lastReason: null, lastRejectedAt: null };
  const readCounts = async (apiKey?: string) => {
    const response = await sendRequest(service, "/v1/rejected-telemetry", { apiKey });
    assertEquals(response.status, 200);
    return await response.json() as RejectedTelemetry;
  };
  assertEquals(await readCounts(), {
    windowHours: 24,
    spans: emptyCounts,
    logs: emptyCounts,
    metrics: emptyCounts,
  });

  for (let batchNumber = 0; batchNumber < 2; batchNumber++) {
    await postJsonLogs(
      service,
      createLogsRequest([{ body: textBody("refused"), traceId: TRACE_ID }]),
    );
  }
  await sendRequest(service, "/v1/traces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            traceId: TRACE_ID,
            spanId: SPAN_ID,
            name: "without-correlation",
            startTimeUnixNano: "1700000000000000000",
            endTimeUnixNano: "1700000000250000000",
          }],
        }],
      }],
    }),
  });

  const counts = await readCounts();
  assertEquals(counts.logs.rejectedCount, 2);
  assertStringIncludes(counts.logs.lastReason ?? "", "correlation.id");
  assertEquals(counts.logs.lastRejectedAt, NOW.toISOString());
  assertEquals(counts.spans.rejectedCount, 1);
  assertStringIncludes(counts.spans.lastReason ?? "", "without-correlation");
  assertEquals(await readCounts(OTHER_PROJECT_API_KEY), {
    windowHours: 24,
    spans: emptyCounts,
    logs: emptyCounts,
    metrics: emptyCounts,
  });
});

defineLogTest("forgets rejections older than the window", async (service, database) => {
  const dayEarlier = () => new Date(NOW.getTime() - 25 * 3_600_000);
  await postJsonLogs(
    createService(database, dayEarlier),
    {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: (BigInt(dayEarlier().getTime()) * 1_000_000n).toString(),
            traceId: TRACE_ID,
          }],
        }],
      }],
    },
  );
  const response = await sendRequest(service, "/v1/rejected-telemetry");
  assertEquals((await response.json() as RejectedTelemetry).logs.rejectedCount, 0);
});

defineLogTest("uses the observed time, then the receive time, when a time is missing", async (
  service,
) => {
  const observedTime = nanosecondsBeforeNow(5n);
  await postJsonLogsAccepted(
    service,
    createLogsRequest([
      { body: textBody("observed"), timeUnixNano: "0", observedTimeUnixNano: observedTime },
      { body: textBody("received"), timeUnixNano: "0" },
    ]),
  );
  const { logs } = await queryLogs(service);
  assertEquals(
    logs.map((logRecord) => [logRecord.body, logRecord.timeUnixNano]),
    [["received", NOW_NANOSECONDS.toString()], ["observed", observedTime]],
  );
});

defineLogTest("rejects log records outside the accepted time window", async (service) => {
  const response = await postJsonLogs(
    service,
    createLogsRequest([
      {
        body: textBody("too old"),
        timeUnixNano: (NOW_NANOSECONDS - 31n * NANOSECONDS_PER_DAY).toString(),
      },
      {
        body: textBody("oldest"),
        timeUnixNano: (NOW_NANOSECONDS - 29n * NANOSECONDS_PER_DAY).toString(),
      },
      {
        body: textBody("too new"),
        timeUnixNano: (NOW_NANOSECONDS + 2n * NANOSECONDS_PER_DAY).toString(),
      },
      {
        body: textBody("clock ahead"),
        timeUnixNano: (NOW_NANOSECONDS + NANOSECONDS_PER_DAY / 2n).toString(),
      },
    ]),
  );
  const { partialSuccess } = await response.json();
  assertEquals(partialSuccess.rejectedLogRecords, 2);
  assertStringIncludes(partialSuccess.errorMessage, "more than 30 days old");
  assertStringIncludes(partialSuccess.errorMessage, "more than 1 day in the future");
  assertEquals((await queryBodies(service)).sort(), ["clock ahead", "oldest"]);
});

defineLogTest("ignores log records that an exporter sends again", async (service) => {
  const payload = createLogsRequest([
    { body: textBody("once"), attributes: [stringAttribute("attempt", "first")] },
    { body: textBody("once"), attributes: [stringAttribute("attempt", "second")] },
  ]);
  await postJsonLogsAccepted(service, payload);
  await postJsonLogsAccepted(service, payload);
  assertEquals((await queryLogs(service)).logs.length, 2);
});

defineLogTest("searches the body by words", async (service) => {
  await postJsonLogsAccepted(
    service,
    createLogsRequest([
      { body: textBody("Payment FAILED for order-42"), timeUnixNano: nanosecondsBeforeNow(1n) },
      { body: textBody("Payment succeeded"), timeUnixNano: nanosecondsBeforeNow(2n) },
      { body: textBody("Platba příliš vysoká"), timeUnixNano: nanosecondsBeforeNow(3n) },
      {
        body: { kvlistValue: { values: [stringAttribute("event", "checkout_started")] } },
        timeUnixNano: nanosecondsBeforeNow(4n),
      },
    ]),
  );
  const search = (words: string) => queryBodies(service, `?search=${encodeURIComponent(words)}`);
  assertEquals(await search("payment"), ["Payment FAILED for order-42", "Payment succeeded"]);
  assertEquals(await search("failed payment"), ["Payment FAILED for order-42"]);
  assertEquals(await search("order-42"), ["Payment FAILED for order-42"]);
  assertEquals(await search("příliš"), ["Platba příliš vysoká"]);
  assertEquals(await search("prilis"), []);
  assertEquals(await search("paym"), []);
  assertEquals(await search("checkout_started"), [{ event: "checkout_started" }]);
});

defineLogTest("treats search input as plain words, not as query syntax", async (service) => {
  await postJsonLogsAccepted(
    service,
    createLogsRequest([{ body: textBody("timeout while calling the model") }]),
  );
  for (
    const input of ['"', 'timeout"', "timeout OR", "NEAR(", "body:timeout", "timeout*", "---", "'"]
  ) {
    const response = await sendRequest(service, `/v1/logs?search=${encodeURIComponent(input)}`);
    assertEquals(response.status, 200, `search for ${input}: ${await response.clone().text()}`);
    await response.body?.cancel();
  }
  assertEquals(await queryBodies(service, `?search=${encodeURIComponent('"timeout"')}`), [
    "timeout while calling the model",
  ]);
});

defineLogTest("refuses a search of only white space", async (service) => {
  const response = await sendRequest(service, "/v1/logs?search=%20%20");
  assertEquals(response.status, 400);
  await response.body?.cancel();
});

defineLogTest("stores text that a database would refuse or misread", async (service) => {
  const awkwardBody = "it's 100% \\ done? $1 ?? \\n";
  const longBody = `${"lorem ipsum ".repeat(20_000)}needle-after-the-indexed-part`;
  await postJsonLogsAccepted(
    service,
    createLogsRequest([
      { body: textBody(awkwardBody), timeUnixNano: nanosecondsBeforeNow(1n) },
      {
        body: textBody("nul\u0000byte and \ud800 lone surrogate"),
        timeUnixNano: nanosecondsBeforeNow(2n),
        attributes: [stringAttribute("bad\u0000key", "bad\u0000value")],
      },
      { body: textBody(longBody), timeUnixNano: nanosecondsBeforeNow(3n) },
    ]),
  );
  const { logs } = await queryLogs(service);
  assertEquals(logs[0].body, awkwardBody);
  assertEquals(logs[1].body, "nulbyte and � lone surrogate");
  assertEquals(logs[1].attributes, { badkey: "badvalue" });
  assertEquals(logs[2].body, longBody);
  assertEquals(await queryBodies(service, "?search=needle-after-the-indexed-part"), []);
});

defineLogTest("filters by time range, severity, service and identifiers", async (service) => {
  await postJsonLogsAccepted(
    service,
    createLogsRequest([
      {
        body: textBody("old debug"),
        severityNumber: 5,
        timeUnixNano: nanosecondsBeforeNow(30n),
        attributes: [stringAttribute("correlation.id", "order-1")],
      },
      {
        body: textBody("warning"),
        severityNumber: 14,
        timeUnixNano: nanosecondsBeforeNow(20n),
        traceId: TRACE_ID,
        attributes: [stringAttribute("correlation.id", "order-2")],
      },
      {
        body: textBody("named severity"),
        severityNumber: "SEVERITY_NUMBER_ERROR2",
        timeUnixNano: nanosecondsBeforeNow(10n),
      },
    ]),
  );
  await postJsonLogsAccepted(
    service,
    createLogsRequest([{ body: textBody("other service") }], "billing"),
  );

  const minutesAgo = (minutes: number) =>
    encodeURIComponent(new Date(NOW.getTime() - minutes * 60_000).toISOString());
  assertEquals(await queryBodies(service, `?from=${minutesAgo(25)}&to=${minutesAgo(10)}`), [
    "warning",
  ]);
  assertEquals(await queryBodies(service, `?from=${minutesAgo(10)}&to=${minutesAgo(1)}`), [
    "named severity",
  ]);
  assertEquals(await queryBodies(service, "?minimumSeverity=warn"), ["named severity", "warning"]);
  assertEquals(await queryBodies(service, "?minimumSeverity=error"), ["named severity"]);
  assertEquals(await queryBodies(service, "?serviceName=billing"), ["other service"]);
  assertEquals(await queryBodies(service, "?correlationId=order-1"), ["old debug"]);
  assertEquals(await queryBodies(service, `?traceId=${TRACE_ID}`), ["warning"]);
});

defineLogTest("filters by attributes of any type", async (service) => {
  await postJsonLogsAccepted(
    service,
    createLogsRequest([
      {
        body: textBody("first"),
        timeUnixNano: nanosecondsBeforeNow(1n),
        attributes: [
          stringAttribute("gen_ai.request.model", "model=one"),
          { key: "attempt", value: { intValue: "2" } },
          { key: "cached", value: { boolValue: true } },
        ],
      },
      {
        body: textBody("second"),
        timeUnixNano: nanosecondsBeforeNow(2n),
        attributes: [
          stringAttribute("gen_ai.request.model", "model-two"),
          { key: "attempt", value: { intValue: "3" } },
          { key: "cached", value: { boolValue: false } },
        ],
      },
    ]),
  );
  const filter = (...attributes: string[]) =>
    queryBodies(
      service,
      `?${attributes.map((value) => `attribute=${encodeURIComponent(value)}`).join("&")}`,
    );
  assertEquals(await filter("gen_ai.request.model=model=one"), ["first"]);
  assertEquals(await filter("attempt=3"), ["second"]);
  assertEquals(await filter("cached=true"), ["first"]);
  assertEquals(await filter("cached=false", "attempt=3"), ["second"]);
  assertEquals(await filter("cached=true", "attempt=3"), []);
  const refused = await sendRequest(service, "/v1/logs?attribute=no-equals-sign");
  assertEquals(refused.status, 400);
  await refused.body?.cancel();
});

defineLogTest("pages through records newest first, also within one nanosecond", async (service) => {
  const logRecords = Array.from({ length: 5 }, (_, recordIndex) => ({
    body: textBody(`record ${recordIndex}`),
    timeUnixNano: nanosecondsBeforeNow(recordIndex === 4 ? 2n : 1n),
  }));
  await postJsonLogsAccepted(service, createLogsRequest(logRecords));

  const seenBodies: unknown[] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  do {
    const query: string = `?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`;
    const page: ListLogsResponse = await queryLogs(service, query);
    seenBodies.push(...page.logs.map((logRecord) => logRecord.body));
    cursor = page.nextCursor;
    pageCount++;
  } while (cursor !== null);
  assertEquals(pageCount, 3);
  assertEquals(new Set(seenBodies).size, 5);
  assertEquals(seenBodies.at(-1), "record 4");

  const refused = await sendRequest(service, "/v1/logs?cursor=not-a-cursor");
  assertEquals(refused.status, 400);
  await refused.body?.cancel();
});

defineLogTest("keeps each Project's log records separate", async (service) => {
  await postJsonLogsAccepted(service, createLogsRequest([{ body: textBody("mine") }]));
  assertEquals((await queryLogs(service, "", OTHER_PROJECT_API_KEY)).logs, []);
  assertEquals(
    (await queryLogs(service, "?search=mine", OTHER_PROJECT_API_KEY)).logs,
    [],
  );
});

defineLogTest("lets a viewer query logs but not send them", async (service) => {
  await postJsonLogsAccepted(service, createLogsRequest([{ body: textBody("visible") }]));
  const viewerToken = await testAccessTokens.issueAccessToken({
    projectId: "project-one",
    role: "viewer",
  });
  assertEquals((await queryLogs(service, "", viewerToken)).logs.length, 1);
  const ingestionResponse = await postJsonLogs(
    service,
    createLogsRequest([{ body: textBody("refused") }]),
    viewerToken,
  );
  assertEquals(ingestionResponse.status, 403);
  await ingestionResponse.body?.cancel();
});

defineLogTest("requires a valid API key to query and to send logs", async (service) => {
  const queryResponse = await sendRequest(service, "/v1/logs", { apiKey: "unknown-key" });
  assertEquals(queryResponse.status, 401);
  await queryResponse.body?.cancel();
  const countResponse = await sendRequest(service, "/v1/rejected-telemetry", {
    apiKey: "unknown-key",
  });
  assertEquals(countResponse.status, 401);
  await countResponse.body?.cancel();
  const ingestionResponse = await postJsonLogs(service, createLogsRequest([]), "unknown-key");
  assertEquals(ingestionResponse.status, 401);
  await ingestionResponse.body?.cancel();
});

defineLogTest("stores a batch larger than one insert statement", async (service) => {
  const logRecords = Array.from({ length: 1_250 }, (_, recordIndex) => ({
    body: textBody(`bulk record ${recordIndex}`),
  }));
  await postJsonLogsAccepted(service, createLogsRequest(logRecords));
  assertEquals((await queryLogs(service, "?limit=500&search=bulk")).logs.length, 500);
  const firstPage = await queryLogs(service, "?limit=500");
  assertExists(firstPage.nextCursor);
});

const PARTITION_NAME_PATTERN = /^logs_\d{8}$/;

async function listPartitionNames(database: TelemetryDatabase): Promise<string[]> {
  const rows = await database.orm.em.fork().execute<{ partition_name: string }[]>(
    `select child.relname as partition_name
      from pg_inherits
      join pg_class child on child.oid = pg_inherits.inhrelid
      join pg_class parent on parent.oid = pg_inherits.inhparent
      where parent.relname = 'logs'
      order by child.relname`,
  );
  return rows.map((row) => row.partition_name).filter((name) => PARTITION_NAME_PATTERN.test(name));
}

async function dropAllPartitions(database: TelemetryDatabase): Promise<void> {
  for (const partitionName of await listPartitionNames(database)) {
    await database.orm.em.fork().execute(`drop table "${partitionName}"`);
  }
}

for (const testDatabase of listTestDatabases("telemetry")) {
  if (testDatabase.label !== "postgresql") continue;

  Deno.test("creates each day's partition from the records' own days (postgresql)", async () => {
    const database = await openTelemetryDatabase(testDatabase.url);
    try {
      await dropAllPartitions(database);
      const service = createService(database);
      await postJsonLogsAccepted(
        service,
        createLogsRequest([
          { body: textBody("today"), timeUnixNano: NOW_NANOSECONDS.toString() },
          {
            body: textBody("yesterday"),
            timeUnixNano: (NOW_NANOSECONDS - NANOSECONDS_PER_DAY).toString(),
          },
          {
            body: textBody("last nanosecond of the day before"),
            timeUnixNano: (NOW_NANOSECONDS - NANOSECONDS_PER_DAY / 2n - 1n).toString(),
          },
        ]),
      );
      assertEquals(await listPartitionNames(database), ["logs_20261108", "logs_20261109"]);
      assertEquals((await queryLogs(service, "?search=day")).logs.length, 1);
      assertEquals((await queryLogs(service)).logs.length, 3);
    } finally {
      await database.close();
    }
  });

  Deno.test("replicas racing to create one day's partition all succeed (postgresql)", async () => {
    const replicaCount = 8;
    const databases = await Promise.all(
      Array.from({ length: replicaCount }, () => openTelemetryDatabase(testDatabase.url)),
    );
    try {
      for (let roundNumber = 0; roundNumber < 3; roundNumber++) {
        await dropAllPartitions(databases[0]);
        // Each service has its own cache of known partitions, as separate replicas have.
        const responses = await Promise.all(databases.map((database, replicaIndex) =>
          postJsonLogs(
            createService(database),
            createLogsRequest([{ body: textBody(`from replica ${replicaIndex}`) }]),
          )
        ));
        for (const response of responses) {
          assertEquals(response.status, 200, await response.clone().text());
          await response.body?.cancel();
        }
        assertEquals(await listPartitionNames(databases[0]), ["logs_20261109"]);
        const { logs } = await queryLogs(createService(databases[0]));
        assertEquals(logs.length, replicaCount);
      }
    } finally {
      await Promise.all(databases.map((database) => database.close()));
    }
  });

  Deno.test("a time range reads only the partitions it overlaps (postgresql)", async () => {
    const database = await openTelemetryDatabase(testDatabase.url);
    try {
      await dropAllPartitions(database);
      const service = createService(database);
      await postJsonLogsAccepted(
        service,
        createLogsRequest([
          { body: textBody("today"), timeUnixNano: NOW_NANOSECONDS.toString() },
          {
            body: textBody("yesterday"),
            timeUnixNano: (NOW_NANOSECONDS - NANOSECONDS_PER_DAY).toString(),
          },
        ]),
      );
      const lowerBound = (NOW_NANOSECONDS - 60n * NANOSECONDS_PER_MINUTE).toString().padStart(
        20,
        "0",
      );
      const planRows = await database.orm.em.fork().execute<{ "QUERY PLAN": string }[]>(
        `explain select log_id from logs where project_id = 'project-one'
          and time_unix_nano >= '${lowerBound}' order by time_unix_nano desc`,
      );
      const plan = planRows.map((row) => row["QUERY PLAN"]).join("\n");
      assertStringIncludes(plan, "logs_20261109");
      assert(!plan.includes("logs_20261108"), `The plan reads yesterday's partition:\n${plan}`);
    } finally {
      await database.close();
    }
  });
}

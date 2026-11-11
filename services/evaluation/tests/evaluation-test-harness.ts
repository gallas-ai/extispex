/** The Evaluation service with a fake Telemetry, a fake Target and a queue the test drains. */
import { assertEquals } from "@std/assert";
import type {
  CorrelationTelemetryResponse,
  EvaluationRunSummary,
  EvaluationRunWork,
  IterationReport,
  ListIterationResultsResponse,
  ListTestCaseResultsResponse,
  ReportIterationsResponse,
  Span,
} from "@extispex/contracts";
import {
  createRequestAuthenticator,
  createSecretCipher,
  createStructuredLogger,
  generateMasterKey,
  type ProjectResolver,
} from "@extispex/service-runtime";
import { createTestAccessTokens } from "@extispex/service-runtime/testing";
import { listTestDatabases } from "@extispex/service-storage/testing";
import {
  type AttemptJob,
  createEvaluationApiService,
  createEvaluationWorker,
  type EvaluationApiService,
  type EvaluationDatabase,
  type EvaluationWorker,
  type JobQueue,
  openEvaluationDatabase,
  TARGET_CREDENTIAL_CIPHER_PURPOSE,
} from "../src/create-service.ts";

export const TEST_TARGET_CREDENTIAL_CIPHER = await createSecretCipher(
  generateMasterKey(),
  TARGET_CREDENTIAL_CIPHER_PURPOSE,
);

export const API_KEY = "test-api-key";
export const OTHER_PROJECT_API_KEY = "other-project-api-key";
export const INACTIVE_RUN_TIMEOUT_MILLISECONDS = 3_600_000;

export const testProjectResolver: ProjectResolver = {
  resolveProjectId: (apiKey) =>
    Promise.resolve(
      ({ [API_KEY]: "project-one", [OTHER_PROJECT_API_KEY]: "project-two" })[apiKey] ?? null,
    ),
};
export const testAccessTokens = await createTestAccessTokens();
export const testRequestAuthenticator = createRequestAuthenticator({
  projectResolver: testProjectResolver,
  accessTokenVerifier: testAccessTokens.accessTokenVerifier,
});

export const MENTIONS_DAYS_EVALUATOR = {
  type: "regex",
  name: "mentions-days",
  pattern: "30\\s*days",
  flags: "i",
};

/** Stands in for Telemetry's internal API; a test says what it has received. */
export interface FakeTelemetry {
  correlations: Map<string, Omit<CorrelationTelemetryResponse, "readAt">>;
  firstReceivedAtBySession: Map<string, string>;
  spans: Map<string, Span[]>;
  sessionSpans: Map<string, Span[]>;
  evaluatedAt: Map<string, string>;
  isUnavailable: boolean;
  requestCount: number;
}

export const FAKE_SERVICE_TOKENS = {
  readServiceToken: (projectId: string | null) => Promise.resolve(`token-for-${projectId}`),
  forgetServiceToken: () => {},
};

export function createFakeTelemetryService(fake: FakeTelemetry, readClock: () => Date) {
  return async (request: Request): Promise<Response> => {
    assertEquals(request.headers.get("authorization"), "Bearer token-for-project-one");
    fake.requestCount++;
    if (fake.isUnavailable) return new Response(null, { status: 503 });
    const readAt = readClock().toISOString();
    const path = new URL(request.url).pathname.split("/").map(decodeURIComponent);
    const [resource, id, action] = path.slice(3);
    if (resource === "sessions" && action === "spans") {
      return Response.json({ readAt, spans: fake.sessionSpans.get(id) ?? [], isTruncated: false });
    }
    if (resource === "sessions") {
      const firstReceivedAt = fake.firstReceivedAtBySession.get(id) ?? null;
      return Response.json({ readAt, firstReceivedAt });
    }
    if (action === "spans") {
      return Response.json({ readAt, spans: fake.spans.get(id) ?? [], isTruncated: false });
    }
    if (action === "evaluated") {
      fake.evaluatedAt.set(id, (await request.json()).evaluatedAt);
      return new Response(null, { status: 204 });
    }
    const correlation = fake.correlations.get(id) ?? { firstReceivedAt: null, traces: [] };
    return Response.json({ readAt, ...correlation });
  };
}

/** Stands in for the user's application in Server-Driven Execution. */
export interface FakeTarget {
  url: string;
  requests: { body: { input: unknown; sessionId: string | null }; headers: Headers }[];
  /** Answers each call. Tests replace it; by default it answers every message of a Session. */
  answer: (body: { input: unknown; sessionId: string | null }, callNumber: number) => Response;
}

export function answerLikeAnApplication(
  body: { input: unknown; sessionId: string | null },
  callNumber: number,
): Response {
  return Response.json({
    output: `Refunds within 30 days. You said ${JSON.stringify(body.input)}.`,
    correlationId: `target-correlation-${callNumber}`,
    sessionId: body.sessionId ?? `target-session-${callNumber}`,
  });
}

export interface TestHarness {
  api: EvaluationApiService;
  database: EvaluationDatabase;
  worker: EvaluationWorker;
  queuedJobs: AttemptJob[];
  telemetry: FakeTelemetry;
  readClock(): Date;
  advanceClock(milliseconds: number): void;
  target: FakeTarget;
  /** Handles everything queued so far, as the worker would. */
  drainJobs(): Promise<void>;
  /** Handles jobs until none is left, including the ones that handling queues. */
  drainJobsUntilIdle(): Promise<void>;
}

export type EvaluationTestBody = (harness: TestHarness) => Promise<void>;

export function defineEvaluationTest(testName: string, testBody: EvaluationTestBody): void {
  for (const testDatabase of listTestDatabases("evaluation")) {
    Deno.test(`${testName} (${testDatabase.label})`, async () => {
      const database = await openEvaluationDatabase(testDatabase.url);
      let stopTargetServer = () => Promise.resolve();
      try {
        const entityManager = database.orm.em.fork();
        await entityManager.execute("delete from evaluation_runs");
        await entityManager.execute("delete from datasets");
        await entityManager.execute("delete from targets");
        let clockMilliseconds = Date.parse("2026-11-08T10:00:00Z");
        const readCurrentTime = () => new Date(clockMilliseconds += 1_000);
        const queuedJobs: AttemptJob[] = [];
        const jobQueue: JobQueue = {
          enqueue: (jobs) => {
            queuedJobs.push(...jobs);
            return Promise.resolve();
          },
          startWorking: () => Promise.resolve(),
          stop: () => Promise.resolve(),
        };
        const logger = createStructuredLogger("evaluation-test");
        const telemetry: FakeTelemetry = {
          correlations: new Map(),
          firstReceivedAtBySession: new Map(),
          spans: new Map(),
          sessionSpans: new Map(),
          evaluatedAt: new Map(),
          isUnavailable: false,
          requestCount: 0,
        };
        const readClock = () => new Date(clockMilliseconds);
        const target: FakeTarget = {
          url: "",
          requests: [],
          answer: answerLikeAnApplication,
        };
        const targetServer = Deno.serve(
          { hostname: "127.0.0.1", port: 0, onListen: () => {} },
          async (request) => {
            const body = await request.json();
            target.requests.push({ body, headers: request.headers });
            return target.answer(body, target.requests.length);
          },
        );
        target.url = `http://127.0.0.1:${targetServer.addr.port}/evaluate`;
        stopTargetServer = () => targetServer.shutdown();
        const worker = createEvaluationWorker({
          database,
          jobQueue,
          targetCredentialCipher: TEST_TARGET_CREDENTIAL_CIPHER,
          targetAllowedDestinations: "127.0.0.1",
          targetTimeoutMilliseconds: 2_000,
          telemetryService: createFakeTelemetryService(telemetry, readClock),
          serviceTokens: FAKE_SERVICE_TOKENS,
          logger,
          regexTimeoutMilliseconds: 300,
          inactiveRunTimeoutMilliseconds: INACTIVE_RUN_TIMEOUT_MILLISECONDS,
          readCurrentTime,
        });
        await testBody({
          database,
          api: createEvaluationApiService({
            database,
            jobQueue,
            targetCredentialCipher: TEST_TARGET_CREDENTIAL_CIPHER,
            requestAuthenticator: testRequestAuthenticator,
            logger,
            readCurrentTime,
          }),
          worker,
          queuedJobs,
          telemetry,
          readClock,
          advanceClock: (milliseconds) => {
            clockMilliseconds += milliseconds;
          },
          target,
          drainJobs: async () => {
            for (const job of queuedJobs.splice(0)) await worker.handleJob(job);
          },
          drainJobsUntilIdle: async () => {
            for (let round = 0; round < 20 && queuedJobs.length > 0; round++) {
              for (const job of queuedJobs.splice(0)) await worker.handleJob(job);
            }
          },
        });
      } finally {
        await stopTargetServer();
        await database.close();
      }
    });
  }
}

export async function sendRequest(
  { api }: TestHarness,
  method: string,
  path: string,
  options: { body?: unknown; bearerToken?: string } = {},
): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${options.bearerToken ?? API_KEY}` });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return await api.handleRequest(
    new Request(`http://evaluation.test${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
}

export async function expectJson<ResponseBody>(
  responsePromise: Promise<Response>,
  expectedStatus: number,
): Promise<ResponseBody> {
  const response = await responsePromise;
  const responseText = await response.text();
  assertEquals(response.status, expectedStatus, responseText);
  return (responseText === "" ? null : JSON.parse(responseText)) as ResponseBody;
}

export async function createDatasetWithTestCases(
  harness: TestHarness,
  testCases: Record<string, unknown>[],
): Promise<void> {
  await expectJson(
    sendRequest(harness, "POST", "/v1/datasets", { body: { name: "support-bot" } }),
    201,
  );
  for (const testCase of testCases) {
    await expectJson(
      sendRequest(harness, "POST", "/v1/datasets/support-bot/test-cases", { body: testCase }),
      201,
    );
  }
}

export function refundTestCase(overrides: Record<string, unknown> = {}) {
  return {
    name: "refund",
    input: { message: "What is your refund policy?" },
    evaluators: [MENTIONS_DAYS_EVALUATOR],
    ...overrides,
  };
}

export function startRun(harness: TestHarness, batchSize?: number) {
  return expectJson<EvaluationRunWork>(
    sendRequest(harness, "POST", "/v1/evaluation-runs", {
      body: { datasetName: "support-bot", executionMode: "client", batchSize },
    }),
    201,
  );
}

export function report(harness: TestHarness, runId: string, reports: IterationReport[]) {
  return expectJson<ReportIterationsResponse>(
    sendRequest(harness, "POST", `/v1/evaluation-runs/${runId}/reports`, { body: { reports } }),
    200,
  );
}

/** A run with every result, read page by page like a client does. */
export async function readRun(harness: TestHarness, runId: string) {
  const runPath = `/v1/evaluation-runs/${runId}`;
  const summary = await expectJson<EvaluationRunSummary>(
    sendRequest(harness, "GET", runPath),
    200,
  );
  const testCases = [];
  let cursor: number | null = null;
  do {
    const query: string = cursor === null ? "?limit=2" : `?limit=2&cursor=${cursor}`;
    const page: ListTestCaseResultsResponse = await expectJson(
      sendRequest(harness, "GET", `${runPath}/test-cases${query}`),
      200,
    );
    for (const testCase of page.testCases) {
      const iterations = [];
      let iterationCursor: number | null = null;
      do {
        const iterationQuery: string = iterationCursor === null
          ? "?limit=3"
          : `?limit=3&cursor=${iterationCursor}`;
        const iterationPage: ListIterationResultsResponse = await expectJson(
          sendRequest(
            harness,
            "GET",
            `${runPath}/test-cases/${testCase.name}/iterations${iterationQuery}`,
          ),
          200,
        );
        iterations.push(...iterationPage.iterations);
        iterationCursor = iterationPage.nextCursor;
      } while (iterationCursor !== null);
      testCases.push({ ...testCase, iterations });
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { ...summary, testCases };
}

export function outputReport(
  item: { iterationId: string; attempt: number },
  output: string,
): IterationReport {
  return {
    iterationId: item.iterationId,
    attempt: item.attempt,
    output,
    correlationId: `correlation-${item.iterationId}-${item.attempt}`,
  };
}

export function errorReport(item: { iterationId: string; attempt: number }): IterationReport {
  return { iterationId: item.iterationId, attempt: item.attempt, error: "HTTP 500 from the app" };
}

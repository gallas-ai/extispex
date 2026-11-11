/**
 * Retention and Project deletion through the Gateway: a Project's telemetry older than its
 * Retention Period disappears, and a deleted Project's data disappears from every service. The
 * deployment runs its data lifecycle every second, see `deployment.ts`.
 */
import { assert, assertEquals } from "@std/assert";
import type {
  AccessibleProject,
  CreatedApiKey,
  ListDatasetsResponse,
  ListDeletedProjectsResponse,
  ListLogsResponse,
  ListMetricsResponse,
  ListPromptsResponse,
  Project,
  TraceSummary,
} from "@extispex/contracts";
import { type RunningDeployment, startDeployment } from "./deployment.ts";
import { callGateway, createUserWithRole, signInThroughGateway } from "./sign-in.ts";

const DAY_MILLISECONDS = 86_400_000;
const REMOVAL_DEADLINE_MILLISECONDS = 30_000;

function stringAttribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

async function sendOtlpJson(
  deployment: RunningDeployment,
  apiKey: string,
  signalPath: string,
  payload: unknown,
): Promise<void> {
  const response = await fetch(`${deployment.otlpHttpUrl}${signalPath}`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const responseText = await response.text();
  assertEquals(response.status, 200, responseText);
  assertEquals(JSON.parse(responseText), {}, `${signalPath} rejected records`);
}

/** A span, a Log Record and a gauge point, all at the given time and named by `label`. */
async function sendTelemetryAt(
  deployment: RunningDeployment,
  apiKey: string,
  unixMilliseconds: number,
  label: string,
): Promise<void> {
  const timeUnixNano = (BigInt(unixMilliseconds) * 1_000_000n).toString();
  const traceId = crypto.randomUUID().replaceAll("-", "");
  const resource = { attributes: [stringAttribute("service.name", "e2e-retention")] };
  await sendOtlpJson(deployment, apiKey, "/v1/traces", {
    resourceSpans: [{
      resource,
      scopeSpans: [{
        spans: [{
          traceId,
          spanId: traceId.slice(0, 16),
          name: "handle-message",
          kind: 1,
          startTimeUnixNano: timeUnixNano,
          endTimeUnixNano: timeUnixNano,
          attributes: [stringAttribute("correlation.id", label)],
        }],
      }],
    }],
  });
  await sendOtlpJson(deployment, apiKey, "/v1/logs", {
    resourceLogs: [{
      resource,
      scopeLogs: [{
        logRecords: [{ timeUnixNano, severityNumber: 9, body: { stringValue: label } }],
      }],
    }],
  });
  await sendOtlpJson(deployment, apiKey, "/v1/metrics", {
    resourceMetrics: [{
      resource,
      scopeMetrics: [{
        metrics: [{
          name: "e2e.queue.depth",
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

/** What the Project's API key reads of each kind of telemetry. */
async function readTelemetry(deployment: RunningDeployment, apiKey: string, labels: string[]) {
  const from = new Date(Date.now() - 3 * DAY_MILLISECONDS).toISOString();
  const request = { bearerToken: apiKey };
  const traceCounts: number[] = [];
  for (const label of labels) {
    const { traces } = await callGateway<{ traces: TraceSummary[] }>(
      deployment,
      "GET",
      `/v1/traces?correlationId=${label}`,
      200,
      request,
    );
    traceCounts.push(traces.length);
  }
  const { logs } = await callGateway<ListLogsResponse>(
    deployment,
    "GET",
    `/v1/logs?from=${encodeURIComponent(from)}&limit=100`,
    200,
    request,
  );
  const { metrics } = await callGateway<ListMetricsResponse>(
    deployment,
    "GET",
    "/v1/metrics",
    200,
    request,
  );
  return {
    traceCounts,
    logBodies: logs.map((log) => String(log.body)).sort(),
    seriesCount: metrics.find((metric) => metric.name === "e2e.queue.depth")?.seriesCount ?? 0,
  };
}

async function waitFor<Value>(
  description: string,
  read: () => Promise<Value>,
  isDone: (value: Value) => boolean,
): Promise<Value> {
  const deadline = Date.now() + REMOVAL_DEADLINE_MILLISECONDS;
  while (true) {
    const value = await read();
    if (isDone(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`${description} did not happen in time: ${JSON.stringify(value)}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
}

Deno.test("Retention and Project deletion through the gateway", async (testContext) => {
  const deployment = await startDeployment();
  try {
    const admin = await signInThroughGateway(deployment, deployment.admin);
    const adminRequest = { bearerToken: admin.accessToken };
    const createProjectWithKey = async (namePrefix: string) => {
      const project = await callGateway<Project>(deployment, "POST", "/v1/projects", 201, {
        ...adminRequest,
        body: { name: `${namePrefix}-${crypto.randomUUID().slice(0, 8)}` },
      });
      const { apiKey } = await callGateway<CreatedApiKey>(
        deployment,
        "POST",
        `/v1/projects/${project.id}/api-keys`,
        201,
        { ...adminRequest, body: { name: "e2e" } },
      );
      return { project, apiKey };
    };

    await testContext.step("removes telemetry older than the Retention Period", async () => {
      const { project, apiKey } = await createProjectWithKey("e2e-retention");
      assertEquals(project.retentionDays, 30);
      const uniquePart = crypto.randomUUID().slice(0, 8);
      const oldLabel = `two-days-old-${uniquePart}`;
      const recentLabel = `recent-${uniquePart}`;
      await sendTelemetryAt(deployment, apiKey, Date.now() - 2 * DAY_MILLISECONDS, oldLabel);
      await sendTelemetryAt(deployment, apiKey, Date.now() - 60_000, recentLabel);
      assertEquals(await readTelemetry(deployment, apiKey, [oldLabel, recentLabel]), {
        traceCounts: [1, 1],
        logBodies: [recentLabel, oldLabel],
        seriesCount: 2,
      });

      const changedProject = await callGateway<AccessibleProject>(
        deployment,
        "PATCH",
        `/v1/projects/${project.id}`,
        200,
        { ...adminRequest, body: { retentionDays: 1 } },
      );
      assertEquals(changedProject.retentionDays, 1);
      const remaining = await waitFor(
        "Removing the two-day-old telemetry",
        () => readTelemetry(deployment, apiKey, [oldLabel, recentLabel]),
        (telemetry) => telemetry.logBodies.length === 1,
      );
      assertEquals(remaining, { traceCounts: [0, 1], logBodies: [recentLabel], seriesCount: 1 });
    });

    await testContext.step("removes a deleted Project's data from every service", async () => {
      const { project, apiKey } = await createProjectWithKey("e2e-deleted");
      const apiKeyRequest = { bearerToken: apiKey };
      const correlationId = `deleted-${crypto.randomUUID().slice(0, 8)}`;
      await sendTelemetryAt(deployment, apiKey, Date.now() - 60_000, correlationId);
      await callGateway(deployment, "POST", "/v1/prompts", 201, {
        ...apiKeyRequest,
        body: {
          name: "support-agent",
          type: "chat",
          messages: [{ role: "user", content: "{{question}}" }],
          modelParameters: { model: "gpt-4.1" },
        },
      });
      await callGateway(deployment, "POST", "/v1/datasets", 201, {
        ...apiKeyRequest,
        body: { name: "support-bot" },
      });
      // An access token issued before the deletion keeps working for up to five minutes, which
      // lets the test look into the Project after its data is removed.
      const { signedIn } = await createUserWithRole(deployment, admin, project.id, "viewer");
      const { accessToken } = await signedIn.requestProjectToken(project.id);
      const tokenRequest = { bearerToken: accessToken };
      const { prompts } = await callGateway<ListPromptsResponse>(
        deployment,
        "GET",
        "/v1/prompts",
        200,
        tokenRequest,
      );
      assertEquals(prompts.length, 1);

      await callGateway(deployment, "DELETE", `/v1/projects/${project.id}`, 204, adminRequest);
      const deletedProject = await waitFor(
        "Every service removing the deleted Project's data",
        async () => {
          const { deletedProjects } = await callGateway<ListDeletedProjectsResponse>(
            deployment,
            "GET",
            "/v1/deleted-projects",
            200,
            adminRequest,
          );
          return deletedProjects.find((listed) => listed.id === project.id);
        },
        (listed) =>
          listed !== undefined &&
          listed.dataRemovals.every((removal) => removal.removedAt !== null),
      );
      assert(deletedProject !== undefined);
      assertEquals(
        deletedProject.dataRemovals.map((removal) => removal.service),
        ["identity", "telemetry", "prompt", "evaluation"],
      );
      // Final only once every token issued before the deletion has expired.
      assert(deletedProject.dataRemovals.every((removal) => !removal.isComplete));

      const { traces } = await callGateway<{ traces: TraceSummary[] }>(
        deployment,
        "GET",
        `/v1/traces?correlationId=${correlationId}`,
        200,
        tokenRequest,
      );
      assertEquals(traces, []);
      const { logs } = await callGateway<ListLogsResponse>(
        deployment,
        "GET",
        "/v1/logs",
        200,
        tokenRequest,
      );
      assertEquals(logs, []);
      const { metrics } = await callGateway<ListMetricsResponse>(
        deployment,
        "GET",
        "/v1/metrics",
        200,
        tokenRequest,
      );
      assertEquals(metrics, []);
      assertEquals(
        (await callGateway<ListPromptsResponse>(
          deployment,
          "GET",
          "/v1/prompts",
          200,
          tokenRequest,
        ))
          .prompts,
        [],
      );
      assertEquals(
        (await callGateway<ListDatasetsResponse>(
          deployment,
          "GET",
          "/v1/datasets",
          200,
          tokenRequest,
        )).datasets,
        [],
      );
    });
  } finally {
    await deployment.stop();
  }
});

/**
 * Projects and API keys through the Gateway: a key that the first administrator creates works for
 * OTLP ingestion and REST, and stops working within a minute of being revoked or of its Project
 * being deleted.
 */
import { assert, assertEquals } from "@std/assert";
import type { CreatedApiKey, ListApiKeysResponse, Project } from "@extispex/contracts";
import * as grpc from "@grpc/grpc-js";
import { Buffer } from "node:buffer";
import { type RunningDeployment, startDeployment } from "./deployment.ts";
import { callGateway, signInThroughGateway } from "./sign-in.ts";

/** Identity's answers are cached for 60 seconds; the rest is time to notice the change. */
const REVOCATION_DEADLINE_MILLISECONDS = 70_000;

/** How each entry point answers a request made with the key. */
interface KeyAcceptance {
  otlpHttpStatus: number;
  otlpGrpcStatus: grpc.status;
  tracesStatus: number;
  promptsStatus: number;
}

async function checkKey(deployment: RunningDeployment, apiKey: string): Promise<KeyAcceptance> {
  const [otlpHttpResponse, tracesResponse, promptsResponse, otlpGrpcStatus] = await Promise.all([
    fetch(`${deployment.otlpHttpUrl}/v1/traces`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [] }),
    }),
    fetch(`${deployment.gatewayUrl}/v1/traces`, { headers: { authorization: `Bearer ${apiKey}` } }),
    fetch(`${deployment.gatewayUrl}/v1/prompts`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }),
    exportEmptyRequestOverGrpc(deployment, apiKey),
  ]);
  await Promise.all(
    [otlpHttpResponse, tracesResponse, promptsResponse].map((response) => response.body?.cancel()),
  );
  return {
    otlpHttpStatus: otlpHttpResponse.status,
    otlpGrpcStatus,
    tracesStatus: tracesResponse.status,
    promptsStatus: promptsResponse.status,
  };
}

const ACCEPTED: KeyAcceptance = {
  otlpHttpStatus: 200,
  otlpGrpcStatus: grpc.status.OK,
  tracesStatus: 200,
  promptsStatus: 200,
};

const REFUSED: KeyAcceptance = {
  otlpHttpStatus: 401,
  otlpGrpcStatus: grpc.status.UNAUTHENTICATED,
  tracesStatus: 401,
  promptsStatus: 401,
};

/** Sends an empty OTLP export, which is valid, and resolves with the gRPC status. */
function exportEmptyRequestOverGrpc(
  deployment: RunningDeployment,
  apiKey: string,
): Promise<grpc.status> {
  const credentials = deployment.grpcRootCertificate === null
    ? grpc.credentials.createInsecure()
    : grpc.credentials.createSsl(Buffer.from(deployment.grpcRootCertificate));
  const grpcClient = new grpc.Client(deployment.otlpGrpcAddress, credentials);
  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${apiKey}`);
  return new Promise((resolveStatus) => {
    grpcClient.makeUnaryRequest(
      "/opentelemetry.proto.collector.trace.v1.TraceService/Export",
      (message: Buffer) => message,
      (message: Buffer) => message,
      Buffer.alloc(0),
      metadata,
      (error) => {
        grpcClient.close();
        resolveStatus(error?.code ?? grpc.status.OK);
      },
    );
  });
}

/** Polls until every entry point refuses the key, and returns how long that took. */
async function measureTimeUntilRefused(
  deployment: RunningDeployment,
  apiKey: string,
): Promise<number> {
  const startedAt = Date.now();
  while (true) {
    const acceptance = await checkKey(deployment, apiKey);
    if (JSON.stringify(acceptance) === JSON.stringify(REFUSED)) return Date.now() - startedAt;
    if (Date.now() - startedAt > REVOCATION_DEADLINE_MILLISECONDS) {
      throw new Error(`The key still works after a minute: ${JSON.stringify(acceptance)}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
}

Deno.test({
  name: "Projects and API keys through the gateway",
  // gRPC keeps its channel's timers briefly after a call ends.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (testContext) => {
    const deployment = await startDeployment();
    const admin = await signInThroughGateway(deployment, deployment.admin);
    const adminRequest = { bearerToken: admin.accessToken };
    // A fresh name keeps the test apart from Projects that other runs leave in a shared database.
    const projectName = `e2e-project-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await testContext.step("accepts the first Project's key from the configuration", async () => {
        assertEquals(await checkKey(deployment, deployment.apiKey), ACCEPTED);
      });

      await testContext.step("refuses management without a user's access token", async () => {
        for (const bearerToken of [deployment.apiKey, "wrong-access-token"]) {
          await callGateway(deployment, "GET", "/v1/projects", 401, { bearerToken });
        }
      });

      let project: Project | null = null;
      let revokedKey: CreatedApiKey | null = null;
      let keptKey: CreatedApiKey | null = null;

      const createApiKey = (projectId: string, name: string) =>
        callGateway<CreatedApiKey>(deployment, "POST", `/v1/projects/${projectId}/api-keys`, 201, {
          ...adminRequest,
          body: { name },
        });

      await testContext.step("creates a Project whose new keys work at once", async () => {
        project = await callGateway<Project>(deployment, "POST", "/v1/projects", 201, {
          ...adminRequest,
          body: { name: projectName },
        });
        revokedKey = await createApiKey(project.id, "Old laptop");
        keptKey = await createApiKey(project.id, "CI pipeline");
        assertEquals(await checkKey(deployment, revokedKey.apiKey), ACCEPTED);
        assertEquals(await checkKey(deployment, keptKey.apiKey), ACCEPTED);
      });

      await testContext.step("keeps the new Project's data apart", async () => {
        assert(keptKey !== null);
        const promptName = `e2e-isolated-${crypto.randomUUID().slice(0, 8)}`;
        await callGateway(deployment, "POST", "/v1/prompts", 201, {
          bearerToken: keptKey.apiKey,
          body: { name: promptName, type: "text", text: "Hello" },
        });
        await callGateway(deployment, "GET", `/v1/prompts/${promptName}`, 404, {
          bearerToken: deployment.apiKey,
        });
      });

      await testContext.step(
        "stops a revoked key and a deleted Project's key within a minute",
        async () => {
          assert(project !== null && revokedKey !== null && keptKey !== null);
          // A second Project to delete, so that both changes can be waited for at once.
          const deletedProject = await callGateway<Project>(
            deployment,
            "POST",
            "/v1/projects",
            201,
            { ...adminRequest, body: { name: `${projectName}-deleted` } },
          );
          const deletedProjectKey = await createApiKey(deletedProject.id, "CI pipeline");
          // Used once, so that Telemetry and Prompt hold a cached answer that must expire.
          assertEquals(await checkKey(deployment, deletedProjectKey.apiKey), ACCEPTED);

          await callGateway(
            deployment,
            "DELETE",
            `/v1/projects/${project.id}/api-keys/${revokedKey.id}`,
            204,
            adminRequest,
          );
          await callGateway(
            deployment,
            "DELETE",
            `/v1/projects/${deletedProject.id}`,
            204,
            adminRequest,
          );
          const [millisecondsUntilRevoked, millisecondsUntilDeleted] = await Promise.all([
            measureTimeUntilRefused(deployment, revokedKey.apiKey),
            measureTimeUntilRefused(deployment, deletedProjectKey.apiKey),
          ]);
          console.log(
            `Refused ${millisecondsUntilRevoked} ms after revoking the key and ` +
              `${millisecondsUntilDeleted} ms after deleting the Project.`,
          );

          assertEquals(await checkKey(deployment, keptKey.apiKey), ACCEPTED);
          assertEquals(await checkKey(deployment, deployment.apiKey), ACCEPTED);
          const { apiKeys } = await callGateway<ListApiKeysResponse>(
            deployment,
            "GET",
            `/v1/projects/${project.id}/api-keys`,
            200,
            adminRequest,
          );
          assertEquals(
            apiKeys.map((apiKey) => [apiKey.name, apiKey.revokedAt === null]),
            [["CI pipeline", true], ["Old laptop", false]],
          );
        },
      );
    } finally {
      await deployment.stop();
    }
  },
});

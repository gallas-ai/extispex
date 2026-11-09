import {
  type CorrelationSpansResponse,
  type CorrelationTelemetryResponse,
  listCorrelationSpansRoute,
  markCorrelationEvaluatedRoute,
  readCorrelationTelemetryRoute,
  readSessionTelemetryRoute,
  type SessionTelemetryResponse,
} from "@extispex/contracts";
import type { ServiceClient } from "@extispex/service-client";
import {
  createServiceTokenClient,
  IdentityUnavailableError,
  type ServiceTokenSource,
  UnknownProjectError,
} from "@extispex/service-runtime";

/** Telemetry could not answer now; asking again later may work. */
export class TelemetryUnavailableError extends Error {
  override name = "TelemetryUnavailableError";
}

/** What the worker asks Telemetry about one Project's Iterations. */
export interface TelemetryClient {
  readCorrelation(projectId: string, correlationId: string): Promise<CorrelationTelemetryResponse>;
  readSession(projectId: string, sessionId: string): Promise<SessionTelemetryResponse>;
  listSpans(projectId: string, correlationId: string): Promise<CorrelationSpansResponse>;
  markEvaluated(projectId: string, correlationId: string, evaluatedAt: string): Promise<void>;
}

function fillPath(routePath: string, parameter: string, value: string): string {
  return routePath.replace(`{${parameter}}`, encodeURIComponent(value));
}

export function createTelemetryClient(
  telemetryService: ServiceClient,
  serviceTokens: ServiceTokenSource,
): TelemetryClient {
  const send = async (projectId: string, path: string, init?: RequestInit): Promise<Response> => {
    const projectClient = createServiceTokenClient(telemetryService, serviceTokens, projectId);
    let response: Response;
    try {
      response = await projectClient(new Request(`http://telemetry${path}`, init));
    } catch (error) {
      // Getting the token can fail too; the caller tells those reasons apart.
      if (error instanceof IdentityUnavailableError || error instanceof UnknownProjectError) {
        throw error;
      }
      throw new TelemetryUnavailableError("The Telemetry service is unreachable.", {
        cause: error,
      });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new TelemetryUnavailableError(
        `The Telemetry service answered ${path} with status ${response.status}.`,
      );
    }
    return response;
  };
  const readJson = async <ResponseBody>(projectId: string, path: string): Promise<ResponseBody> =>
    await (await send(projectId, path)).json() as ResponseBody;

  return {
    readCorrelation: (projectId, correlationId) =>
      readJson(
        projectId,
        fillPath(readCorrelationTelemetryRoute.path, "correlationId", correlationId),
      ),
    readSession: (projectId, sessionId) =>
      readJson(projectId, fillPath(readSessionTelemetryRoute.path, "sessionId", sessionId)),
    listSpans: (projectId, correlationId) =>
      readJson(projectId, fillPath(listCorrelationSpansRoute.path, "correlationId", correlationId)),
    async markEvaluated(projectId, correlationId, evaluatedAt) {
      const response = await send(
        projectId,
        fillPath(markCorrelationEvaluatedRoute.path, "correlationId", correlationId),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ evaluatedAt }),
        },
      );
      await response.body?.cancel();
    },
  };
}

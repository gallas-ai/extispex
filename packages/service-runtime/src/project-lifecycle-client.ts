import {
  type ProjectLifecycle,
  readProjectLifecycleRoute,
  recordProjectDataRemovalRoute,
} from "@extispex/contracts";
import type { ServiceClient } from "@extispex/service-client";
import { IdentityUnavailableError } from "./identity-unavailable-error.ts";

/** What a service learns from Identity for its periodic data work, and how it reports back. */
export interface ProjectLifecycleSource {
  /** Rejects with {@link IdentityUnavailableError} when Identity cannot answer. */
  readProjectLifecycle(): Promise<ProjectLifecycle>;
  /** Tells Identity that this service has removed the deleted Project's data, just now. */
  recordDataRemoval(projectId: string): Promise<void>;
}

/**
 * Calls Identity's internal project lifecycle endpoints. The client must send this service's token
 * without a Project, as `createServiceTokenClient` does, because Identity reads from it which
 * service is asking.
 */
export function createIdentityProjectLifecycleSource(
  identityClient: ServiceClient,
): ProjectLifecycleSource {
  const send = async (request: Request): Promise<Response> => {
    let response: Response;
    try {
      response = await identityClient(request);
    } catch (error) {
      throw new IdentityUnavailableError("The Identity service is unreachable.", { cause: error });
    }
    if (!response.ok) {
      const responseText = await response.text();
      throw new IdentityUnavailableError(
        `The Identity service answered ${request.method} ${new URL(request.url).pathname} with ` +
          `status ${response.status}: ${responseText}`,
      );
    }
    return response;
  };
  return {
    async readProjectLifecycle() {
      const response = await send(new Request(`http://identity${readProjectLifecycleRoute.path}`));
      return await response.json() as ProjectLifecycle;
    },
    async recordDataRemoval(projectId) {
      const path = recordProjectDataRemovalRoute.path.replace(
        "{projectId}",
        encodeURIComponent(projectId),
      );
      const response = await send(new Request(`http://identity${path}`, { method: "PUT" }));
      await response.body?.cancel();
    },
  };
}

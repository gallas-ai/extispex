/**
 * Sends a request to another service. Production uses HTTP; the all-in-one deployment calls the
 * service's request handler directly. Both go through the same request and response contract.
 */
export type ServiceClient = (request: Request) => Promise<Response>;

export type ServiceRequestHandler = (request: Request) => Response | Promise<Response>;

export function createHttpServiceClient(serviceBaseUrl: string): ServiceClient {
  const baseUrl = new URL(serviceBaseUrl);
  return (request) => fetch(rewriteRequestOrigin(request, baseUrl));
}

export function createInProcessServiceClient(handleRequest: ServiceRequestHandler): ServiceClient {
  const inProcessOrigin = new URL("http://in-process.local");
  return async (request) => await handleRequest(rewriteRequestOrigin(request, inProcessOrigin));
}

function rewriteRequestOrigin(request: Request, targetOrigin: URL): Request {
  const originalUrl = new URL(request.url);
  const targetUrl = new URL(originalUrl.pathname + originalUrl.search, targetOrigin);
  return new Request(targetUrl, request);
}

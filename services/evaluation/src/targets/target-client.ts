import type { TargetCredential } from "@extispex/contracts";
import { z } from "zod";
import {
  DestinationNotAllowedError,
  type PostResult,
  postToAllowedDestination,
  type ResolveHostAddresses,
  resolveWithSystem,
} from "./allowed-destination-post.ts";
import type { DestinationAllowlist } from "./destination-allowlist.ts";
import type { ProxyRouting } from "./proxy-settings.ts";

export const DEFAULT_TARGET_TIMEOUT_MILLISECONDS = 60_000;

/** An Output may reach a million characters, each up to three bytes, plus the JSON around it. */
const MAXIMUM_TARGET_RESPONSE_BYTES = 4_000_000;
const TELEMETRY_ID_MAXIMUM_LENGTH = 256;

const targetResponseSchema = z.object({
  output: z.string().max(1_000_000),
  correlationId: z.string().min(1).max(TELEMETRY_ID_MAXIMUM_LENGTH),
  sessionId: z.string().min(1).max(TELEMETRY_ID_MAXIMUM_LENGTH).nullable().optional(),
});

export interface TargetEndpoint {
  url: string;
  credential: TargetCredential | null;
}

/** What each step of an Iteration sends. The Session's ID is null until the Target returns one. */
export interface TargetCall {
  input: unknown;
  sessionId: string | null;
}

export type TargetCallResult =
  | { status: "answered"; output: string; correlationId: string; sessionId: string | null }
  | { status: "error"; reason: string };

export interface TargetClient {
  callTarget(endpoint: TargetEndpoint, call: TargetCall): Promise<TargetCallResult>;
}

export type { ResolvedAddress, ResolveHostAddresses } from "./allowed-destination-post.ts";

export interface TargetClientOptions {
  allowlist: DestinationAllowlist;
  timeoutMilliseconds: number;
  /** The system's resolver by default; tests answer with changing addresses. */
  resolveHostAddresses?: ResolveHostAddresses;
  /** From `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`; direct connections when not given. */
  proxyRouting?: ProxyRouting;
}

const NOT_ALLOWED_REASON =
  "This Target's address is not allowed by EVALUATION_TARGET_ALLOWED_DESTINATIONS.";

function parseTargetResponse(body: string): TargetCallResult {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    return { status: "error", reason: "The Target did not answer with JSON." };
  }
  const answer = targetResponseSchema.safeParse(parsedBody);
  if (!answer.success) {
    return {
      status: "error",
      reason: "The Target's answer needs an `output` string and a `correlationId`.",
    };
  }
  return {
    status: "answered",
    output: answer.data.output,
    correlationId: answer.data.correlationId,
    sessionId: answer.data.sessionId ?? null,
  };
}

export function createTargetClient(options: TargetClientOptions): TargetClient {
  const { allowlist, timeoutMilliseconds } = options;
  const resolveHostAddresses = options.resolveHostAddresses ?? resolveWithSystem;
  return {
    async callTarget(endpoint, call) {
      const url = new URL(endpoint.url);
      if (!allowlist.isUrlAllowed(url)) return { status: "error", reason: NOT_ALLOWED_REASON };
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (endpoint.credential !== null) {
        headers[endpoint.credential.headerName] = endpoint.credential.headerValue;
      }
      const signal = AbortSignal.timeout(timeoutMilliseconds);
      let result: PostResult;
      try {
        result = await postToAllowedDestination(
          url,
          headers,
          JSON.stringify({ input: call.input, sessionId: call.sessionId }),
          {
            allowlist,
            resolveHostAddresses,
            notAllowedReason: NOT_ALLOWED_REASON,
            maximumResponseBytes: MAXIMUM_TARGET_RESPONSE_BYTES,
            proxyRouting: options.proxyRouting,
          },
          signal,
        );
      } catch (error) {
        if (error instanceof DestinationNotAllowedError) {
          return { status: "error", reason: error.message };
        }
        if (signal.aborted) {
          return {
            status: "error",
            reason: `The Target did not answer within ${timeoutMilliseconds} ms.`,
          };
        }
        return {
          status: "error",
          reason: `The Target could not be reached: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if ("status" in result) {
        return {
          status: "error",
          reason: `The Target's answer is larger than ${MAXIMUM_TARGET_RESPONSE_BYTES} bytes.`,
        };
      }
      if (result.statusCode >= 300 && result.statusCode < 400) {
        return {
          status: "error",
          reason:
            `The Target answered with a redirect (${result.statusCode}), which is not followed.`,
        };
      }
      if (result.statusCode < 200 || result.statusCode >= 300) {
        return { status: "error", reason: `The Target answered with status ${result.statusCode}.` };
      }
      return parseTargetResponse(result.body);
    },
  };
}

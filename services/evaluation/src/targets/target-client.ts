import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { TargetCredential } from "@extispex/contracts";
import { z } from "zod";
import type { DestinationAllowlist } from "./destination-allowlist.ts";

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

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type ResolveHostAddresses = (hostName: string) => Promise<ResolvedAddress[]>;

export interface TargetClientOptions {
  allowlist: DestinationAllowlist;
  timeoutMilliseconds: number;
  /** The system's resolver by default; tests answer with changing addresses. */
  resolveHostAddresses?: ResolveHostAddresses;
}

function resolveWithSystem(hostName: string): Promise<ResolvedAddress[]> {
  return dns.promises.lookup(hostName, { all: true });
}

class DestinationNotAllowedError extends Error {
  override name = "DestinationNotAllowedError";
}

const NOT_ALLOWED_REASON =
  "This Target's address is not allowed by EVALUATION_TARGET_ALLOWED_DESTINATIONS.";

type PostResult = { statusCode: number; body: string } | { status: "too_large" };

/**
 * Posts JSON and reads the answer without following redirects. The address is resolved once, here,
 * and the connection uses exactly the addresses that were checked: a DNS record that changes
 * between the check and the connection cannot redirect the call.
 */
function postJson(
  url: URL,
  headers: Record<string, string>,
  body: string,
  { allowlist, resolveHostAddresses }: Required<
    Pick<TargetClientOptions, "allowlist" | "resolveHostAddresses">
  >,
  signal: AbortSignal,
): Promise<PostResult> {
  return new Promise((resolvePost, rejectPost) => {
    type LookupCallback = (
      error: Error | null,
      addresses: ResolvedAddress[] | string,
      family?: number,
    ) => void;
    const lookup = (hostName: string, options: unknown, callback: LookupCallback) => {
      resolveHostAddresses(hostName).then((addresses) => {
        if (!allowlist.areResolvedAddressesAllowed(url, addresses.map((item) => item.address))) {
          throw new DestinationNotAllowedError(NOT_ALLOWED_REASON);
        }
        if ((options as { all?: boolean }).all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      }).catch((error) => callback(error, []));
    };
    const send = url.protocol === "https:" ? https.request : http.request;
    const clientRequest = send(url, {
      method: "POST",
      headers,
      // A new connection for each call, so that every call goes through the lookup above.
      agent: false,
      lookup,
      signal,
    } as http.RequestOptions, (incoming) => {
      const chunks: Uint8Array[] = [];
      let byteCount = 0;
      incoming.on("data", (chunk: Uint8Array) => {
        byteCount += chunk.length;
        if (byteCount > MAXIMUM_TARGET_RESPONSE_BYTES) {
          clientRequest.destroy();
          resolvePost({ status: "too_large" });
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("end", () => {
        const merged = new Uint8Array(byteCount);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        resolvePost({
          statusCode: incoming.statusCode ?? 0,
          body: new TextDecoder().decode(merged),
        });
      });
      incoming.on("error", rejectPost);
    });
    clientRequest.on("error", rejectPost);
    clientRequest.end(body);
  });
}

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
        result = await postJson(
          url,
          headers,
          JSON.stringify({ input: call.input, sessionId: call.sessionId }),
          { allowlist, resolveHostAddresses },
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

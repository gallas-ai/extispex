import type { LlmProviderKind } from "@extispex/contracts";
import {
  type DestinationAllowlist,
  DestinationNotAllowedError,
  postToAllowedDestination,
  type ProxyRouting,
  type ResolveHostAddresses,
  resolveWithSystem,
} from "../targets/mod.ts";
import { anthropicAdapter } from "./anthropic-adapter.ts";
import { openAiCompatibleAdapter } from "./openai-compatible-adapter.ts";
import {
  type JudgmentAnswer,
  type JudgmentRequest,
  type ParsedAnswer,
  type ProviderAdapter,
  type ProviderEndpoint,
  type ProviderHttpRequest,
  readProviderErrorMessage,
  type TextGenerationRequest,
} from "./provider-adapter.ts";
import { typeSafeAdapter } from "./typesafe-adapter.ts";

export const DEFAULT_LLM_TIMEOUT_MILLISECONDS = 60_000;
/** A provider that is busy or briefly down gets two more tries before the call is an Error. */
const RETRY_COUNT = 2;
const DEFAULT_RETRY_DELAY_MILLISECONDS = 1_000;
/** A `retry-after` above this is not waited for: the attempt's own retry comes later anyway. */
const MAXIMUM_RETRY_AFTER_MILLISECONDS = 10_000;
const MAXIMUM_RESPONSE_BYTES = 4_000_000;
/** 529 is Anthropic's and TypeSafe's "overloaded". */
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

const NOT_ALLOWED_REASON =
  "This LLM provider's address is not allowed by EVALUATION_LLM_PROVIDER_ALLOWED_DESTINATIONS.";

export const PROVIDER_ADAPTERS: Record<LlmProviderKind, ProviderAdapter> = {
  openai_compatible: openAiCompatibleAdapter,
  anthropic: anthropicAdapter,
  typesafe: typeSafeAdapter,
};

/** What a call needs to know about the provider. */
export interface ProviderTarget extends ProviderEndpoint {
  kind: LlmProviderKind;
}

export type ProviderAnswer<Value> =
  | { status: "answered"; value: Value; model: string }
  | { status: "error"; reason: string };

/** Calls LLM providers. Never rejects because of the provider: a failure is an answer too. */
export interface LlmProviderClient {
  generateText(target: ProviderTarget, request: TextGenerationRequest): Promise<
    ProviderAnswer<string>
  >;
  answerQuestion(target: ProviderTarget, request: JudgmentRequest): Promise<
    ProviderAnswer<JudgmentAnswer>
  >;
}

export interface LlmProviderClientOptions {
  allowlist: DestinationAllowlist;
  timeoutMilliseconds: number;
  resolveHostAddresses?: ResolveHostAddresses;
  /** From `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`; direct connections when not given. */
  proxyRouting?: ProxyRouting;
  /** The wait before the first retry, doubled for the second; tests shorten it. */
  retryDelayMilliseconds?: number;
}

type CallResult = { status: "ok"; body: unknown } | {
  status: "error";
  reason: string;
  isRetryable: boolean;
  retryAfterMilliseconds?: number;
};

/** `retry-after` in seconds; a date is ignored and the usual delay applies. */
function readRetryAfter(headerValue: string | undefined): number | undefined {
  if (headerValue === undefined) return undefined;
  const seconds = Number(headerValue);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export function createLlmProviderClient(options: LlmProviderClientOptions): LlmProviderClient {
  const { allowlist, timeoutMilliseconds } = options;
  const resolveHostAddresses = options.resolveHostAddresses ?? resolveWithSystem;
  const retryDelayMilliseconds = options.retryDelayMilliseconds ?? DEFAULT_RETRY_DELAY_MILLISECONDS;

  const callOnce = async (request: ProviderHttpRequest): Promise<CallResult> => {
    if (!allowlist.isUrlAllowed(request.url)) {
      return { status: "error", reason: NOT_ALLOWED_REASON, isRetryable: false };
    }
    const signal = AbortSignal.timeout(timeoutMilliseconds);
    try {
      const result = await postToAllowedDestination(
        request.url,
        request.headers,
        JSON.stringify(request.body),
        {
          allowlist,
          resolveHostAddresses,
          maximumResponseBytes: MAXIMUM_RESPONSE_BYTES,
          notAllowedReason: NOT_ALLOWED_REASON,
          proxyRouting: options.proxyRouting,
        },
        signal,
      );
      if ("status" in result) {
        return {
          status: "error",
          reason: `The LLM provider's answer is larger than ${MAXIMUM_RESPONSE_BYTES} bytes.`,
          isRetryable: false,
        };
      }
      if (result.statusCode < 200 || result.statusCode >= 300) {
        return {
          status: "error",
          reason: `The LLM provider answered with status ${result.statusCode}: ${
            readProviderErrorMessage(result.body)
          }`,
          isRetryable: RETRYABLE_STATUSES.has(result.statusCode),
          retryAfterMilliseconds: readRetryAfter(result.retryAfter),
        };
      }
      try {
        return { status: "ok", body: JSON.parse(result.body) };
      } catch {
        return {
          status: "error",
          reason: "The LLM provider did not answer with JSON.",
          isRetryable: false,
        };
      }
    } catch (error) {
      if (error instanceof DestinationNotAllowedError) {
        return { status: "error", reason: error.message, isRetryable: false };
      }
      if (signal.aborted) {
        return {
          status: "error",
          reason: `The LLM provider did not answer within ${timeoutMilliseconds} ms.`,
          isRetryable: true,
        };
      }
      return {
        status: "error",
        reason: `The LLM provider could not be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
        isRetryable: true,
      };
    }
  };

  const callWithRetries = async (request: ProviderHttpRequest): Promise<CallResult> => {
    let result = await callOnce(request);
    for (let retry = 1; retry <= RETRY_COUNT; retry++) {
      if (result.status === "ok" || !result.isRetryable) return result;
      const delay = result.retryAfterMilliseconds ?? retryDelayMilliseconds * 2 ** (retry - 1);
      if (delay > MAXIMUM_RETRY_AFTER_MILLISECONDS) return result;
      await sleep(delay);
      result = await callOnce(request);
    }
    return result;
  };

  const call = async <Value>(
    httpRequest: ProviderHttpRequest,
    requestedModel: string,
    parse: (body: unknown) => ParsedAnswer<Value>,
  ): Promise<ProviderAnswer<Value>> => {
    const result = await callWithRetries(httpRequest);
    if (result.status === "error") return { status: "error", reason: result.reason };
    const parsed = parse(result.body);
    if (parsed.status === "error") return parsed;
    return { status: "answered", value: parsed.value, model: parsed.model ?? requestedModel };
  };

  return {
    async generateText(target, request) {
      const adapter = PROVIDER_ADAPTERS[target.kind];
      if (!adapter.buildTextRequest || !adapter.parseTextResponse) {
        return { status: "error", reason: "This LLM provider does not offer Text Generation." };
      }
      return await call(
        adapter.buildTextRequest(target, request),
        request.settings.model,
        (body) => adapter.parseTextResponse!(body, request),
      );
    },

    async answerQuestion(target, request) {
      const adapter = PROVIDER_ADAPTERS[target.kind];
      if (!adapter.buildJudgmentRequest || !adapter.parseJudgmentResponse) {
        return { status: "error", reason: "This LLM provider does not offer Judgment." };
      }
      return await call(
        adapter.buildJudgmentRequest(target, request),
        request.model,
        (body) => adapter.parseJudgmentResponse!(body, request),
      );
    },
  };
}

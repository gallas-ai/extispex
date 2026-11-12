/**
 * Stands in for OpenAI-compatible, Anthropic and TypeSafe servers. By default it passes a
 * Transcript that mentions "30 days" and writes a short LLM Summary; a test may answer otherwise.
 */
export type FakeProviderKind = "openai_compatible" | "anthropic" | "typesafe";

export interface FakeLlmRequest {
  kind: FakeProviderKind;
  path: string;
  headers: Headers;
  // deno-lint-ignore no-explicit-any
  body: any;
}

export interface FakeLlmProvider {
  /** The base URL of every kind: `<url>/v1` for OpenAI-compatible, `<url>` for the others. */
  url: string;
  requests: FakeLlmRequest[];
  /** Answers a request; tests replace it. Returns null to answer as the default does. */
  answer: (request: FakeLlmRequest) => Response | null;
  stop(): Promise<void>;
}

export const FAKE_SUMMARY_TEXT = "The run passed: every Test Case met its expectations.";

function readKind(path: string): FakeProviderKind | null {
  if (path.endsWith("/chat/completions")) return "openai_compatible";
  if (path.endsWith("/v1/messages")) return "anthropic";
  if (path.endsWith("/v1/systemone")) return "typesafe";
  return null;
}

/** What the application said, as text, to decide on: the messages, or the state's Transcript. */
// deno-lint-ignore no-explicit-any
function readRequestText(body: any): string {
  return JSON.stringify(body.messages ?? body.state?.transcript ?? body);
}

function verdictFor(text: string) {
  const mentionsDays = text.includes("30 days");
  return {
    passed: mentionsDays,
    score: mentionsDays ? 0.9 : 0.2,
    explanation: mentionsDays
      ? "The application states the 30-day refund policy."
      : "The application never states the refund policy.",
  };
}

export function answerByDefault(request: FakeLlmRequest): Response {
  const text = readRequestText(request.body);
  if (request.kind === "openai_compatible") {
    const content = request.body.response_format
      ? JSON.stringify(verdictFor(text))
      : FAKE_SUMMARY_TEXT;
    return Response.json({
      id: "chatcmpl-fake",
      model: `${request.body.model}-2026-01-01`,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    });
  }
  if (request.kind === "anthropic") {
    const content = request.body.output_config
      ? JSON.stringify(verdictFor(text))
      : FAKE_SUMMARY_TEXT;
    return Response.json({
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: request.body.model,
      stop_reason: "end_turn",
      content: [{ type: "text", text: content }],
    });
  }
  const [[questionName, question]] = Object.entries(request.body.questions) as [
    string,
    { type: string; criteria: unknown },
  ][];
  const isGood = text.includes("30 days");
  let answer: Record<string, unknown>;
  if (question.type === "noul") {
    answer = { type: "noul", noul: isGood ? 0.93 : 0.08 };
  } else if (question.type === "score") {
    const levels = question.criteria as string[];
    const level = isGood ? levels.length - 1 : 0;
    answer = {
      type: "score",
      score: level,
      confidence: 0.8,
      legend: Object.fromEntries(levels.map((description, index) => [String(index), description])),
      probabilities: Object.fromEntries(
        levels.map((
          _,
          index,
        ) => [String(index), index === level ? 0.9 : 0.1 / (levels.length - 1)]),
      ),
    };
  } else {
    // Sorted, because PostgreSQL does not keep the order of a JSON object's keys.
    const choices = Object.keys(question.criteria as Record<string, string>).sort();
    const choice = isGood ? choices[0] : choices[choices.length - 1];
    answer = {
      type: "choice",
      choice,
      confidence: 0.7,
      probabilities: Object.fromEntries(
        choices.map((name) => [name, name === choice ? 0.8 : 0.2 / (choices.length - 1)]),
      ),
    };
  }
  return Response.json({
    model: "jev-1.14.0",
    answers: { [questionName]: answer },
    usage: { input_tokens: 120, output_tokens: 12 },
  });
}

export function startFakeLlmProvider(): FakeLlmProvider {
  const fake: FakeLlmProvider = {
    url: "",
    requests: [],
    answer: () => null,
    stop: () => Promise.resolve(),
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (incoming) => {
      const path = new URL(incoming.url).pathname;
      const kind = readKind(path);
      if (kind === null) return new Response("Not found", { status: 404 });
      const request = { kind, path, headers: incoming.headers, body: await incoming.json() };
      fake.requests.push(request);
      return fake.answer(request) ?? answerByDefault(request);
    },
  );
  fake.url = `http://127.0.0.1:${server.addr.port}`;
  fake.stop = () => server.shutdown();
  return fake;
}

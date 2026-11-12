/**
 * A fake LLM provider on this machine, for the deployment under test. It speaks the OpenAI Chat
 * Completions API and TypeSafe's System One API. It passes a Transcript that mentions "30 days"
 * and writes a fixed LLM Summary.
 */
export const FAKE_SUMMARY_TEXT = "Every Test Case passed; the bot states the 30-day refund policy.";

export interface RunningFakeLlmProvider {
  /** The base URL: `<url>/v1` for OpenAI-compatible, `<url>` for TypeSafe. */
  url: string;
  // deno-lint-ignore no-explicit-any
  requests: { path: string; body: any }[];
  stop(): Promise<void>;
}

// deno-lint-ignore no-explicit-any
function answer(path: string, body: any): Response {
  if (path.endsWith("/chat/completions")) {
    const mentionsDays = JSON.stringify(body.messages).includes("30 days");
    const content = body.response_format
      ? JSON.stringify({
        passed: mentionsDays,
        score: mentionsDays ? 0.9 : 0.1,
        explanation: mentionsDays
          ? "The bot states the 30-day refund period."
          : "The bot never states a refund period.",
      })
      : FAKE_SUMMARY_TEXT;
    return Response.json({
      model: `${body.model}-fake`,
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    });
  }
  if (path.endsWith("/v1/systemone")) {
    const mentionsDays = JSON.stringify(body.state.transcript).includes("30 days");
    const [questionName] = Object.keys(body.questions);
    return Response.json({
      model: "jev-fake",
      answers: { [questionName]: { type: "noul", noul: mentionsDays ? 0.95 : 0.05 } },
      usage: { input_tokens: 10, output_tokens: 1 },
    });
  }
  return new Response("Not found", { status: 404 });
}

export function startFakeLlmProvider(): RunningFakeLlmProvider {
  const requests: RunningFakeLlmProvider["requests"] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      const body = await request.json();
      requests.push({ path, body });
      return answer(path, body);
    },
  );
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    requests,
    stop: () => server.shutdown(),
  };
}

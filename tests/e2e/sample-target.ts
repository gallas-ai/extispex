/** Starts the sample Target in examples/ for an e2e test. */
import { waitForCondition } from "./browser.ts";
import type { RunningDeployment } from "./deployment.ts";

/** What callers must send as `Authorization: Bearer <token>`. */
export const SAMPLE_TARGET_TOKEN = "e2e-target-token";

export interface RunningSampleTarget {
  url: string;
  stop(): Promise<void>;
}

/** The sample Target, sending its spans to the deployment under test. */
export async function startSampleTarget(
  deployment: RunningDeployment,
): Promise<RunningSampleTarget> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const childProcess = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-env", "examples/typescript/sample-target.ts"],
    cwd: new URL("../../", import.meta.url).pathname,
    env: {
      API_KEY: deployment.apiKey,
      OTLP_HTTP_URL: deployment.otlpHttpUrl,
      PORT: String(port),
      TARGET_TOKEN: SAMPLE_TARGET_TOKEN,
    },
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForCondition("the sample Target listens", async () => {
    try {
      const response = await fetch(`${baseUrl}/health`);
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }, 60_000);
  return {
    url: `${baseUrl}/evaluate`,
    stop: async () => {
      childProcess.kill("SIGTERM");
      await childProcess.status;
    },
  };
}

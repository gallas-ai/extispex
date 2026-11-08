/**
 * Runs a Dataset with Client-Driven Execution: this script calls the application itself and
 * reports each Output, and the platform judges them.
 *
 *     API_KEY=<your Project API key> deno task run-dataset
 *
 * Environment: API_KEY (required), GATEWAY_URL (default http://127.0.0.1:8080) and DATASET_NAME
 * (default support-bot-example). Exits with 0 when the run's verdict is `passed`.
 */

interface WorkItem {
  iterationId: string;
  attempt: number;
  testCaseName: string;
  input: { message: string };
}

interface RunWork {
  runId: string;
  status: "running" | "finished";
  verdict: "passed" | "failed" | "error" | null;
  items: WorkItem[];
}

const apiKey = Deno.env.get("API_KEY");
if (!apiKey) {
  console.error("Set API_KEY to a Project API key.");
  Deno.exit(2);
}
const gatewayUrl = Deno.env.get("GATEWAY_URL") ?? "http://127.0.0.1:8080";
const datasetName = Deno.env.get("DATASET_NAME") ?? "support-bot-example";

async function callApi(method: string, path: string, body?: unknown): Promise<Response> {
  return await fetch(`${gatewayUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readWork(response: Response): Promise<RunWork> {
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return await response.json() as RunWork;
}

/** Creates the Dataset and its Test Cases. A second run finds them already there. */
async function createDatasetIfMissing(): Promise<void> {
  const responses = [await callApi("POST", "/v1/datasets", { name: datasetName })];
  const testCases = [
    {
      name: "refund-policy",
      input: { message: "What is your refund policy?" },
      evaluators: [{ type: "regex", name: "mentions-30-days", pattern: "30\\s*days", flags: "i" }],
      iterations: 3,
      passThreshold: 0.66,
    },
    {
      name: "stays-polite",
      input: { message: "You are useless." },
      evaluators: [{ type: "regex", name: "no-insults", pattern: "idiot", expectMatch: false }],
    },
  ];
  for (const testCase of testCases) {
    responses.push(
      await callApi("POST", `/v1/datasets/${datasetName}/test-cases`, testCase),
    );
  }
  for (const response of responses) {
    if (!response.ok && response.status !== 409) {
      throw new Error(`${response.status}: ${await response.text()}`);
    }
    await response.body?.cancel();
  }
}

/** Stands in for your application. Replace it with a call to the real thing. */
function callYourApplication(input: { message: string }, correlationId: string): Promise<string> {
  console.log(`  ${correlationId}: ${input.message}`);
  return Promise.resolve("You can return anything within 30 days. How else can I help?");
}

async function runAndDescribe(item: WorkItem) {
  // A retried Iteration gets a new Correlation ID, because its telemetry is new.
  const correlationId = crypto.randomUUID();
  const target = { iterationId: item.iterationId, attempt: item.attempt, correlationId };
  try {
    return { ...target, output: await callYourApplication(item.input, correlationId) };
  } catch (error) {
    return { ...target, error: String(error) };
  }
}

await createDatasetIfMissing();
let work = await readWork(
  await callApi("POST", "/v1/evaluation-runs", { datasetName, executionMode: "client" }),
);
console.log(`Started run ${work.runId}`);
while (work.status === "running") {
  if (work.items.length === 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    work = await readWork(await callApi("GET", `/v1/evaluation-runs/${work.runId}/work`));
    continue;
  }
  const reports = await Promise.all(work.items.map(runAndDescribe));
  work = await readWork(
    await callApi("POST", `/v1/evaluation-runs/${work.runId}/reports`, { reports }),
  );
}
console.log(`Verdict: ${work.verdict}`);
Deno.exit(work.verdict === "passed" ? 0 : 1);

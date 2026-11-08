import { assertEquals } from "@std/assert";
import { createStructuredLogger } from "@extispex/service-runtime";
import { listTestDatabases } from "@extispex/service-storage/testing";
import {
  type EvaluateAttemptJob,
  openEvaluationDatabase,
  openJobQueue,
} from "../src/create-service.ts";
import { JOB_RETRY_LIMIT } from "../src/job-queue/job-queue.ts";

const logger = createStructuredLogger("evaluation-queue-test");

async function waitUntil(condition: () => boolean, timeoutMilliseconds = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the job queue.");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

for (const testDatabase of listTestDatabases("evaluation")) {
  Deno.test({
    name: `delivers jobs and retries a failing one up to its limit (${testDatabase.label})`,
    // pg-boss keeps its connection pool and timers until the process ends.
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      const database = await openEvaluationDatabase(testDatabase.url);
      const jobQueue = await openJobQueue(testDatabase.url, database, logger);
      const iterationPrefix = crypto.randomUUID();
      const deliveries: EvaluateAttemptJob[] = [];
      try {
        await jobQueue.startWorking((job) => {
          if (!job.iterationId.startsWith(iterationPrefix)) return Promise.resolve();
          deliveries.push(job);
          return job.iterationId.endsWith("failing")
            ? Promise.reject(new Error("Expected failure"))
            : Promise.resolve();
        });
        await jobQueue.enqueue([
          { iterationId: `${iterationPrefix}-working`, attemptNumber: 1 },
          { iterationId: `${iterationPrefix}-failing`, attemptNumber: 2 },
        ]);
        const countFailing = () =>
          deliveries.filter((job) => job.iterationId.endsWith("failing")).length;
        await waitUntil(() =>
          countFailing() === JOB_RETRY_LIMIT + 1 &&
          deliveries.some((job) => job.iterationId.endsWith("working"))
        );
        // Long enough for a retry beyond the limit to have shown up.
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
        assertEquals(countFailing(), JOB_RETRY_LIMIT + 1);
        assertEquals(deliveries.filter((job) => job.iterationId.endsWith("working")).length, 1);
      } finally {
        await jobQueue.stop();
        await database.close();
      }
    },
  });
}

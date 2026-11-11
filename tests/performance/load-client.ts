/** Sending requests for the performance run, with an optional deliberate slowdown. */

export interface LoadClient {
  /** `fetch`, after the injected delay. Every request of the run goes through it. */
  send(url: string, init?: RequestInit): Promise<Response>;
  /** Sends JSON and resolves to the JSON answer; rejects unless the status is the expected one. */
  sendJson<ResponseBody>(
    url: string,
    method: string,
    bearerToken: string,
    body?: unknown,
    expectedStatus?: number,
  ): Promise<ResponseBody>;
}

/**
 * The delay stands in for a slower Extispex: it makes every request take longer from the client's
 * side, as a regression in a service would, without a test-only switch in the services.
 */
export function createLoadClient(injectedDelayMilliseconds: number): LoadClient {
  const send = async (url: string, init?: RequestInit) => {
    if (injectedDelayMilliseconds > 0) await sleep(injectedDelayMilliseconds);
    return await fetch(url, init);
  };
  return {
    send,
    async sendJson<ResponseBody>(
      url: string,
      method: string,
      bearerToken: string,
      body?: unknown,
      expectedStatus = 200,
    ) {
      const response = await send(url, {
        method,
        headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const responseText = await response.text();
      if (response.status !== expectedStatus) {
        throw new Error(`${method} ${url} answered ${response.status}: ${responseText}`);
      }
      return (responseText === "" ? null : JSON.parse(responseText)) as ResponseBody;
    },
  };
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

/** The value below which the given fraction of the values lie, by the nearest-rank method. */
export function computePercentile(values: number[], fraction: number): number {
  if (values.length === 0) throw new Error("No values to take a percentile of.");
  const sortedValues = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sortedValues.length);
  return sortedValues[Math.min(sortedValues.length, Math.max(1, rank)) - 1];
}

/** Runs one task per sender at once and resolves once all of them finished. */
export async function runSenders(
  senderCount: number,
  runSender: (senderIndex: number) => Promise<void>,
): Promise<void> {
  await Promise.all(
    Array.from({ length: senderCount }, (_, senderIndex) => runSender(senderIndex)),
  );
}

export function randomHex(byteCount: number): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(byteCount)),
    (byteValue) => byteValue.toString(16).padStart(2, "0"),
  ).join("");
}

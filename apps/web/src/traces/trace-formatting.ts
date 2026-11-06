const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

export function formatDuration(durationMilliseconds: number): string {
  if (durationMilliseconds < 1) {
    return `${(durationMilliseconds * 1000).toFixed(0)} µs`;
  }
  if (durationMilliseconds < 1000) {
    return `${durationMilliseconds.toFixed(durationMilliseconds < 10 ? 2 : 0)} ms`;
  }
  return `${(durationMilliseconds / 1000).toFixed(2)} s`;
}

export function formatUnixNanoseconds(unixNanoseconds: string): string {
  const unixMilliseconds = Number(BigInt(unixNanoseconds) / NANOSECONDS_PER_MILLISECOND);
  return new Date(unixMilliseconds).toLocaleString();
}

/** Milliseconds between two Unix nanosecond timestamps, keeping sub-millisecond precision. */
export function millisecondsBetween(
  earlierUnixNanoseconds: string,
  laterUnixNanoseconds: string,
): number {
  const differenceNanoseconds = BigInt(laterUnixNanoseconds) - BigInt(earlierUnixNanoseconds);
  return Number(differenceNanoseconds) / Number(NANOSECONDS_PER_MILLISECOND);
}

export function formatAttributeValue(attributeValue: unknown): string {
  return typeof attributeValue === "string" ? attributeValue : JSON.stringify(attributeValue);
}

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

export function formatDuration(durationMilliseconds: number): string {
  if (durationMilliseconds < 1) {
    return `${(durationMilliseconds * 1000).toFixed(0)} µs`;
  }
  if (durationMilliseconds < 1000) {
    return `${durationMilliseconds.toFixed(durationMilliseconds < 10 ? 2 : 0)} ms`;
  }
  if (durationMilliseconds < 60_000) {
    return `${(durationMilliseconds / 1000).toFixed(2)} s`;
  }
  const totalSeconds = Math.round(durationMilliseconds / 1000);
  return `${Math.floor(totalSeconds / 60)} min ${totalSeconds % 60} s`;
}

export function unixNanosecondsToMilliseconds(unixNanoseconds: string): number {
  return Number(BigInt(unixNanoseconds) / NANOSECONDS_PER_MILLISECOND);
}

/** A full local date and time with milliseconds, for tooltips and detail headers. */
export function formatUnixNanoseconds(unixNanoseconds: string): string {
  const timestamp = new Date(unixNanosecondsToMilliseconds(unixNanoseconds));
  const datePart = timestamp.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const timePart = timestamp.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const milliseconds = String(timestamp.getMilliseconds()).padStart(3, "0");
  return `${datePart}, ${timePart}.${milliseconds}`;
}

const RELATIVE_TIME_STEPS: [limitSeconds: number, unitSeconds: number, unitLabel: string][] = [
  [60, 1, "s"],
  [3600, 60, "min"],
  [86_400, 3600, "h"],
  [7 * 86_400, 86_400, "d"],
];

/** A short "how long ago" label such as "5 min ago". Older than a week shows the date. */
export function formatRelativeTime(unixMilliseconds: number, nowUnixMilliseconds: number): string {
  const elapsedSeconds = Math.max(0, (nowUnixMilliseconds - unixMilliseconds) / 1000);
  if (elapsedSeconds < 5) {
    return "just now";
  }
  for (const [limitSeconds, unitSeconds, unitLabel] of RELATIVE_TIME_STEPS) {
    if (elapsedSeconds < limitSeconds) {
      return `${Math.floor(elapsedSeconds / unitSeconds)} ${unitLabel} ago`;
    }
  }
  return new Date(unixMilliseconds).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Milliseconds between two Unix nanosecond timestamps, keeping sub-millisecond precision. */
export function millisecondsBetween(
  earlierUnixNanoseconds: string,
  laterUnixNanoseconds: string,
): number {
  const differenceNanoseconds = BigInt(laterUnixNanoseconds) - BigInt(earlierUnixNanoseconds);
  return Number(differenceNanoseconds) / Number(NANOSECONDS_PER_MILLISECOND);
}

export interface TimeAxisTick {
  offsetPercent: number;
  label: string;
}

/** Evenly spaced labels for a waterfall's time axis, from the trace start to its end. */
export function buildTimeAxisTicks(
  traceDurationMilliseconds: number,
  intervalCount = 4,
): TimeAxisTick[] {
  return Array.from({ length: intervalCount + 1 }, (_, tickIndex) => {
    const fraction = tickIndex / intervalCount;
    return {
      offsetPercent: fraction * 100,
      label: tickIndex === 0 ? "0" : formatDuration(traceDurationMilliseconds * fraction),
    };
  });
}

/** The leading characters of a long identifier, enough to tell traces apart at a glance. */
export function shortenIdentifier(identifier: string, visibleLength = 8): string {
  return identifier.length <= visibleLength + 1
    ? identifier
    : `${identifier.slice(0, visibleLength)}…`;
}

export function formatAttributeValue(attributeValue: unknown): string {
  return typeof attributeValue === "string" ? attributeValue : JSON.stringify(attributeValue);
}

/**
 * Structured values, including strings that hold JSON such as GenAI messages, as indented JSON.
 * Returns null for values that read best on one line.
 */
export function formatStructuredAttributeValue(attributeValue: unknown): string | null {
  if (attributeValue !== null && typeof attributeValue === "object") {
    return JSON.stringify(attributeValue, null, 2);
  }
  if (typeof attributeValue === "string" && /^\s*[[{]/.test(attributeValue)) {
    try {
      return JSON.stringify(JSON.parse(attributeValue), null, 2);
    } catch {
      return null;
    }
  }
  return null;
}

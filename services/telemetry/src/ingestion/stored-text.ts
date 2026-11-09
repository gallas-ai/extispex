/**
 * Text and JSON that both databases can store. PostgreSQL refuses U+0000 and JSON escapes of lone
 * surrogates, and one such value would otherwise fail its whole batch on every retry.
 */
export function makeTextStorable(text: string): string {
  return text.replaceAll("\u0000", "").toWellFormed();
}

export function makeValueStorable(value: unknown): unknown {
  if (typeof value === "string") return makeTextStorable(value);
  if (Array.isArray(value)) return value.map(makeValueStorable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        makeTextStorable(key),
        makeValueStorable(nestedValue),
      ]),
    );
  }
  return value;
}

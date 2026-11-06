export class InvalidConfigurationError extends Error {
  override name = "InvalidConfigurationError";
}

export function readOptionalEnvironmentVariable(variableName: string): string | undefined {
  const variableValue = Deno.env.get(variableName)?.trim();
  return variableValue ? variableValue : undefined;
}

export function readRequiredEnvironmentVariable(variableName: string): string {
  const variableValue = readOptionalEnvironmentVariable(variableName);
  if (variableValue === undefined) {
    throw new InvalidConfigurationError(`Environment variable ${variableName} is required.`);
  }
  return variableValue;
}

export function readPortEnvironmentVariable(variableName: string, defaultPort: number): number {
  const variableValue = readOptionalEnvironmentVariable(variableName);
  if (variableValue === undefined) {
    return defaultPort;
  }
  const port = Number(variableValue);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidConfigurationError(
      `Environment variable ${variableName} must be a port number, got "${variableValue}".`,
    );
  }
  return port;
}

/** Parses `first-key=first-value,second-key=second-value` into a map. */
export function parseKeyValueList(listText: string, variableName: string): Map<string, string> {
  const parsedEntries = new Map<string, string>();
  for (const entryText of listText.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const separatorIndex = entryText.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === entryText.length - 1) {
      throw new InvalidConfigurationError(
        `Environment variable ${variableName} must contain key=value pairs separated by commas.`,
      );
    }
    parsedEntries.set(entryText.slice(0, separatorIndex), entryText.slice(separatorIndex + 1));
  }
  return parsedEntries;
}

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

/** Reads a secret such as a key, which must be long enough not to be guessed. */
export function readSecretEnvironmentVariable(
  variableName: string,
  minimumLength: number,
): string | undefined {
  const variableValue = readOptionalEnvironmentVariable(variableName);
  if (variableValue !== undefined && variableValue.length < minimumLength) {
    throw new InvalidConfigurationError(
      `Environment variable ${variableName} must be at least ${minimumLength} characters long.`,
    );
  }
  return variableValue;
}

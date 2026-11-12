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

export function readPositiveIntegerEnvironmentVariable(
  variableName: string,
  defaultValue: number,
): number {
  const variableValue = readOptionalEnvironmentVariable(variableName);
  if (variableValue === undefined) return defaultValue;
  const parsedValue = Number(variableValue);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new InvalidConfigurationError(
      `Environment variable ${variableName} must be a positive whole number, got "${variableValue}".`,
    );
  }
  return parsedValue;
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

/**
 * How many reverse proxies stand in front of the Gateway, from `GATEWAY_TRUSTED_PROXY_COUNT`. Each
 * appends the address it saw to `X-Forwarded-For`, so this many entries from the right are real
 * and anything further left could be written by the client.
 */
export function readTrustedProxyCount(): number {
  const configuredValue = readOptionalEnvironmentVariable("GATEWAY_TRUSTED_PROXY_COUNT");
  if (configuredValue === undefined) return 0;
  const proxyCount = Number(configuredValue);
  if (!Number.isInteger(proxyCount) || proxyCount < 0) {
    throw new InvalidConfigurationError(
      `GATEWAY_TRUSTED_PROXY_COUNT must be a whole number, got "${configuredValue}".`,
    );
  }
  return proxyCount;
}

/**
 * `DATABASE_MIGRATIONS`: `apply` (the default) applies pending migrations when the service starts;
 * `check` makes it refuse to start while a migration is pending, because a separate `migrate`
 * command applies them, as the Helm chart's migration Job does.
 */
export function readDatabaseMigrationMode(): "apply" | "check" {
  const configuredValue = readOptionalEnvironmentVariable("DATABASE_MIGRATIONS") ?? "apply";
  if (configuredValue !== "apply" && configuredValue !== "check") {
    throw new InvalidConfigurationError(
      `DATABASE_MIGRATIONS must be "apply" or "check", got "${configuredValue}".`,
    );
  }
  return configuredValue;
}

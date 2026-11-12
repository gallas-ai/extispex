import { InvalidConfigurationError } from "@extispex/service-runtime";
import { MINIMUM_CONFIGURED_KEY_LENGTH } from "../api-keys/mod.ts";

const CLIENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * Reads `SERVICE_CLIENTS`: comma-separated `<client ID>:<secret>` pairs, such as
 * `telemetry:…,prompt:…`. Each secret needs at least 32 characters.
 */
export function parseServiceClients(configuredValue: string | undefined): Map<string, string> {
  const serviceClientSecrets = new Map<string, string>();
  for (const entry of (configuredValue ?? "").split(",")) {
    if (entry.trim() === "") continue;
    const separatorIndex = entry.indexOf(":");
    const clientId = entry.slice(0, Math.max(separatorIndex, 0)).trim();
    const clientSecret = entry.slice(separatorIndex + 1).trim();
    if (separatorIndex < 0 || !CLIENT_ID_PATTERN.test(clientId)) {
      throw new InvalidConfigurationError(
        "SERVICE_CLIENTS must list <client ID>:<secret> pairs separated by commas, with client " +
          "IDs of lowercase letters, digits and hyphens.",
      );
    }
    if (clientSecret.length < MINIMUM_CONFIGURED_KEY_LENGTH) {
      throw new InvalidConfigurationError(
        `The secret of ${clientId} in SERVICE_CLIENTS must be at least ` +
          `${MINIMUM_CONFIGURED_KEY_LENGTH} characters long.`,
      );
    }
    serviceClientSecrets.set(clientId, clientSecret);
  }
  return serviceClientSecrets;
}

const API_KEY_STORAGE_KEY = "evaluation-telemetry.api-key";

/** Browser storage can be unavailable, for example in private windows, so failures are ignored. */
export function readStoredApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeApiKey(apiKey: string): void {
  try {
    localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
  } catch {
    // The key then lasts only for this page load.
  }
}

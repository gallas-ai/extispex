const API_KEY_STORAGE_KEY = "extispex.api-key";
const INSTANCE_ADMIN_KEY_STORAGE_KEY = "extispex.instance-admin-key";

/** The prefix of the Instance admin keys that Extispex generates, never used for Project keys. */
export const INSTANCE_ADMIN_KEY_PREFIX = "extispex_admin_";

/** The Project API key, which decides the Project that Traces and Prompts show. */
export function readStoredApiKey(): string {
  return readStoredValue(API_KEY_STORAGE_KEY);
}

export function storeApiKey(apiKey: string): void {
  storeValue(API_KEY_STORAGE_KEY, apiKey);
}

/** The Instance admin key, which manages Projects and API keys but reads no Project's data. */
export function readStoredInstanceAdminKey(): string {
  return readStoredValue(INSTANCE_ADMIN_KEY_STORAGE_KEY);
}

export function storeInstanceAdminKey(instanceAdminKey: string): void {
  storeValue(INSTANCE_ADMIN_KEY_STORAGE_KEY, instanceAdminKey);
}

/** Browser storage can be unavailable, for example in private windows, so failures are ignored. */
function readStoredValue(storageKey: string): string {
  try {
    return localStorage.getItem(storageKey) ?? "";
  } catch {
    return "";
  }
}

function storeValue(storageKey: string, storedValue: string): void {
  try {
    if (storedValue === "") {
      localStorage.removeItem(storageKey);
    } else {
      localStorage.setItem(storageKey, storedValue);
    }
  } catch {
    // The value then lasts only for this page load.
  }
}

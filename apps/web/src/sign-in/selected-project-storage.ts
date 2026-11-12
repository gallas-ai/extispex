const SELECTED_PROJECT_STORAGE_KEY = "extispex.selected-project";

/** The Project the browser showed last; browser storage can be unavailable, so failures are ignored. */
export function readStoredProjectId(): string | null {
  try {
    return localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeProjectId(projectId: string): void {
  try {
    localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, projectId);
  } catch {
    // The choice then lasts only for this page load.
  }
}

/** The Project that a link names with `?project=`, such as a link in a Report. */
export function readLinkedProjectId(): string | null {
  return new URLSearchParams(globalThis.location?.search ?? "").get("project");
}

/** `system` follows the operating system's light or dark setting. */
export type ThemePreference = "system" | "light" | "dark";

// index.html reads the same key before the app loads, so the page does not flash the wrong theme.
const THEME_STORAGE_KEY = "extispex.theme";

export function readStoredThemePreference(): ThemePreference {
  try {
    const storedPreference = localStorage.getItem(THEME_STORAGE_KEY);
    return storedPreference === "light" || storedPreference === "dark"
      ? storedPreference
      : "system";
  } catch {
    return "system";
  }
}

export function storeThemePreference(themePreference: ThemePreference): void {
  try {
    if (themePreference === "system") {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    }
  } catch {
    // The choice then lasts only for this page load.
  }
}

export function applyThemePreference(themePreference: ThemePreference): void {
  if (themePreference === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = themePreference;
  }
}

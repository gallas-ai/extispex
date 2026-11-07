import { useState } from "react";
import { MonitorIcon, MoonIcon, SunIcon } from "../ui/icons.tsx";
import {
  applyThemePreference,
  readStoredThemePreference,
  storeThemePreference,
  type ThemePreference,
} from "./theme-preference.ts";

const THEME_OPTIONS: { preference: ThemePreference; label: string; Icon: typeof SunIcon }[] = [
  { preference: "light", label: "Light theme", Icon: SunIcon },
  { preference: "system", label: "System theme", Icon: MonitorIcon },
  { preference: "dark", label: "Dark theme", Icon: MoonIcon },
];

export function ThemeSwitcher() {
  const [themePreference, setThemePreference] = useState(readStoredThemePreference);

  const chooseTheme = (nextPreference: ThemePreference) => {
    setThemePreference(nextPreference);
    storeThemePreference(nextPreference);
    applyThemePreference(nextPreference);
  };

  return (
    <div className="segmented-control" role="radiogroup" aria-label="Theme">
      {THEME_OPTIONS.map(({ preference, label, Icon }) => (
        <button
          key={preference}
          type="button"
          role="radio"
          aria-checked={themePreference === preference}
          aria-label={label}
          title={label}
          className="segmented-control-option"
          onClick={() => chooseTheme(preference)}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}

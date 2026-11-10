import { useEffect, useState } from "react";

/** The categorical slots: assigned in this order and never cycled, see `styles.css`. */
export const CHART_SERIES_SLOT_COUNT = 8;

export interface ChartTheme {
  seriesColors: string[];
  text: string;
  mutedText: string;
  gridLine: string;
  border: string;
  surface: string;
  /** The page's font, which the chart needs by name to measure its labels correctly. */
  fontFamily: string;
}

function readChartTheme(): ChartTheme {
  const styles = getComputedStyle(document.documentElement);
  const readToken = (token: string) => styles.getPropertyValue(token).trim();
  return {
    seriesColors: Array.from(
      { length: CHART_SERIES_SLOT_COUNT },
      (_slot, slotIndex) => readToken(`--chart-series-${slotIndex + 1}`),
    ),
    text: readToken("--color-text"),
    mutedText: readToken("--color-text-muted"),
    gridLine: readToken("--color-grid-line"),
    border: readToken("--color-border"),
    surface: readToken("--color-surface"),
    fontFamily: getComputedStyle(document.body).fontFamily,
  };
}

/**
 * The chart's colors from the page's tokens. A canvas cannot use CSS variables, so the colors are
 * read again when the theme changes, by the switcher or by the operating system.
 */
export function useChartTheme(): ChartTheme {
  const [chartTheme, setChartTheme] = useState(readChartTheme);
  useEffect(() => {
    const refreshTheme = () => setChartTheme(readChartTheme());
    const themeObserver = new MutationObserver(refreshTheme);
    themeObserver.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    const darkScheme = matchMedia("(prefers-color-scheme: dark)");
    darkScheme.addEventListener("change", refreshTheme);
    return () => {
      themeObserver.disconnect();
      darkScheme.removeEventListener("change", refreshTheme);
    };
  }, []);
  return chartTheme;
}

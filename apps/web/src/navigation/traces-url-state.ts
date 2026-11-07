import { useCallback, useEffect, useState } from "react";

/**
 * What the Traces page shows, kept in the query string so that a view can be shared as a link
 * and the browser's Back button closes a trace.
 */
export interface TracesUrlState {
  correlationId: string;
  sessionId: string;
  traceId: string | null;
  spanId: string | null;
}

const QUERY_PARAMETER_BY_FIELD: Record<keyof TracesUrlState, string> = {
  correlationId: "correlationId",
  sessionId: "sessionId",
  traceId: "traceId",
  spanId: "spanId",
};

export function parseTracesUrlState(search: string): TracesUrlState {
  const searchParameters = new URLSearchParams(search);
  return {
    correlationId: searchParameters.get(QUERY_PARAMETER_BY_FIELD.correlationId) ?? "",
    sessionId: searchParameters.get(QUERY_PARAMETER_BY_FIELD.sessionId) ?? "",
    traceId: searchParameters.get(QUERY_PARAMETER_BY_FIELD.traceId) || null,
    spanId: searchParameters.get(QUERY_PARAMETER_BY_FIELD.spanId) || null,
  };
}

export function serializeTracesUrlState(urlState: TracesUrlState): string {
  const searchParameters = new URLSearchParams();
  for (const [field, queryParameter] of Object.entries(QUERY_PARAMETER_BY_FIELD)) {
    const fieldValue = urlState[field as keyof TracesUrlState];
    if (fieldValue) {
      searchParameters.set(queryParameter, fieldValue);
    }
  }
  const serialized = searchParameters.toString();
  return serialized === "" ? "" : `?${serialized}`;
}

/** `push` adds a history entry the user can go Back from; `replace` does not. */
export type HistoryMode = "push" | "replace";

export function useTracesUrlState(): [
  TracesUrlState,
  (changes: Partial<TracesUrlState>, historyMode: HistoryMode) => void,
] {
  const [urlState, setUrlState] = useState(() => parseTracesUrlState(globalThis.location.search));

  useEffect(() => {
    const followBrowserNavigation = () =>
      setUrlState(parseTracesUrlState(globalThis.location.search));
    globalThis.addEventListener("popstate", followBrowserNavigation);
    return () => globalThis.removeEventListener("popstate", followBrowserNavigation);
  }, []);

  const updateUrlState = useCallback(
    (changes: Partial<TracesUrlState>, historyMode: HistoryMode) => {
      // The location is the source of truth, so several updates in one event compose correctly.
      const nextState = { ...parseTracesUrlState(globalThis.location.search), ...changes };
      const nextUrl = `${globalThis.location.pathname}${serializeTracesUrlState(nextState)}`;
      if (historyMode === "push") {
        globalThis.history.pushState(null, "", nextUrl);
      } else {
        globalThis.history.replaceState(null, "", nextUrl);
      }
      setUrlState(nextState);
    },
    [],
  );

  return [urlState, updateUrlState];
}

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, isSignInRequired } from "../api/api-request.ts";

export type ApiResourceState<Resource> =
  | { status: "loading" }
  | { status: "loaded"; resource: Resource }
  | { status: "failed"; message: string; statusCode: number | null; isSignInRequired: boolean };

/**
 * Loads one resource from the API whenever `loadResource` changes, so pass a memoized function.
 * A response that arrives after a newer request started is ignored. `reload` keeps showing the
 * current resource until the new one arrives, so that a page does not flash after a change.
 */
export function useApiResource<Resource>(
  loadResource: () => Promise<Resource>,
): [ApiResourceState<Resource>, () => void] {
  const [resourceState, setResourceState] = useState<ApiResourceState<Resource>>({
    status: "loading",
  });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const isReloadingRef = useRef(false);

  useEffect(() => {
    let isCurrentRequest = true;
    if (!isReloadingRef.current) setResourceState({ status: "loading" });
    isReloadingRef.current = false;
    loadResource()
      .then((resource) => {
        if (isCurrentRequest) setResourceState({ status: "loaded", resource });
      })
      .catch((error: Error) => {
        if (!isCurrentRequest) return;
        setResourceState({
          status: "failed",
          message: error.message,
          statusCode: error instanceof ApiError ? error.statusCode : null,
          isSignInRequired: isSignInRequired(error),
        });
      });
    return () => {
      isCurrentRequest = false;
    };
  }, [loadResource, loadAttempt]);

  const reload = useCallback(() => {
    isReloadingRef.current = true;
    setLoadAttempt((attempt) => attempt + 1);
  }, []);
  return [resourceState, reload];
}

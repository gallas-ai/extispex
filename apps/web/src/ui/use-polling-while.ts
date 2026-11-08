import { useEffect } from "react";

const POLLING_INTERVAL_MILLISECONDS = 2_000;

/** Calls `reload` every two seconds while the condition holds. */
export function usePollingWhile(shouldPoll: boolean, reload: () => void): void {
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = setInterval(reload, POLLING_INTERVAL_MILLISECONDS);
    return () => clearInterval(timer);
  }, [shouldPoll, reload]);
}

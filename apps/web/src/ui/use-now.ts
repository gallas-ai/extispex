import { useEffect, useState } from "react";

/** The current time, refreshed on an interval so that "5 min ago" labels stay true. */
export function useNow(refreshIntervalMilliseconds: number): number {
  const [nowUnixMilliseconds, setNowUnixMilliseconds] = useState(Date.now);
  useEffect(() => {
    const refreshTimer = setInterval(
      () => setNowUnixMilliseconds(Date.now()),
      refreshIntervalMilliseconds,
    );
    return () => clearInterval(refreshTimer);
  }, [refreshIntervalMilliseconds]);
  return nowUnixMilliseconds;
}

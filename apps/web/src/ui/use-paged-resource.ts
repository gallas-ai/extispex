import { useCallback, useEffect, useRef, useState } from "react";
import { isSignInRequired } from "../api/api-request.ts";

export interface ResourcePage<Item, Cursor = number> {
  items: Item[];
  nextCursor: Cursor | null;
}

export type PagedResourceState<Item> =
  | { status: "loading" }
  | { status: "failed"; message: string; isSignInRequired: boolean }
  | { status: "loaded"; items: Item[]; hasMore: boolean; isLoadingMore: boolean };

/**
 * Reads a list page by page. When `refreshKey` changes, the pages shown so far are read again, so
 * that results still arriving appear without losing what the user has opened. Pass a memoized
 * `loadPage`.
 */
export function usePagedResource<Item, Cursor = number>(
  loadPage: (cursor: Cursor | null) => Promise<ResourcePage<Item, Cursor>>,
  refreshKey: string,
): { state: PagedResourceState<Item>; loadMore: () => void; retry: () => void } {
  const [state, setState] = useState<PagedResourceState<Item>>({ status: "loading" });
  const [retryCount, setRetryCount] = useState(0);
  const pageCountRef = useRef(1);
  const nextCursorRef = useRef<Cursor | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    (async () => {
      try {
        const items: Item[] = [];
        let cursor: Cursor | null = null;
        for (let pageIndex = 0; pageIndex < pageCountRef.current; pageIndex++) {
          const page: ResourcePage<Item, Cursor> = await loadPage(cursor);
          items.push(...page.items);
          cursor = page.nextCursor;
          if (cursor === null) break;
        }
        if (requestId !== requestIdRef.current) return;
        nextCursorRef.current = cursor;
        setState({ status: "loaded", items, hasMore: cursor !== null, isLoadingMore: false });
      } catch (error) {
        if (requestId === requestIdRef.current) {
          setState({
            status: "failed",
            message: (error as Error).message,
            isSignInRequired: isSignInRequired(error),
          });
        }
      }
    })();
  }, [loadPage, refreshKey, retryCount]);

  const loadMore = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setState((current) =>
      current.status === "loaded" ? { ...current, isLoadingMore: true } : current
    );
    try {
      const page = await loadPage(nextCursorRef.current);
      if (requestId !== requestIdRef.current) return;
      pageCountRef.current++;
      nextCursorRef.current = page.nextCursor;
      setState((current) =>
        current.status === "loaded"
          ? {
            status: "loaded",
            items: [...current.items, ...page.items],
            hasMore: page.nextCursor !== null,
            isLoadingMore: false,
          }
          : current
      );
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setState({
          status: "failed",
          message: (error as Error).message,
          isSignInRequired: isSignInRequired(error),
        });
      }
    }
  }, [loadPage]);

  const retry = useCallback(() => setRetryCount((count) => count + 1), []);
  return { state, loadMore, retry };
}

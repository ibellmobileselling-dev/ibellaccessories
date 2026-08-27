import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Rows per page, as chosen once and then remembered.
 *
 * 500 by default: this shop runs 1,400 items and 41 parties, and 50 rows a
 * page meant paging through a list to find something that a search would have
 * found — or worse, believing a total was wrong because the rest of it was on
 * page 3. A shopkeeper who wants fewer can say so, once.
 */
export const DEFAULT_PAGE_SIZE = 500;

const STORE_PREFIX = "bz.pageSize.";

function readSaved(key: string | undefined, fallback: number): number {
  if (!key || typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(STORE_PREFIX + key);
    const n = raw == null ? NaN : Number(raw);
    // Anything unparseable or absurd falls back rather than rendering a
    // blank page or trying to draw a million rows.
    return Number.isFinite(n) && n > 0 && n <= 5000 ? n : fallback;
  } catch {
    return fallback;
  }
}

/** Client-side pagination over an already-filtered row array.
 *
 * A hook, so it lives in hooks/ rather than beside the PaginationBar
 * component — a module that exports both a component and a hook breaks
 * React Fast Refresh for every screen that imports it.
 *
 * `key` names the screen. Give the SAME key to a screen's table and to its
 * phone card list, so changing the size on one is not undone by the other,
 * and so the choice survives a reload — it is a preference about how someone
 * likes to work, not a detail of one visit.
 */
export function usePagination<T>(rows: T[], key?: string, initialSize = DEFAULT_PAGE_SIZE) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(() => readSaved(key, initialSize));

  // Follow the saved value when the key changes (one component, two screens).
  useEffect(() => {
    setPageSizeState(readSaved(key, initialSize));
  }, [key, initialSize]);

  const setPageSize = useCallback(
    (n: number) => {
      setPageSizeState(n);
      setPage(1);
      if (!key || typeof window === "undefined") return;
      try {
        window.localStorage.setItem(STORE_PREFIX + key, String(n));
      } catch {
        // Private browsing blocks localStorage — the size just won't be
        // remembered, which is not worth failing the click over.
      }
    },
    [key],
  );

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);

  // Back to page 1 whenever the underlying list changes size (filter/search/add/delete)
  useEffect(() => {
    setPage(1);
  }, [total]);

  const paged = useMemo(
    () => rows.slice((safePage - 1) * pageSize, safePage * pageSize),
    [rows, safePage, pageSize],
  );

  return { paged, page: safePage, setPage, pageSize, setPageSize, totalPages, total };
}

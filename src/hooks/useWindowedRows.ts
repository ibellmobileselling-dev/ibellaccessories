import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Render only the rows currently on screen.
 *
 * The bulk-update grid has to show the WHOLE catalogue with no paging, but
 * every row carries several live inputs — mounting 1,400 of them was ~5,800
 * DOM controls and froze the screen on open. Paging fixed the freeze at the
 * cost of hiding the list behind page buttons.
 *
 * Windowing gives both: the scrollbar spans every row (spacers above and
 * below stand in for the ones not mounted), while only the visible slice
 * plus a small overscan actually exists in the DOM. Scrolling to item 1,400
 * works; the browser only ever holds ~30 rows.
 *
 * Rows must be a uniform `rowHeight` for the arithmetic to hold — which is
 * true of a grid, and is why this isn't a general-purpose list virtualiser.
 */
export function useWindowedRows(total: number, rowHeight: number, overscan = 8) {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: Math.min(total, 40) });
  const frame = useRef(0);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const first = Math.floor(el.scrollTop / rowHeight);
    const visible = Math.ceil(el.clientHeight / rowHeight);
    const start = Math.max(0, first - overscan);
    const end = Math.min(total, first + visible + overscan);
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [rowHeight, overscan, total]);

  const onScroll = useCallback(() => {
    // Coalesce to one measurement per frame — a scroll fires far faster than
    // React can usefully re-render, and re-rendering per event is what makes
    // a long list feel like it is dragging.
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      measure();
    });
  }, [measure]);

  // Re-measure when the row count changes (searching, filtering) or the
  // container resizes, so the window never lags behind the content.
  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, total]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const start = Math.min(range.start, Math.max(0, total - 1));
  const end = Math.min(range.end, total);
  return {
    ref,
    onScroll,
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (total - end) * rowHeight),
  };
}

import { useCallback, useEffect, useState } from "react";

/**
 * Scales a fixed-pixel-width print preview (A4, thermal receipt, etc.) down
 * to fit whatever width it's actually given — instead of forcing the phone
 * to pan/scroll sideways to see a business document, which reads as broken
 * (content flush against one edge, dead space on the other) rather than
 * "just zoomed out to fit" like any native app's document preview.
 *
 * Never scales up past 1 — desktop viewers with room to spare see the
 * preview at its true native size, unaffected.
 *
 * IMPORTANT: apply the transform (and the `preview-fit-scale` class that
 * neutralizes it under print) directly to the printable ref element itself,
 * not to a wrapper around it. `elementToPdfBlob`/`downloadElementAsPdf` build
 * the PDF from `printRef.current.outerHTML` — only that element and its
 * descendants are ever serialized, so a class living on some parent wrapper
 * would never reach the Puppeteer-rendered copy at all. Putting the class on
 * the ref itself works for both paths: styles.css forces it back to
 * `transform: none !important; width: auto !important;` under `@media
 * print`, which Puppeteer matches too (pdfServer.ts calls
 * `page.emulateMediaType("print")`), and native `window.print()` matches it
 * directly on the live DOM. A separate, untransformed sizing wrapper (native
 * size × scale, no class needed) should sit *around* the ref element purely
 * to reserve the correct shrunk layout footprint — CSS transforms don't
 * affect normal-flow layout size, only paint, so without that wrapper the
 * scaled-down element would still occupy its full native box and leave the
 * same dead space this hook exists to remove.
 */
export function useFitScale(nativeWidthPx: number) {
  // A plain useRef doesn't notify this hook when the DOM node actually shows
  // up — on pages like the invoice detail view, the container only renders
  // once its data has loaded (an earlier "not found while loading" render
  // returns different JSX with no ref'd element at all), so the very first
  // time this effect ran, the ref was still null and it bailed out without
  // ever creating a ResizeObserver. Since nativeWidthPx hadn't changed
  // between that render and the one where the real container finally
  // mounted, the effect never got a reason to re-run and re-attach — scale
  // stayed stuck at its default of 1 (unshrunk / "zoomed in") until
  // switching format changed nativeWidthPx and forced a re-run. A callback
  // ref fixes this at the root: it fires the instant the node mounts,
  // independent of any other dependency.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback((el: HTMLDivElement | null) => setNode(el), []);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    if (!node) return;
    const measure = () => {
      const available = node.clientWidth;
      setScale(available > 0 ? Math.min(1, available / nativeWidthPx) : 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [node, nativeWidthPx]);

  return { containerRef, scale };
}

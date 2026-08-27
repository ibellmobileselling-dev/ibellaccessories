import * as React from "react";

const MOBILE_BREAKPOINT = 768;

/** Returns `undefined` until the real viewport width is known (SSR has no
 * window, so this can't be determined synchronously on first render) — this
 * is distinct from `false`, and callers that gate a one-time effect (like
 * autofocusing a search box only on desktop) must treat "not yet known" as
 * "not confirmed desktop" rather than coercing it to `false`/"not mobile".
 * Doing that coercion here previously made every consumer's `!isMobile`
 * check true on the very first render on EVERY device, mobile included,
 * which is exactly backwards for anything gated on being confirmed desktop. */
export function useIsMobile(): boolean | undefined {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}

/** Focuses `ref`'s element once confirmed desktop (never on mobile, and
 * never during the brief "not yet known" window on any device — see
 * useIsMobile's note on why coercing that window to `false` is unsafe here).
 * Plain JSX `autoFocus` can't do this correctly itself: it only applies once,
 * at the moment React first creates the DOM node, so by the time isMobile
 * resolves to its real value the element has already mounted with whatever
 * (possibly wrong) value autoFocus happened to have on that first render. */
export function useAutoFocusOnDesktop(ref: React.RefObject<HTMLInputElement | null>) {
  const isMobile = useIsMobile();
  React.useEffect(() => {
    if (isMobile === false) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);
}

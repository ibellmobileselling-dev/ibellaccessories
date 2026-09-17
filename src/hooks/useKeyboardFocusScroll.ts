import { useEffect } from "react";

/**
 * Keep whatever the keyboard just moved to actually on screen.
 *
 * The shop works this app from a MacBook with no mouse — Tab, Space, Enter,
 * and nothing else. On a 13" screen that runs out of room quickly: tabbing
 * into a field below the fold moves the cursor somewhere invisible, and the
 * next thing typed lands in a box nobody can see. Browsers scroll for a
 * focused element only in some cases and not reliably inside a nested
 * scrolling pane, which is what every list page here uses.
 *
 * Two deliberate limits:
 *
 *   Only after a KEY. A click already puts the thing under the pointer, and
 *   scrolling on click yanks the page out from under the hand that clicked —
 *   the single most disorienting thing a page can do.
 *
 *   `block: "nearest"`, which does nothing at all when the element is
 *   already visible and otherwise moves the least it can. Anything stronger
 *   re-centres the page on every Tab, which reads as the form jumping about.
 */
export function useKeyboardFocusScroll() {
  useEffect(() => {
    /** Was the focus change driven by the keyboard rather than a pointer? */
    let byKeyboard = false;

    const onKeyDown = (e: KeyboardEvent) => {
      // The keys that MOVE focus. A plain letter does not, and treating it as
      // if it did would scroll while somebody is mid-word.
      if (e.key === "Tab" || e.key === "Enter" || e.key.startsWith("Arrow")) {
        byKeyboard = true;
      }
    };
    const onPointer = () => {
      byKeyboard = false;
    };

    const onFocusIn = (e: FocusEvent) => {
      if (!byKeyboard) return;
      byKeyboard = false;
      const el = e.target as HTMLElement | null;
      if (!el || typeof el.scrollIntoView !== "function") return;
      // The document body focusing (e.g. after a dialog closes) is not a
      // place anybody needs scrolled into view.
      if (el === document.body || el === document.documentElement) return;
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    };

    // Capture, so a component that stops propagation on its own keys still
    // lets this see them.
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onPointer, true);
    document.addEventListener("touchstart", onPointer, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onPointer, true);
      document.removeEventListener("touchstart", onPointer, true);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, []);
}

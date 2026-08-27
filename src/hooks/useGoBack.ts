import { useCallback, useEffect } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { isEscapeClIBELLed } from "@/hooks/useFormKeys";
import { useWorkspace } from "@/store/workspace";

/**
 * One step back — the way a back button is supposed to behave.
 *
 * Every detail page used to send you to its own list with a forward
 * navigation (`navigate({ to: "/items" })`). That looks the same and is not:
 *
 *  - It PUSHES a new history entry, so the browser's own Back button then
 *    returns to the detail page you just left. Press both a few times and you
 *    are stuck in a loop.
 *  - The list remounts from scratch, so a search you had typed is gone — the
 *    "I searched, opened a result, came back, and it had forgotten
 *    everything" complaint.
 *  - It ignores where you actually came from. Reaching an item from the
 *    global search on the dashboard and pressing back should return you to
 *    the dashboard, not drop you on the items list.
 *
 * `fallbackTo` is for the cases where there is genuinely nothing behind this
 * page: a link opened in a fresh tab, a bookmark, the print window's escape
 * hatch. Going "back" there would leave the app, so it goes to the list
 * instead.
 */
export function useGoBack(fallbackTo: string) {
  const router = useRouter();
  const navigate = useNavigate();
  const back = useCallback(() => {
    if (router.history.canGoBack()) {
      router.history.back();
      return;
    }
    navigate({ to: fallbackTo });
  }, [router, navigate, fallbackTo]);
  // A page with a back button is a page the back KEYS belong on. Installing
  // them here rather than at each call site is what keeps the two from
  // drifting apart — no screen can end up with the button and not the keys.
  useBackShortcuts(true, back);
  return back;
}

/** Is the user typing? Then no key is a navigation shortcut. */
export function isTyping(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node || !node.tagName) return false;
  const tag = node.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    node.isContentEditable === true ||
    // A listbox option or combobox has its own idea of what Escape means.
    !!node.closest?.('[role="combobox"],[role="listbox"],[contenteditable="true"]')
  );
}

/**
 * Go back one step from a detail page — by key, not just by the chevron.
 *
 * The client works on a MacBook and on Windows, so this answers what a person
 * reaches for on either: Backspace (the habit from every document viewer),
 * plus each platform's own browser-back chord — Alt+← on Windows, Cmd+← on
 * macOS. Both do exactly ONE step, the same as the chevron; neither jumps to
 * the home page. Escape does the same thing but is owned app-wide, so that it
 * also works on the pages that have no back chevron.
 *
 * It stays out of the way of everything that owns a key first: any typing, and
 * any open dialog — Escape there must close the dialog, and taking the key
 * would send the user back a page with the sheet still up.
 */
export function useBackShortcuts(enabled: boolean, back: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e.target)) return;
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
      const arrowBack = e.key === "ArrowLeft" && (e.altKey || e.metaKey);
      // Escape is handled once, app-wide (see useAppEscape) so that it means
      // the same thing on a list as on a detail page. Backspace stays here:
      // it is also the step-back key INSIDE a row, so it only doubles as
      // "leave the page" where a back button already exists.
      const plainBack = e.key === "Backspace" && !e.metaKey && !e.ctrlKey;
      if (!arrowBack && !plainBack) return;
      e.preventDefault();
      back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, back]);
}

/**
 * Escape closes the screen you are on — anywhere in the app.
 *
 * It used to work only where a back chevron happened to be rendered, so the
 * same key did something on a bill and nothing at all on the Items list. One
 * key should mean one thing, so this is mounted once at the root and covers
 * every page.
 *
 * The order of who gets it is the whole design, innermost first:
 *
 *   1. A dropdown that is open — it calls preventDefault, and this checks.
 *   2. An open dialog — Radix closes it; taking the key here would leave the
 *      page with the sheet still standing on top of the next one.
 *   3. A form that clIBELLs Escape (see useEscapeToLeave) — "leave THIS form,
 *      asking first if there is work on it" beats "go back a page".
 *   4. The open tab — the app keeps its own Chrome-style tab strip, and
 *      "close this screen" means that tab, exactly as its × does. You land
 *      on the tab that takes its place, not wherever history happened to be.
 *   5. Nothing in the strip? Then back one step.
 *
 * With no tab and nothing behind the page — a fresh tab, a bookmark, the
 * print window's escape hatch — Escape does nothing at all. It never tries to
 * close the BROWSER tab: a page cannot close a tab it did not open, and
 * quietly shutting the app on a keystroke is not something to attempt on a
 * till.
 */
export function useAppEscape() {
  const router = useRouter();
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (isTyping(e.target)) return;
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
      if (isEscapeClIBELLed()) return;

      // The tab strip is the app's own idea of "what is open", so closing the
      // current tab is what closing the current screen means here.
      const { tabs, closeTabAndNext } = useWorkspace.getState();
      const path = router.state.location.pathname;
      const open = tabs.find((t) => t.path === path);
      if (open) {
        e.preventDefault();
        const next = closeTabAndNext(open.id, path);
        if (next) navigate({ to: next });
        return;
      }

      if (!router.history.canGoBack()) return;
      e.preventDefault();
      router.history.back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, navigate]);
}

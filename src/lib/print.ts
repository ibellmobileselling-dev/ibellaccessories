// Captured once, from the first call — NOT re-read per call. If each call
// captured "whatever document.title currently is", two prints started in
// quick succession (before the first one's restore fires) would chain: the
// second call's "previous title" would be the first call's temporary
// INV-number, so its restore would clobber the title back to that instead
// of the true original app title.
let originalTitle: string | undefined;

/**
 * Open the print dialog with a meaningful document title — when the user
 * chooses "Save as PDF", the browser suggests this as the filename
 * (e.g. INV-0042.pdf instead of the app name).
 */
export function printWithName(name: string) {
  if (originalTitle === undefined) originalTitle = document.title;
  document.title = name;
  // restore() has to be able to cancel the fallback timer, but the timer
  // can't exist until restore() does — so the handle lives on a small box
  // both can close over.
  const fallback: { timer?: ReturnType<typeof setTimeout> } = {};
  const restore = () => {
    document.title = originalTitle!;
    window.removeEventListener("afterprint", restore);
    clearTimeout(fallback.timer);
  };
  window.addEventListener("afterprint", restore);
  window.print();
  // Fallback for browsers that don't fire afterprint reliably
  fallback.timer = setTimeout(restore, 3000);
}

/** True when running as an installed/home-screen app rather than a normal
 * browser tab — iOS's `navigator.standalone` for Safari-installed PWAs,
 * `display-mode: standalone` for the cross-browser equivalent. */
export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/**
 * Installed/standalone mode on iOS has no native print dialog at all —
 * `window.print()` silently does nothing there, because WebKit disables the
 * whole print UI outside of a real Safari tab, regardless of what JS does.
 * The only way to actually print from inside the installed app is to escape
 * into a normal browser tab first, which fully supports printing. That new
 * tab loads the exact same page with `?print=1` appended; each print-capable
 * page already watches for that (see useAutoPrintFromUrl) to fire
 * printWithName itself once its data has loaded, same mechanism Sales/
 * Purchase already used for the "Save & Print" flow.
 *
 * `extraParams`, when given, are set on that escape URL on top of whatever's
 * already there — for a page whose on-screen selection (active report tab,
 * chosen date range, etc.) isn't already kept in sync with the URL, passing
 * the current selection here is what makes the reopened tab print the same
 * thing that was on screen, instead of whatever the URL happened to still
 * say from when the page was first opened.
 *
 * `pdfFallback` (the page's existing server-rendered PDF download) replaces
 * that tab escape entirely when provided. The escape turned out to be broken
 * in exactly the situation it existed for: on iPhone the home-screen app and
 * Safari don't share storage, so the escaped tab isn't signed in — it boots
 * the whole SPA and stops at the login page instead of printing ("click
 * print → whole site reloads, nothing prints"). A PDF saved from inside the
 * installed app itself needs no second browser context at all.
 */
export function printOrEscapeStandalone(
  name: string,
  extraParams?: Record<string, string>,
  pdfFallback?: () => void,
) {
  if (isStandalone()) {
    if (pdfFallback) {
      pdfFallback();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("print", "1");
    if (extraParams) {
      for (const [key, value] of Object.entries(extraParams)) url.searchParams.set(key, value);
    }
    window.open(url.toString(), "_blank");
    return;
  }
  printWithName(name);
}

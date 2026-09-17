/**
 * Does this browser leave an empty date input completely blank?
 *
 * iOS Safari does: an unset `<input type="date">` renders as nothing at all,
 * so a cleared range looks like a broken control. Desktop browsers render
 * their own "dd-mm-yyyy" hint instead.
 *
 * The party statement papered over the iOS case with a "From" / "To" label
 * laid on top of the input — which on every other browser landed straight on
 * top of that built-in hint, so the field read as two overlapping strings.
 * The shop saw it the moment date ranges started opening empty.
 *
 * So the overlay is now conditional. Checked once, at module load, because
 * a browser does not change mid-session and this is read while rendering.
 */
export const NEEDS_DATE_HINT: boolean =
  typeof navigator !== "undefined" &&
  // iPadOS reports as a Mac, so the touch check is what separates it from a
  // desktop Safari that hints perfectly well on its own.
  (/iP(hone|od|ad)/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

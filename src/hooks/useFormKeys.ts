import { useEffect } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** Controls a person types into. Anything else is not "a field". */
const FIELD_SELECTOR = "input, select, textarea";

function isTextEntry(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  const node = el as HTMLElement | null;
  if (!node) return false;
  if (node.tagName === "TEXTAREA") return true;
  if (node.tagName !== "INPUT") return false;
  const type = (node as HTMLInputElement).type;
  // Checkboxes, radios and date pickers own Backspace themselves.
  return type === "text" || type === "search" || type === "tel" || type === "number";
}

/**
 * Backspace on an already-empty field steps BACK to the previous one.
 *
 * Billing is a left-to-right run along a row — item, qty, unit, price — and
 * until now the only way back was the mouse, or shift-tabbing past fields
 * that then select their contents and invite an accidental overwrite. Clearing
 * a field and pressing Backspace again is what a person already does when they
 * realise they are in the wrong box; this makes that mean "go back one",
 * exactly like the chip inputs and address bars everyone uses daily.
 *
 * The field must be EMPTY first. Stepping back from a box with something in it
 * would make Backspace unpredictable — sometimes deleting, sometimes jumping —
 * and one keystroke of "clear it, then leave" is a fair price for a rule you
 * can rely on. (`NumInput` shows an empty box for 0, so a zeroed number counts
 * as empty, which is the behaviour people expect from a blank-looking field.)
 *
 * Attach it to whatever container defines "the row" — a `<tr>` for a bill
 * line, a `<form>` for a dialog. That element is the scope, so a step back
 * can never leap into a different line or a different form.
 *
 * `onStart` fires when there is nothing before the first field — the bill
 * grid uses it to reopen the item picker, which is the real beginning of the
 * row even though it is not an input.
 */
export function stepBackOnBackspace(
  e: ReactKeyboardEvent<HTMLElement>,
  opts?: { onStart?: () => void },
) {
  if (e.key !== "Backspace" || e.defaultPrevented) return;
  const el = e.target;
  if (!isTextEntry(el)) return;
  if (el.value !== "") return;

  const scope = e.currentTarget;
  const fields = Array.from(scope.querySelectorAll<HTMLElement>(FIELD_SELECTOR)).filter(
    (f) =>
      !f.hasAttribute("disabled") &&
      f.tabIndex !== -1 &&
      // Skip anything hidden by a responsive layout — the bill grid renders a
      // desktop table and a phone card list at once, and stepping into the
      // copy nobody can see would look like the focus vanished.
      f.getClientRects().length > 0,
  );
  const i = fields.indexOf(el);
  if (i < 0) return;

  if (i === 0) {
    if (!opts?.onStart) return;
    e.preventDefault();
    opts.onStart();
    return;
  }
  e.preventDefault();
  const prev = fields[i - 1] as HTMLInputElement;
  prev.focus();
  // Select what is there so the next keystroke replaces it — the point of
  // going back is almost always to retype that value.
  prev.select?.();
}

/**
 * Escape leaves a form — once everything nearer has had its turn.
 *
 * Escape was wired straight to "navigate away" on the bill and return forms,
 * which made it do the wrong thing twice over:
 *
 *  - Closing the item picker with Escape ALSO left the bill. The picker
 *    handled the key and called preventDefault, but the page-level listener
 *    never looked, so one keystroke closed a dropdown and threw away the
 *    invoice behind it.
 *  - Even used deliberately, it discarded a half-typed bill with no warning.
 *
 * So: anything nearer the keyboard gets it first (a popup that called
 * preventDefault, or an open dialog, which owns Escape by right), and leaving
 * with unsaved work now asks. What Escape means is the same everywhere in the
 * app — close the innermost thing that is open, and only then leave the page.
 */
let escapeClIBELLs = 0;

/** Is a form currently answering Escape itself?
 *
 * The app-wide handler goes back a page on Escape; a form on screen has a
 * better answer (leave THIS form, asking first if there is work on it). Both
 * are window listeners, and the app-wide one is registered first, so it would
 * otherwise win the race and go back before the form ever saw the key. An
 * explicit clIBELL decides it by intent rather than by mount order. */
export function isEscapeClIBELLed() {
  return escapeClIBELLs > 0;
}

export function useEscapeToLeave(leave: () => void, isDirty: () => boolean) {
  useEffect(() => {
    escapeClIBELLs++;
    return () => {
      escapeClIBELLs--;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A dialog owns Escape while it is open — taking it here would leave
      // the page with the sheet still standing on top of the next one.
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
      // ClIBELL the key BEFORE asking. Answering "no, stay" is still this form
      // handling Escape; leaving it unclIBELLed let the app-wide handler pick
      // the same keystroke up afterwards and go back anyway — declining the
      // prompt and losing the bill regardless.
      e.preventDefault();
      if (isDirty() && !confirm("Leave without saving? Anything typed here will be lost.")) return;
      leave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [leave, isDirty]);
}

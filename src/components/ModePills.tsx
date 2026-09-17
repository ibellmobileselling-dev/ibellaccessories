import type { PaymentMode } from "@/types";
import { MODE_LABELS } from "@/lib/paymentMode";

/**
 * Theme-styled payment mode selector — pill buttons instead of the native
 * <select>, whose dropdown list can't be themed and looks foreign to the app.
 *
 * Keyboard, in two states, because the counter wants different things
 * before and after it has decided:
 *
 *   nothing chosen yet — every pill is a Tab stop, so Tab walks Cash, Bank,
 *   Credit and Enter or Space picks the one you stopped on
 *
 *   chosen — the group collapses to ONE Tab stop (the chosen pill), so Tab
 *   leaves for the amount instead of walking past decisions already made.
 *   Arrow keys still move within it.
 *
 * Those are two requests that looked contradictory — "stop Tab walking the
 * pills" and "why does Tab skip Cash and Bank" — and are the same rule seen
 * from either side of making the choice.
 *
 * Every pill used to carry tabIndex 0, so Tab from Cash landed on the Bank
 * pill and then the Credit pill before reaching anything that takes a number.
 * The shop reported that as Tab "going to bank" — it does, just not to the
 * bank field they meant — and asked for Tab to leave the group and land on
 * the amount, which is the next thing anyone actually types into.
 *
 * So: roving tabindex, the standard radiogroup pattern. The selected pill is
 * the tab stop (which also keeps macOS Safari reaching it at all, the reason
 * the explicit tabIndex was here in the first place), arrow keys move within
 * the group, and Tab leaves it. Space and Enter still select, so the pill you
 * have arrowed to behaves like any other button.
 */
export function ModePills({
  value,
  onChange,
  modes,
}: {
  /** undefined = nothing chosen yet, which is how a new bill starts. */
  value: PaymentMode | undefined;
  onChange: (m: PaymentMode) => void;
  modes: PaymentMode[];
}) {
  /** Move along the group and take the selection with you — a radiogroup
   *  selects on arrow, which is what makes one tab stop workable. */
  const step = (from: PaymentMode, delta: number, group: HTMLElement | null) => {
    const i = modes.indexOf(from);
    if (i < 0) return;
    const next = modes[(i + delta + modes.length) % modes.length];
    onChange(next);
    // Focus follows selection, or the ring stays on a pill that is no longer
    // the chosen one and Tab would leave from the wrong place.
    group?.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Payment mode"
      className="flex flex-wrap gap-1 justify-end rounded-lg p-0.5"
    >
      {modes.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          data-mode={m}
          aria-checked={value === m}
          /* Every pill until one is picked; only the picked one afterwards. */
          tabIndex={value === undefined || value === m ? 0 : -1}
          onClick={() => onChange(m)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") {
              e.preventDefault();
              step(m, 1, e.currentTarget.parentElement);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
              e.preventDefault();
              step(m, -1, e.currentTarget.parentElement);
            }
          }}
          className={`px-2.5 h-7 rounded-full border text-[11px] font-semibold transition outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
            value === m
              ? "bg-primary text-primary-foreground border-primary shadow-sm"
              : "bg-background text-muted-foreground border-border hover:border-primary/40 hover:text-foreground"
          }`}
        >
          {MODE_LABELS[m]}
        </button>
      ))}
    </div>
  );
}

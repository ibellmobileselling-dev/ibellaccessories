import type { PaymentMode } from "@/types";
import { MODE_LABELS } from "@/lib/paymentMode";

/**
 * Theme-styled payment mode selector — pill buttons instead of the native
 * <select>, whose dropdown list can't be themed and looks foreign to the app.
 *
 * Keyboard: each pill is its own Tab stop (explicit tabIndex — macOS Safari
 * skips plain buttons when Tabbing unless one is set) and a real <button>,
 * so Space/Enter select it natively — matching how cashiers actually drive
 * this app (Tab between fields, Space/Enter to choose) instead of requiring
 * arrow keys or digit shortcuts.
 */
export function ModePills({
  value,
  onChange,
  modes,
}: {
  value: PaymentMode;
  onChange: (m: PaymentMode) => void;
  modes: PaymentMode[];
}) {
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
          aria-checked={value === m}
          tabIndex={0}
          onClick={() => onChange(m)}
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

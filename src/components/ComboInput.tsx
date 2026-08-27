import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { matchesQuery, byRelevance } from "@/lib/search";
import { Plus } from "lucide-react";

/**
 * A text box that suggests what has been typed here before, and still accepts
 * anything new.
 *
 * Category was a plain input on both the item form and the bulk grid, so the
 * same shelf got entered as "Charger", "charger" and "Chargers" and the
 * category filter stopped meaning anything. Offering the existing values
 * makes the consistent choice the easy one, without ever blocking a genuinely
 * new one — which is why the free text stays and "add" is just the last row
 * of the list rather than a separate mode.
 *
 * The list is PORTALLED and positioned fixed, because this is used inside the
 * bulk grid's scroll container where an absolutely positioned dropdown would
 * be clipped by the row — the same reason the item picker does it.
 */
export function ComboInput({
  value,
  onValue,
  options,
  placeholder,
  className,
  ariaLabel,
  id,
}: {
  value: string;
  onValue: (v: string) => void;
  /** Existing values to suggest. Deduped and sorted by the caller or not —
   *  this dedupes case-insensitively either way. */
  options: string[];
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const update = () => {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect((prev) =>
        prev && prev.top === r.bottom + 4 && prev.left === r.left && prev.width === r.width
          ? prev
          : { top: r.bottom + 4, left: r.left, width: Math.max(r.width, 180) },
      );
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  const unique = Array.from(
    new Map(
      options
        .map((o) => (o ?? "").trim())
        .filter(Boolean)
        .map((o) => [o.toLowerCase(), o]),
    ).values(),
  ).sort((a, b) => a.localeCompare(b));

  const typed = value.trim();
  const matches = typed
    ? unique.filter((o) => matchesQuery(typed, o)).sort(byRelevance(typed, (o) => o))
    : unique;
  // Only offer "add" for something genuinely absent — otherwise every
  // keystroke ends with a row inviting a duplicate of what already exists.
  const canAdd = !!typed && !unique.some((o) => o.toLowerCase() === typed.toLowerCase());
  const rows = canAdd ? [...matches, null] : matches;

  const commit = (v: string) => {
    onValue(v);
    setOpen(false);
  };

  return (
    <>
      <input
        ref={inputRef}
        id={id}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onValue(e.target.value);
          setOpen(true);
          setIdx(0);
        }}
        onFocus={() => setOpen(true)}
        // A click on a row must land before the blur closes the list, which
        // is what the delay buys; the rows also use mousedown for the same
        // reason.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setIdx((i) => Math.min(rows.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIdx((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && open && rows.length) {
            e.preventDefault();
            commit(rows[idx] ?? typed);
          } else if (e.key === "Escape" && open) {
            // Swallow it: this closes the list, it does not close the dialog
            // the list is sitting in.
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className={className}
      />
      {open &&
        rect &&
        rows.length > 0 &&
        createPortal(
          <div
            role="listbox"
            style={{ position: "fixed", top: rect.top, left: rect.left, width: rect.width }}
            className="z-50 border rounded-md bg-popover shadow-elevated max-h-56 overflow-auto"
          >
            {rows.map((opt, i) => (
              <div
                key={opt ?? "__add__"}
                role="option"
                aria-selected={i === idx}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(opt ?? typed);
                }}
                onMouseEnter={() => setIdx(i)}
                className={`px-2.5 py-1.5 text-[13px] cursor-pointer flex items-center gap-1.5 ${
                  i === idx ? "bg-accent" : "hover:bg-accent"
                } ${opt === null ? "text-primary font-medium border-t" : ""}`}
              >
                {opt === null ? (
                  <>
                    <Plus className="h-3.5 w-3.5 shrink-0" />
                    Add &ldquo;{typed}&rdquo;
                  </>
                ) : (
                  opt
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

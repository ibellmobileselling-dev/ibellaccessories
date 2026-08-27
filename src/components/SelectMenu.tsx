import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

/**
 * A small dropdown that belongs to this app rather than to Windows.
 *
 * A native <select> hands its popup to the operating system, which draws a
 * plain list in the OS blue and ignores every radius, font and colour the
 * rest of the screen uses — a foreign control sitting in the middle of the
 * app. This is the same popup the account and category pickers use: rounded
 * card, the app's own accent for the highlight, a tick on the current choice.
 *
 * It opens UPWARDS when there is no room below, which matters because the
 * places that need it most — a per-page control, a footer filter — live at
 * the bottom of the screen where a downward list would be cut off.
 */
export function SelectMenu<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  className = "",
  align = "left",
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
  className?: string;
  /** Which edge the popup lines up with — `right` for a control near the
   *  right edge, where a left-aligned popup would hang off the screen. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const [dropUp, setDropUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const chosen = options.find((o) => o.value === value);

  // Decide the direction from the room actually available, measured at the
  // moment it opens rather than assumed from where the control usually sits.
  useEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const needed = Math.min(options.length * 34 + 8, 240);
      setDropUp(r.bottom + needed > window.innerHeight && r.top > needed);
    }
    setIdx(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Closes the LIST, not whatever the list is sitting inside.
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setIdx((i) => Math.min(options.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const picked = options[idx];
        if (picked) onChange(picked.value);
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, options, idx, onChange]);

  return (
    <div className="relative" ref={ref}>
      <button
        ref={btnRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`inline-flex items-center gap-1 rounded-md border bg-background text-left outline-none transition ${
          open ? "border-primary ring-1 ring-primary" : "border-input hover:bg-accent/40"
        } ${className}`}
      >
        <span className="tabular-nums">{chosen?.label ?? ""}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className={`absolute z-40 min-w-full border rounded-md bg-popover shadow-elevated max-h-60 overflow-auto py-1 ${
            dropUp ? "bottom-full mb-1" : "top-full mt-1"
          } ${align === "right" ? "right-0" : "left-0"}`}
        >
          {options.map((o, i) => (
            <div
              key={String(o.value)}
              role="option"
              aria-selected={o.value === value}
              onMouseEnter={() => setIdx(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(o.value);
                setOpen(false);
              }}
              className={`px-3 py-1.5 text-[13px] cursor-pointer flex items-center justify-between gap-3 whitespace-nowrap tabular-nums ${
                i === idx ? "bg-accent" : ""
              }`}
            >
              {o.label}
              {o.value === value && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

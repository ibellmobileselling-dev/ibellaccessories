/**
 * Naming the individual units on a bill line.
 *
 * Two jobs, one component, because they are the same act from the counter's
 * point of view — point the scanner at the thing and it appears on the bill:
 *
 *   receiving    — new units arriving; the serial must NOT already exist
 *   issuing      — units going out; the serial MUST be one that is in stock
 *   taking_back  — units coming back from a customer; it MUST be one that is
 *                  currently sold, which is the exact opposite test
 *
 * Scan-first throughout. The box keeps focus, a scan commits on Enter, and
 * the next scan goes straight in. Twenty units must be twenty scans and no
 * mouse — a feature that slows the counter is a feature staff work around,
 * and then the data is wrong AND everyone is annoyed.
 */

import { useEffect, useRef, useState } from "react";
import type { Item, Serial } from "@/types";
import { SerialRepo } from "@/repositories";
import {
  findSerial,
  normaliseSerial,
  DRAFT_PREFIX,
  isDraftSerial,
  draftSerialText,
} from "@/lib/serials";
import { X, ScanLine, AlertCircle } from "lucide-react";

export interface SerialEntryProps {
  item: Item;
  mode: "receiving" | "issuing" | "taking_back";
  /** Serial ids already on this line. */
  value: string[];
  onChange: (ids: string[]) => void;
  /** The line's quantity — the count these must match. */
  qty: number;
  /**
   * Ids this line may keep even though they are no longer `in_stock`: the
   * ones it already issued, when an existing bill is being edited. Without
   * this, editing yesterday's bill would refuse every serial on it, because
   * they are all `sold` — to this very bill.
   */
  alreadyOnThisDocument?: string[];
  /** Serial ids taken by OTHER lines of the same bill — the same unit must
   *  not be sold twice on one document. */
  usedElsewhere?: string[];
  /**
   * When the document was loaded from another one, the only units it may
   * name.
   *
   * A credit note raised against INV-1 that takes back a unit sold on INV-9
   * quietly corrupts both: INV-9 keeps a unit it no longer has, and the
   * customer on INV-1 is credited for something they never bought. The
   * scanner is the moment to catch that, not a reconciliation months later.
   */
  restrictTo?: { ids: string[]; label: string };
}

export function SerialEntry({
  item,
  mode,
  value,
  onChange,
  qty,
  alreadyOnThisDocument = [],
  usedElsewhere = [],
  restrictTo,
}: SerialEntryProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const boxRef = useRef<HTMLInputElement>(null);

  // A new line opens ready to scan. Anything else means reaching for the
  // mouse before the first unit.
  useEffect(() => {
    boxRef.current?.focus();
  }, []);

  const known = SerialRepo.all();
  const labelOf = (id: string) =>
    isDraftSerial(id) ? draftSerialText(id) : (known.find((s) => s.id === id)?.serial ?? id);

  const add = (raw: string) => {
    const wanted = normaliseSerial(raw);
    if (!wanted) return;

    if (value.some((id) => normaliseSerial(labelOf(id)) === wanted)) {
      setError(`${wanted} is already on this line`);
      return;
    }
    if (usedElsewhere.some((id) => normaliseSerial(labelOf(id)) === wanted)) {
      setError(`${wanted} is already on another line of this bill`);
      return;
    }

    const existing = findSerial(item.id, wanted, known);

    if (mode === "receiving") {
      /* A serial that already exists is either a genuine duplicate or a
         mis-scan, and both are worth stopping at the moment the scanner
         beeps rather than at save time. Where it is is more useful than
         that it is. */
      if (existing) {
        setError(
          existing.status === "in_stock"
            ? `${wanted} is already in stock`
            : `${wanted} exists already — ${existing.status.replace(/_/g, " ")}`,
        );
        return;
      }
      onChange([...value, DRAFT_PREFIX + wanted]);
    } else {
      if (!existing) {
        setError(`${wanted} is not a unit of ${item.name}`);
        return;
      }
      // Editing an existing document: its own units are no longer in the
      // state this mode wants, because this very document moved them.
      const mine = alreadyOnThisDocument.includes(existing.id);
      const needs = mode === "taking_back" ? "sold" : "in_stock";
      if (existing.status !== needs && !mine) {
        setError(
          mode === "taking_back"
            ? existing.status === "in_stock"
              ? `${wanted} is in stock — it was not sold, so it cannot come back`
              : `${wanted} is ${existing.status.replace(/_/g, " ")}, not with a customer`
            : existing.status === "sold"
              ? `${wanted} has already been sold`
              : `${wanted} is ${existing.status.replace(/_/g, " ")}`,
        );
        return;
      }
      if (restrictTo && !restrictTo.ids.includes(existing.id) && !mine) {
        setError(`${wanted} is not on ${restrictTo.label}`);
        return;
      }
      onChange([...value, existing.id]);
    }
    setError("");
    setText("");
  };

  /** Vendors email serial lists; 50 pasted at once must not be 50 scans. */
  const addMany = (blob: string) => {
    const parts = blob
      .split(/[\s,;]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length < 2) return false;
    for (const p of parts) add(p);
    return true;
  };

  const remove = (id: string) => onChange(value.filter((x) => x !== id));

  const short = qty - value.length;

  return (
    <div className="mt-1.5 rounded-md border bg-muted/30 px-2.5 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <ScanLine className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input
          ref={boxRef}
          value={text}
          aria-label={`Serial numbers for ${item.name}`}
          placeholder={
            mode === "receiving"
              ? "Scan or type a serial…"
              : mode === "taking_back"
                ? "Scan the unit coming back…"
                : "Scan the unit going out…"
          }
          onChange={(e) => {
            // A paste of many arrives as one change, not as keystrokes.
            if (addMany(e.target.value)) {
              setText("");
              return;
            }
            setText(e.target.value);
            setError("");
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            // The scanner sends Enter. It must add a serial, never submit the
            // bill — a half-scanned line saved by a scanner is the worst
            // possible outcome here.
            e.preventDefault();
            e.stopPropagation();
            add(text);
          }}
          className="flex-1 h-7 px-2 text-[13px] rounded border bg-background focus:border-primary outline-none"
        />
        <span
          className={`text-[11px] font-semibold tabular-nums shrink-0 ${
            short === 0 ? "text-emerald-700" : "text-amber-700"
          }`}
        >
          {value.length}/{qty}
        </span>
      </div>

      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1 rounded bg-background border px-1.5 py-0.5 text-[11px] font-mono"
            >
              {labelOf(id)}
              <button
                type="button"
                aria-label={`Remove ${labelOf(id)}`}
                onClick={() => remove(id)}
                className="text-gray-400 hover:text-rose-600"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {error && (
        <p className="mt-1 text-[11px] text-rose-600 flex items-center gap-1">
          <AlertCircle className="h-3 w-3 shrink-0" /> {error}
        </p>
      )}
      {!error && short !== 0 && (
        <p className="mt-1 text-[11px] text-amber-700">
          {short > 0
            ? `${short} more to ${mode === "receiving" ? "scan" : "pick"}`
            : `${-short} too many — remove one, or raise the quantity`}
        </p>
      )}
    </div>
  );
}

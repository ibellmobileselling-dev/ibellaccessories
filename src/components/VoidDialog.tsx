/**
 * Cancelling a document that has already been counted.
 *
 * Deliberately not a `window.confirm`. Voiding is the one correction that
 * leaves a permanent mark, so the shop is told three things before it
 * happens — what stays, what stops counting, and what gets put back — and is
 * asked for a reason, because "why is INV-0047 voided" is the question
 * somebody will ask in six months and nothing else will answer it.
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/Field";
import { Ban } from "lucide-react";

export function VoidDialog({
  open,
  onOpenChange,
  what,
  /** What will be put back or unlinked — stock, a bank balance, allocations. */
  effects,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** How the document is named on screen, e.g. "invoice INV-0047". */
  what: string;
  effects?: string[];
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  // A reason typed for the last document must never be carried into the next.
  useEffect(() => {
    if (open) {
      setReason("");
      setBusy(false);
    }
  }, [open]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = reason.trim();
    if (!text) return;
    setBusy(true);
    onConfirm(text);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ban className="h-4 w-4 text-rose-600" />
            Void {what}?
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="rounded-md border bg-muted/40 px-3 py-2.5 space-y-1.5">
            <p className="text-[12px] text-gray-700">
              It stays on the list, marked as voided, and stops counting in every total from now on.
              The books keep both the original and a reversal dated today, so the month it belonged
              to does not quietly change.
            </p>
            {!!effects?.length && (
              <ul className="text-[12px] text-gray-600 list-disc pl-4 space-y-0.5">
                {effects.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </div>
          <Field
            label="Why is it being voided? *"
            value={reason}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
            placeholder="Entered twice, wrong customer, cancelled order…"
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || !reason.trim()}
              className="bg-rose-600 hover:bg-rose-700"
            >
              {busy ? "Voiding…" : `Void ${what}`}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The badge on a cancelled row, with the reason on hover. */
export function VoidedBadge({ reason, at }: { reason?: string; at?: string }) {
  return (
    <span
      className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200"
      title={
        reason
          ? `Voided${at ? ` on ${at.slice(0, 10)}` : ""} — ${reason}`
          : "Voided — no reason was recorded"
      }
    >
      Voided
    </span>
  );
}

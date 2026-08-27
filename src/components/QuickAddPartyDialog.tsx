import { useEffect, useRef, useState } from "react";
import { UserPlus, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/Field";
import { NumField } from "@/components/NumInput";
import type { Party } from "@/types";

export interface QuickAddPartyDetails {
  name: string;
  phone: string;
  openingBalance: number;
  gstin: string;
  creditLimit: number;
}

/**
 * Shown instead of silently auto-creating a party with blank defaults when a
 * name typed at the counter (Sale/Purchase/Return) doesn't match anyone on
 * file — asks for the real details up front so the party record isn't
 * missing phone/opening balance from day one.
 */
export function QuickAddPartyDialog({
  draft,
  isSale,
  existingParties = [],
  onCancel,
  onPickExisting,
  onConfirm,
}: {
  draft: { name: string; phone: string } | null;
  isSale: boolean;
  existingParties?: Party[];
  onCancel: () => void;
  onPickExisting?: (p: Party) => void;
  onConfirm: (details: QuickAddPartyDetails) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [openingBalance, setOpeningBalance] = useState(0);
  const [gstin, setGstin] = useState("");
  const [creditLimit, setCreditLimit] = useState(0);
  const [nameOpen, setNameOpen] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (draft) {
      setName(draft.name);
      setPhone(draft.phone);
      setOpeningBalance(0);
      setGstin("");
      setCreditLimit(0);
      setNameOpen(false);
      setTimeout(() => firstRef.current?.focus(), 50);
    }
  }, [draft]);

  if (!draft) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Name required");
      return;
    }
    onConfirm({ name, phone, openingBalance, gstin, creditLimit });
  };

  // Live "does this already exist?" hint — the name typed at the counter
  // didn't exactly match anyone, but if they edit it here into something
  // close to an existing party, flag it before a near-duplicate gets created.
  const nameQ = name.trim().toLowerCase();
  const similarPartiesAll = nameQ
    ? existingParties.filter((p) => p.name.trim().toLowerCase().includes(nameQ))
    : [];
  const similarParties = similarPartiesAll.slice(0, 5);

  return (
    <Dialog open onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            New {isSale ? "Customer" : "Supplier"}
          </DialogTitle>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground -mt-2">
          "{draft.name}" isn't in your parties list yet — add their details to continue.
        </p>
        <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2 relative">
            <Field
              ref={firstRef}
              label="Name *"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameOpen(true);
              }}
              onFocus={() => setNameOpen(true)}
              onBlur={() => setTimeout(() => setNameOpen(false), 150)}
              autoComplete="off"
            />
            {nameOpen && similarParties.length > 0 && (
              <div className="absolute z-30 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-elevated max-h-52 overflow-auto">
                <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 bg-amber-50 border-b flex items-center gap-1.5">
                  <AlertTriangle className="h-3 w-3" />
                  {similarPartiesAll.length === 1
                    ? "Similar party exists"
                    : "Similar parties exist"}
                  — click to use it instead
                </div>
                {similarParties.map((p) => (
                  <div
                    key={p.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onPickExisting?.(p);
                      setNameOpen(false);
                    }}
                    className="px-3 py-2 text-sm cursor-pointer hover:bg-accent flex items-center justify-between"
                  >
                    <span className="font-medium">{p.name}</span>
                    {p.phone && (
                      <span className="text-[11px] text-muted-foreground">{p.phone}</span>
                    )}
                  </div>
                ))}
                {similarPartiesAll.length > similarParties.length && (
                  <div className="px-3 py-1.5 text-[11px] text-muted-foreground border-t">
                    +{similarPartiesAll.length - similarParties.length} more match
                    {similarPartiesAll.length - similarParties.length > 1 ? "es" : ""}
                  </div>
                )}
              </div>
            )}
          </div>
          <Field
            label="Phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="numeric"
          />
          <NumField
            label="Opening Balance"
            value={openingBalance}
            onValue={setOpeningBalance}
            allowNegative
          />
          <Field
            label="GSTIN"
            value={gstin}
            onChange={(e) => setGstin(e.target.value.toUpperCase())}
          />
          <NumField label="Credit Limit" value={creditLimit} onValue={setCreditLimit} />
          <div className="sm:col-span-2 flex justify-end gap-2 mt-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">Add & Continue</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

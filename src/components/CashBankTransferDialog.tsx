import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/Field";
import { NumInput } from "@/components/NumInput";
import { ArrowLeftRight, Banknote, Check, ChevronDown, Landmark, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  BankRepo,
  BankTxnRepo,
  CashAdjustmentRepo,
  SalesRepo,
  PurchaseRepo,
  ExpenseRepo,
  PaymentRepo,
} from "@/repositories";
import { newBatch, commitBatch, genId } from "@/repositories/base";
import { useRepoMemo } from "@/hooks/useRepoData";
import { cashFlows } from "@/lib/ledger";
import { transferLegsFor } from "@/lib/transferLegs";
import { usePeriodLock } from "@/hooks/usePeriodLock";
import { nextVoucherNo } from "@/repositories";
import type { CashAdjustment } from "@/types";
import { fmtMoney, today } from "@/lib/format";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The cash drawer is an account like any other here, so one picker can offer
 *  it alongside the banks and the same form covers every direction. */
const CASH = "cash";

interface Account {
  id: string;
  name: string;
  balance: number;
  accountNumber?: string;
}

/**
 * Move money between the places the shop keeps it.
 *
 * Modelled on what the client already knows from Vyapar: one screen with a
 * FROM and a TO, and the three transfers that matter — cash to bank, bank to
 * cash, and bank to bank — are the same action with different endpoints
 * rather than three features. The first version of this screen only did the
 * cash-to-bank pair, so moving money between two accounts meant a withdrawal
 * and a deposit entered by hand, with nothing tying them together.
 *
 * Every transfer is ONE batch. A transfer that half-lands — money leaving one
 * account and never arriving at the other — is the single outcome here that
 * silently costs the shop money, so the two sides commit together or not at
 * all.
 *
 * It writes only records the rest of the app already understands: a BankTxn
 * for each bank leg and a CashAdjustment for a cash leg. Every report, the
 * day book and each account's passbook pick these up with no changes.
 */
export function CashBankTransferDialog({
  open,
  onOpenChange,
  onSaved,
  initialBankId,
  editing,
  onEditingDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
  /** Preselect the FROM account — set when opened from that account's page. */
  initialBankId?: string;
  /** An existing transfer being corrected, identified by its CASH leg.
   *
   * Editing one side of a transfer on its own is the one thing that must not
   * happen — the cash would move and the account would still say the old
   * figure. So a transfer is edited HERE, as the whole thing it is, and the
   * save below rewrites both legs together. Refusing the edit was the safe
   * answer, not a good one: correcting a mistyped transfer meant deleting it
   * and entering it again from memory. */
  editing?: CashAdjustment | null;
  /** Clear the caller's "editing" state when this closes. */
  onEditingDone?: () => void;
}) {
  const banks = useRepoMemo(() => BankRepo.all());
  const cashInHand = useRepoMemo(() =>
    cashFlows(
      SalesRepo.all(),
      PurchaseRepo.all(),
      ExpenseRepo.all(),
      PaymentRepo.all(),
      CashAdjustmentRepo.all(),
    ).reduce((s, e) => s + e.in - e.out, 0),
  );

  const accounts: Account[] = useMemo(
    () => [
      { id: CASH, name: "Cash in Hand", balance: cashInHand },
      ...banks.map((b) => ({
        id: b.id,
        name: b.name,
        balance: b.balance,
        accountNumber: b.accountNumber,
      })),
    ],
    [banks, cashInHand],
  );

  const [fromId, setFromId] = useState<string>(CASH);
  const [toId, setToId] = useState<string>("");
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const { canPost } = usePeriodLock();

  // The legs of the transfer being edited, and which way it went. The cash
  // leg says the direction: cash OUT means cash was the source.
  const editLegs = useMemo(
    () => (editing ? transferLegsFor(editing, BankTxnRepo.all()) : []),
    [editing],
  );
  const isOpen = open || !!editing;

  useEffect(() => {
    if (!isOpen) return;
    if (editing) {
      const bankLeg = editLegs[0];
      const cashIsSource = editing.type === "reduce";
      setFromId(cashIsSource ? CASH : (bankLeg?.bankId ?? CASH));
      setToId(cashIsSource ? (bankLeg?.bankId ?? "") : CASH);
      setAmount(editing.amount);
      setDate(editing.date);
      // Strip the "Transfer X → Y" prefix the save adds back, so the note the
      // person actually typed is what they see in the box.
      setNotes((editing.reason ?? "").replace(/^Transfer\b[^—]*—\s*/i, "").trim());
      setSaving(false);
      return;
    }
    // Opened from an account's own page: that account is what you are moving
    // money OUT of, which is the common reason to be standing there.
    setFromId(initialBankId ?? CASH);
    setToId(initialBankId ? CASH : (banks[0]?.id ?? ""));
    setAmount(0);
    setDate(today());
    setNotes("");
    setSaving(false);
    // `banks` deliberately not a dependency: reopening resets the form, a
    // background sync must not wipe what is half-typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialBankId, editing, editLegs]);

  const from = accounts.find((a) => a.id === fromId);
  const to = accounts.find((a) => a.id === toId);
  const sameAccount = !!from && !!to && from.id === to.id;

  const swap = () => {
    setFromId(toId);
    setToId(fromId);
  };

  const save = () => {
    if (saving) return;
    if (!from || !to) {
      toast.error("Choose both accounts");
      return;
    }
    if (sameAccount) {
      toast.error("Choose two different accounts");
      return;
    }
    const n = r2(amount);
    if (!n || n <= 0) {
      toast.error("Enter an amount to transfer");
      return;
    }
    if (!date) {
      toast.error("Enter a date");
      return;
    }
    // Both dates: an edit that moves a transfer out of a closed month changes
    // that month as surely as one made inside it.
    if (!canPost(date, editing?.date)) return;
    // A warning, not a block: a shop counts its drawer at the end of the day,
    // and refusing the entry would only push the correction somewhere the
    // books cannot see it. Same rule the app already follows for stock.
    if (n > from.balance + 0.005) {
      toast.warning(`This is more than ${from.name}'s ${fmtMoney(from.balance)} — recorded anyway`);
    }

    setSaving(true);
    const label = `Transfer ${from.name} → ${to.name}`;
    const note = notes.trim() ? `${label} — ${notes.trim()}` : label;
    const batch = newBatch();
    // Keep the pair's id across an edit, and give an older unstamped pair one
    // now, so the two legs stay recognisable as one movement afterwards.
    const transferId = editing?.transferId ?? genId();
    // ONE reference on both legs, because a transfer is one voucher: the same
    // number is quotable from the cash side and from the bank side.
    const voucherNo = editing?.voucherNo ?? nextVoucherNo("TR-", BankTxnRepo.allWithVoided());

    // An edit is "undo the old movement, make the new one" — both on this one
    // batch, so a correction can never land halfway and leave the books with
    // one and a half transfers in them.
    if (editing) {
      CashAdjustmentRepo.removeBatched(batch, editing.id);
      for (const leg of editLegs) {
        BankTxnRepo.removeBatched(batch, leg.id);
        BankRepo.adjustFieldBatched(
          batch,
          leg.bankId,
          "balance",
          leg.type === "deposit" ? -leg.amount : leg.amount,
        );
      }
    }

    // Out of the FROM account…
    if (from.id === CASH) {
      CashAdjustmentRepo.addBatched(batch, {
        date,
        type: "reduce",
        amount: n,
        // Written by the app, never offered in the picker: a transfer's other
        // side is a real account, so it is the one purpose nobody has to state.
        purpose: "transfer",
        reason: note,
        transferId,
        voucherNo,
      });
    } else {
      BankTxnRepo.addBatched(batch, {
        bankId: from.id,
        date,
        type: "withdraw",
        amount: n,
        notes: note,
        voucherNo,
        transferId,
      });
      BankRepo.adjustFieldBatched(batch, from.id, "balance", -n);
    }
    // …and into the TO account, on the same batch.
    if (to.id === CASH) {
      CashAdjustmentRepo.addBatched(batch, {
        date,
        type: "add",
        amount: n,
        purpose: "transfer",
        reason: note,
        transferId,
        voucherNo,
      });
    } else {
      BankTxnRepo.addBatched(batch, {
        bankId: to.id,
        date,
        type: "deposit",
        amount: n,
        notes: note,
        voucherNo,
        transferId,
      });
      BankRepo.adjustFieldBatched(batch, to.id, "balance", n);
    }

    commitBatch(batch, "account transfer").then((ok) => {
      setSaving(false);
      if (!ok) {
        toast.error("The transfer did not reach the cloud — reload and check before repeating it");
        return;
      }
      toast.success(
        editing
          ? `Transfer updated — ${fmtMoney(n)} from ${from.name} to ${to.name}`
          : `${fmtMoney(n)} moved from ${from.name} to ${to.name}`,
      );
      onSaved();
      onEditingDone?.();
      onOpenChange(false);
    });
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(v) => {
        if (saving) return;
        if (!v) onEditingDone?.();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">
            {editing ? "Edit Transfer" : "Transfer Money"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3.5">
          <div className="flex items-end gap-2">
            <AccountPicker
              label="From"
              accounts={accounts}
              value={fromId}
              onChange={setFromId}
              excludeId={toId}
            />
            <button
              type="button"
              onClick={swap}
              aria-label="Swap accounts"
              title="Swap the two ends"
              className="h-[52px] w-9 shrink-0 rounded-md border border-input bg-muted/40 flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition"
            >
              <ArrowLeftRight className="h-4 w-4" />
            </button>
            <AccountPicker
              label="To"
              accounts={accounts}
              value={toId}
              onChange={setToId}
              excludeId={fromId}
            />
          </div>

          {sameAccount && (
            <p className="text-[12px] text-rose-600">
              Pick two different accounts — money cannot move to where it already is.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="text-muted-foreground font-medium">Amount (₹) *</span>
              <NumInput
                value={amount}
                onValue={setAmount}
                aria-label="Transfer amount"
                className="h-8 px-2 border rounded bg-background outline-none focus:border-primary focus:ring-1 focus:ring-primary text-right tabular-nums"
              />
            </label>
            <Field
              label="Date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          <Field
            label="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Slip no, reference…"
          />

          {amount > 0 && from && to && !sameAccount && (
            <div className="text-[12px] bg-muted/50 border rounded-md px-3 py-2 flex items-center justify-between gap-3">
              <span className="text-muted-foreground">After this transfer</span>
              <span className="flex items-center gap-2 min-w-0">
                <span className="truncate">
                  {from.name}{" "}
                  <span className="font-semibold tabular-nums text-rose-700">
                    {fmtMoney(r2(from.balance - amount))}
                  </span>
                </span>
                <ArrowLeftRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">
                  {to.name}{" "}
                  <span className="font-semibold tabular-nums text-emerald-700">
                    {fmtMoney(r2(to.balance + amount))}
                  </span>
                </span>
              </span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => {
                onEditingDone?.();
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="button" onClick={save} disabled={saving || accounts.length < 2}>
              {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Transfer
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One side of the transfer.
 *
 * A native <select> hands its popup to the operating system, which draws a
 * plain list in the OS blue and cannot lay out more than one string per row —
 * and each row here needs a name AND a balance, which is the number that
 * decides whether the transfer makes sense.
 */
function AccountPicker({
  label,
  accounts,
  value,
  onChange,
  excludeId,
}: {
  label: string;
  accounts: Account[];
  value: string;
  onChange: (id: string) => void;
  /** The other side, greyed out — a transfer to the same place is not one. */
  excludeId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const chosen = accounts.find((a) => a.id === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Closes the LIST, not the dialog it sits in.
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setIdx((i) => Math.min(accounts.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const picked = accounts[idx];
        if (picked && picked.id !== excludeId) onChange(picked.id);
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, accounts, idx, excludeId, onChange]);

  const Icon = chosen?.id === CASH ? Banknote : Landmark;

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-1 text-[12px] relative" ref={ref}>
      <span className="text-muted-foreground font-medium">{label}</span>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-label={`${label} account`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
            setIdx(
              Math.max(
                0,
                accounts.findIndex((a) => a.id === value),
              ),
            );
          }
        }}
        className={`h-[52px] px-2.5 border rounded-md bg-background text-left outline-none transition ${
          open ? "border-primary ring-1 ring-primary" : "border-input hover:bg-accent/40"
        }`}
      >
        {/* The balance lives INSIDE the field. As loose text underneath it
            left the two columns different heights, pushed the swap button
            out of line with the fields it sits between, and read as a stray
            caption rather than as this account's money. */}
        <span className="flex items-center gap-2 min-w-0">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold leading-tight">
              {chosen?.name ?? "Choose…"}
            </span>
            <span className="block text-[11px] text-muted-foreground tabular-nums leading-tight">
              {chosen ? fmtMoney(chosen.balance) : "—"}
            </span>
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={`${label} accounts`}
          className="absolute z-30 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-elevated max-h-56 overflow-auto py-1"
        >
          {accounts.map((a, i) => {
            const disabled = a.id === excludeId;
            const RowIcon = a.id === CASH ? Banknote : Landmark;
            return (
              <div
                key={a.id}
                role="option"
                aria-selected={a.id === value}
                aria-disabled={disabled}
                onMouseEnter={() => setIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (disabled) return;
                  onChange(a.id);
                  setOpen(false);
                }}
                className={`px-2.5 py-1.5 flex items-center justify-between gap-3 ${
                  disabled
                    ? "opacity-40 cursor-not-allowed"
                    : `cursor-pointer ${i === idx ? "bg-accent" : ""}`
                }`}
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <RowIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{a.name}</span>
                    {a.accountNumber && (
                      <span className="block truncate text-[11px] text-muted-foreground font-mono">
                        {a.accountNumber}
                      </span>
                    )}
                  </span>
                </span>
                <span className="shrink-0 flex items-center gap-1.5">
                  <span className="text-[12px] tabular-nums text-muted-foreground">
                    {fmtMoney(a.balance)}
                  </span>
                  {a.id === value && <Check className="h-3.5 w-3.5 text-primary" />}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
import { usePagination } from "@/hooks/usePagination";
import { usePeriodLock } from "@/hooks/usePeriodLock";
import {
  BankRepo,
  SalesRepo,
  PurchaseRepo,
  ExpenseRepo,
  PaymentRepo,
  BankTxnRepo,
  CashAdjustmentRepo,
} from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";
import { newBatch, commitBatch } from "@/repositories/base";
import { bankFlows, netFlow } from "@/lib/ledger";
import type { BankAccount } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/Field";
import { NumField } from "@/components/NumInput";
import { fmtMoney, today } from "@/lib/format";
import {
  Plus,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowLeftRight,
  History,
  Pencil,
  Landmark,
} from "lucide-react";
import { CashBankTransferDialog } from "@/components/CashBankTransferDialog";
import { toast } from "sonner";
import { usePermissions } from "@/hooks/usePermissions";

export const Route = createFileRoute("/bank")({ component: BankPage });

function BankPage() {
  const navigate = useNavigate();
  const { isOwner, canEdit, canDelete } = usePermissions();
  const editAllowed = isOwner || canEdit("cashBank");
  const deleteAllowed = isOwner || canDelete("cashBank");
  const [rows, setRows] = useState<BankAccount[]>([]);
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<BankAccount | null>(null);
  const [txnOpen, setTxnOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const refresh = () => setRows(BankRepo.all());
  const _repoV = useRepoData();
  useEffect(refresh, [_repoV]);

  const pg = usePagination(rows, "bank");

  const columns: Column<BankAccount>[] = [
    {
      key: "name",
      label: "Account Name",
      render: (r) => <span className="font-medium">{r.name}</span>,
    },
    {
      key: "acc",
      label: "Account No.",
      width: "180px",
      render: (r) => <span className="font-mono text-xs">{r.accountNumber ?? "—"}</span>,
    },
    {
      key: "ifsc",
      label: "IFSC",
      width: "120px",
      render: (r) => <span className="font-mono text-xs">{r.ifsc ?? "—"}</span>,
    },
    {
      key: "opening",
      label: "Opening",
      align: "right",
      width: "120px",
      render: (r) => fmtMoney(r.openingBalance),
    },
    {
      key: "balance",
      label: "Balance",
      align: "right",
      width: "140px",
      render: (r) => <span className="font-semibold">{fmtMoney(r.balance)}</span>,
    },
    {
      key: "actions",
      label: "Action",
      width: "80px",
      align: "center",
      render: (r) => (
        <span className="inline-flex items-center justify-center gap-0.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate({ to: "/bank/$id", params: { id: r.id } });
            }}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-primary-soft hover:text-primary hover:border-primary/25"
            title="View passbook / transaction history"
          >
            <History className="h-3.5 w-3.5" />
          </button>
          {editAllowed && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEdit(r);
                setOpen(true);
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-primary-soft hover:text-primary hover:border-primary/25"
              title="Edit account"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      ),
    },
  ];

  const accountsTotal = rows.reduce((s, r) => s + r.balance, 0);
  const openingTotal = rows.reduce((s, r) => s + r.openingBalance, 0);
  // All bank/UPI/cheque activity (sales, purchases, expenses, payments) affects the real balance
  const bankActivity = netFlow(
    bankFlows(SalesRepo.all(), PurchaseRepo.all(), ExpenseRepo.all(), PaymentRepo.all()),
  );
  const totalBalance = accountsTotal + bankActivity;

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Bank Accounts"
        subtitle={`${rows.length} accounts · Opening: ${fmtMoney(openingTotal)} · Bank transactions: ${bankActivity >= 0 ? "+" : "−"}${fmtMoney(Math.abs(bankActivity))} · Total: ${fmtMoney(totalBalance)}`}
        icon={<Landmark className="h-5 w-5" />}
        actions={
          <div className="flex flex-col sm:flex-row gap-1.5 sm:gap-2 w-full sm:w-auto">
            {rows.length > 0 && editAllowed && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setTxnOpen(true)}
                title="Deposit / Withdraw"
                className="w-full sm:w-auto"
              >
                <ArrowDownToLine className="h-3.5 w-3.5" /> Deposit / Withdraw
              </Button>
            )}
            {rows.length > 0 && editAllowed && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setTransferOpen(true)}
                title="Move money between cash and an account, or between two accounts"
                className="w-full sm:w-auto"
              >
                <ArrowLeftRight className="h-3.5 w-3.5" /> Transfer
              </Button>
            )}
            {editAllowed && (
              <Button
                size="sm"
                onClick={() => {
                  setEdit(null);
                  setOpen(true);
                }}
                className="w-full sm:w-auto"
              >
                <Plus className="h-3.5 w-3.5" /> New Account
              </Button>
            )}
          </div>
        }
      />
      {/* Mobile card list — a table of 5 columns doesn't fit a phone; this
          is the same data as one tappable card per account instead. */}
      <div className="md:hidden flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <Landmark className="h-10 w-10 mx-auto mb-3 text-gray-200" />
            <p className="font-medium">No bank accounts found</p>
            <p className="text-xs mt-1">Add a bank account to get started</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pg.paged.map((r) => (
              <div
                key={r.id}
                onClick={() => navigate({ to: "/bank/$id", params: { id: r.id } })}
                className="bg-white p-4 active:bg-gray-50"
              >
                <div className="flex items-start justify-between gap-3 mb-1.5">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-800 truncate">{r.name}</p>
                    <p className="text-xs text-gray-400 mt-0.5 truncate font-mono">
                      {r.accountNumber ?? "—"} · {r.ifsc ?? "—"}
                    </p>
                  </div>
                  <p className="font-bold text-gray-800 tabular-nums shrink-0">
                    {fmtMoney(r.balance)}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold text-gray-500">
                    Opening: {fmtMoney(r.openingBalance)}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate({ to: "/bank/$id", params: { id: r.id } });
                      }}
                      className="p-1.5 rounded hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition"
                      title="View passbook / transaction history"
                    >
                      <History className="h-3.5 w-3.5" />
                    </button>
                    {editAllowed && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEdit(r);
                          setOpen(true);
                        }}
                        className="p-1.5 rounded hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition"
                        title="Edit account"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Table (desktop) */}
      <div className="hidden md:flex flex-1 min-h-0 p-6">
        <DataTable
          storageKey="bank"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          activateOnClick
          onRowActivate={(r) => navigate({ to: "/bank/$id", params: { id: r.id } })}
          onDelete={(r) => {
            if (!deleteAllowed) {
              toast.error("You don't have permission to delete bank accounts");
              return;
            }
            // Deleting an account that still has money tied to it makes that
            // money vanish from every total: bank-mode sales/purchases/
            // payments/expenses keep pointing at the dead account (so they're
            // skipped from cash AND bank totals), its passbook 404s, and the
            // cash adjustments its past deposits created are left dangling.
            // Block until nothing references it.
            const used =
              BankTxnRepo.all().some((t) => t.bankId === r.id) ||
              PaymentRepo.all().some((p) => p.bankId === r.id) ||
              ExpenseRepo.all().some((e) => e.bankId === r.id) ||
              SalesRepo.all().some((i) => i.bankId === r.id) ||
              PurchaseRepo.all().some((i) => i.bankId === r.id);
            if (used) {
              toast.error(
                `Can't delete "${r.name}" — it has transactions, payments or bills linked to it. Reassign or remove those first.`,
              );
              return;
            }
            if (confirm(`Delete ${r.name}?`)) {
              BankRepo.remove(r.id);
              refresh();
            }
          }}
        />
      </div>
      <BankDialog open={open} onOpenChange={setOpen} bank={edit} onSaved={refresh} />
      <BankTxnDialog open={txnOpen} onOpenChange={setTxnOpen} accounts={rows} onSaved={refresh} />
      <CashBankTransferDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        onSaved={refresh}
      />
    </div>
  );
}

function BankTxnDialog({
  open,
  onOpenChange,
  accounts,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accounts: BankAccount[];
  onSaved: () => void;
}) {
  const [bankId, setBankId] = useState("");
  const { canPost } = usePeriodLock();
  const [type, setType] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState("");
  const [linkCash, setLinkCash] = useState(true);
  const [saving, setSaving] = useState(false);
  // Synchronous double-submit guard — the `saving` state doesn't flip until the
  // next render, so two rapid Enter presses in one tick would both deposit.
  const savingRef = useRef(false);

  useEffect(() => {
    if (open) {
      setBankId(accounts[0]?.id ?? "");
      setType("deposit");
      setAmount(0);
      setDate(today());
      setNotes("");
      setLinkCash(true);
      setSaving(false);
      savingRef.current = false;
    }
  }, [open, accounts]);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (savingRef.current) return;
    const n = amount;
    const bank = accounts.find((b) => b.id === bankId);
    if (!bank) {
      toast.error("Select a bank account");
      return;
    }
    if (!canPost(date)) return;
    if (n <= 0) {
      toast.error("Enter amount");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    // The passbook txn, the account balance change, and the linked cash
    // adjustment must land together or not at all — one shared batch commits
    // them atomically (a partial write, e.g. a cash reduction with no matching
    // balance move, would silently corrupt the totals). The balance change is
    // an atomic increment, NOT an absolute write off a stale in-memory
    // snapshot, so two devices moving money at once can't lose one another's
    // update (which is exactly what made the stored balance drift from the
    // derived passbook before).
    const batch = newBatch();
    const delta = type === "deposit" ? n : -n;
    BankTxnRepo.addBatched(batch, {
      bankId: bank.id,
      date,
      type,
      amount: n,
      notes: notes.trim() || undefined,
    });
    BankRepo.adjustFieldBatched(batch, bank.id, "balance", delta);
    if (linkCash) {
      // Deposit takes cash from the counter into the bank; withdrawal brings it back
      CashAdjustmentRepo.addBatched(batch, {
        date,
        type: type === "deposit" ? "reduce" : "add",
        amount: n,
        reason: `Bank ${type} — ${bank.name}`,
      });
    }
    commitBatch(batch, "bank txn");
    toast.success(
      `${type === "deposit" ? "Deposited" : "Withdrawn"} ${fmtMoney(n)} ${type === "deposit" ? "to" : "from"} ${bank.name}`,
    );
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Bank Deposit / Withdraw</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="space-y-3">
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="text-muted-foreground font-medium">Bank Account *</span>
            <select
              value={bankId}
              onChange={(e) => setBankId(e.target.value)}
              className="h-9 px-2 border rounded-md bg-background focus:border-primary outline-none"
            >
              {accounts.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} — {fmtMoney(b.balance)}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setType("deposit")}
              className={`flex-1 h-9 rounded-md border text-sm font-semibold transition inline-flex items-center justify-center gap-1.5 ${type === "deposit" ? "bg-success-soft text-success border-success" : "bg-background text-muted-foreground"}`}
            >
              <ArrowDownToLine className="h-3.5 w-3.5" /> Deposit
            </button>
            <button
              type="button"
              onClick={() => setType("withdraw")}
              className={`flex-1 h-9 rounded-md border text-sm font-semibold transition inline-flex items-center justify-center gap-1.5 ${type === "withdraw" ? "bg-destructive/10 text-destructive border-destructive" : "bg-background text-muted-foreground"}`}
            >
              <ArrowUpFromLine className="h-3.5 w-3.5" /> Withdraw
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <NumField label="Amount (₹) *" value={amount} onValue={setAmount} />
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
            placeholder="Reference, slip no…"
          />
          <label className="flex items-center gap-2 text-[13px] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={linkCash}
              onChange={(e) => setLinkCash(e.target.checked)}
              className="accent-primary"
            />
            <span>
              {type === "deposit"
                ? "Deposited from cash on hand (reduce counter cash)"
                : "Withdrawn to cash on hand (add counter cash)"}
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save Transaction"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BankDialog({
  open,
  onOpenChange,
  bank,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  bank: BankAccount | null;
  onSaved: () => void;
}) {
  const firstRef = useRef<HTMLInputElement>(null);
  const [f, setF] = useState<Partial<BankAccount>>({});
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  useEffect(() => {
    if (open) {
      setF(bank ?? { openingBalance: 0, balance: 0 });
      setSaving(false);
      savingRef.current = false;
      setTimeout(() => firstRef.current?.focus(), 50);
    }
  }, [open, bank]);
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (savingRef.current) return;
    if (!f.name?.trim()) {
      toast.error("Name required");
      return;
    }
    // Block duplicate accounts (same rule parties/items/payees enforce) — two
    // identical accounts are indistinguishable in every picker and let one be
    // deleted while the user thinks they deleted the other.
    const nameLc = f.name.trim().toLowerCase();
    const acctNo = (f.accountNumber ?? "").trim();
    const dup = BankRepo.all().find(
      (b) =>
        b.id !== bank?.id &&
        (b.name.trim().toLowerCase() === nameLc ||
          (!!acctNo && (b.accountNumber ?? "").trim() === acctNo)),
    );
    if (dup) {
      toast.error(
        acctNo && (dup.accountNumber ?? "").trim() === acctNo
          ? `Account number ${acctNo} already exists on "${dup.name}"`
          : `Bank account "${dup.name}" already exists — repeat accounts cannot be added`,
      );
      return;
    }
    savingRef.current = true;
    setSaving(true);
    if (bank) {
      // Stored balance = opening balance + net of all transactions. Correcting
      // the opening balance must shift the stored balance by the SAME delta,
      // applied as an ATOMIC increment (carried alongside the descriptive
      // fields via adjustField's `extra`) — NOT an absolute write off the
      // dialog's stale snapshot, which would clobber a sale/payment that landed
      // on this account while the dialog was open. Mirrors items.tsx opening-stock.
      const openingDelta = (f.openingBalance ?? 0) - (bank.openingBalance ?? 0);
      const descriptive: Partial<BankAccount> = { ...f };
      delete descriptive.balance; // balance only ever changes via atomic increments
      BankRepo.adjustField(bank.id, "balance", openingDelta, descriptive);
    } else
      BankRepo.add({
        ...f,
        name: f.name!,
        openingBalance: f.openingBalance ?? 0,
        balance: f.openingBalance ?? 0,
      });
    toast.success("Saved");
    onSaved();
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{bank ? "Edit" : "New"} Bank Account</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <Field
              ref={firstRef}
              label="Bank Name *"
              value={f.name ?? ""}
              onChange={(e) => setF({ ...f, name: e.target.value })}
            />
          </div>
          <Field
            label="Account Number"
            value={f.accountNumber ?? ""}
            onChange={(e) => setF({ ...f, accountNumber: e.target.value })}
          />
          <Field
            label="IFSC"
            value={f.ifsc ?? ""}
            onChange={(e) => setF({ ...f, ifsc: e.target.value.toUpperCase() })}
          />
          <NumField
            label="Opening Balance"
            value={f.openingBalance ?? 0}
            onValue={(n) => setF({ ...f, openingBalance: n })}
          />
          <div className="sm:col-span-2 flex justify-end gap-2 mt-2">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

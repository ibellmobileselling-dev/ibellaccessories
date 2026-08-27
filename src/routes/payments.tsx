import { createFileRoute } from "@tanstack/react-router";
import { matchesQuery } from "@/lib/search";
import { useEffect, useRef, useState } from "react";
import {
  PaymentRepo,
  PartyRepo,
  SalesRepo,
  PurchaseRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  BankRepo,
} from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";
import { newBatch, commitBatch } from "@/repositories/base";
import type { Payment, PaymentAllocation, PaymentMode, Invoice, BankAccount, Party } from "@/types";
import { fmtMoney, fmtDate, today, fmtDateShort } from "@/lib/format";
import { netPartyPositions, spreadFifo } from "@/lib/ledger";
import {
  ArrowDownCircle,
  ArrowUpCircle,
  Wallet,
  Trash2,
  Search,
  CheckCircle2,
  Circle,
  AlertCircle,
  ChevronRight,
  Loader2,
  Pencil,
  SlidersHorizontal,
} from "lucide-react";
import { usePermissions } from "@/hooks/usePermissions";
import { VoidDialog, VoidedBadge } from "@/components/VoidDialog";
import {
  canDeleteOutright,
  canEditInPlace,
  editRefusalMessage,
  isVoided,
  removalWord,
} from "@/lib/voiding";
import { Ban } from "lucide-react";
import { toast } from "sonner";
import { genId } from "@/repositories/base";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/DataTable";
import { usePagination } from "@/hooks/usePagination";
import { usePeriodLock } from "@/hooks/usePeriodLock";
import { NumInput } from "@/components/NumInput";
import { ModePills } from "@/components/ModePills";
import { fmtMode } from "@/lib/paymentMode";
import { PageHeader } from "@/components/PageHeader";

export const Route = createFileRoute("/payments")({ component: PaymentsPage });

type Tab = "all" | "in" | "out";
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Reverse a legacy payment's invoice application. Legacy payments (from
 * before per-invoice `allocations` existed) stored only a lump `amount` and a
 * comma-separated list of invoice numbers in `ref`, with no record of the
 * per-invoice split. Distribute the reversal proportionally to each invoice's
 * CURRENT paid amount — the closest fair approximation, and (unlike a fixed
 * per-invoice amount in list order) it never leaves a remainder silently
 * undone when an invoice's paid has since dropped. Shared by BOTH delete and
 * edit so the two paths can never diverge — the edit path previously had no
 * legacy reversal at all, which double-counted the money on save. */
function reverseLegacyRefApplication(
  batch: ReturnType<typeof newBatch>,
  repo: typeof SalesRepo,
  ref: string,
  amount: number,
) {
  const tokens = ref
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const all = repo.all();
  const invoices = tokens
    .map((t) => all.find((i) => i.number === t))
    .filter((i): i is Invoice => !!i && i.paid > 0);
  const totalPaid = invoices.reduce((s, inv) => s + inv.paid, 0);
  const totalReverse = Math.min(amount, totalPaid);
  if (totalReverse <= 0) return;
  for (const inv of invoices) {
    const take = Math.min(inv.paid, r2((inv.paid / totalPaid) * totalReverse));
    // Atomic decrement (not an absolute write): in the EDIT path the same
    // invoice may also be freshly re-applied below, and two increments on one
    // doc compose correctly where an absolute set + an increment would race.
    if (take > 0) repo.adjustFieldBatched(batch, inv.id, "paid", -take);
  }
}

function PaymentsPage() {
  const { isOwner, canEdit, canDelete } = usePermissions();
  const editAllowed = isOwner || canEdit("cashBank");
  const deleteAllowed = isOwner || canDelete("cashBank");
  const [rows, setRows] = useState<Payment[]>([]);
  const [tab, setTab] = useState<Tab>("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [formType, setFormType] = useState<"in" | "out">("in");
  const [editing, setEditing] = useState<Payment | null>(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const { canPost } = usePeriodLock();

  // Cancelled payments stay on file; this only decides whether they are in
  // the way.
  const [showVoided, setShowVoided] = useState(false);
  const [voiding, setVoiding] = useState<Payment | null>(null);
  const refresh = () =>
    setRows(
      (showVoided ? PaymentRepo.allWithVoided() : PaymentRepo.all()).sort((a, b) =>
        b.date.localeCompare(a.date),
      ),
    );
  const _repoV = useRepoData();
  useEffect(refresh, [_repoV, showVoided]);

  const filtered = rows.filter((r) => {
    if (tab !== "all" && r.type !== tab) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!matchesQuery(q, r.partyName, r.ref)) return false;
    }
    return true;
  });

  const pg = usePagination(filtered, "payments");

  // Footer totals cover the same rows the table shows (tab + search applied)
  const totalIn = filtered.filter((r) => r.type === "in").reduce((s, r) => s + r.amount, 0);
  const totalOut = filtered.filter((r) => r.type === "out").reduce((s, r) => s + r.amount, 0);
  const net = totalIn - totalOut;

  const openForm = (type: "in" | "out") => {
    setFormType(type);
    setEditing(null);
    setOpen(true);
  };
  const openEdit = (r: Payment) => {
    // One door for the pencil AND for clicking the row. Guarding the button
    // alone would leave the row itself wide open.
    if (!canEditInPlace(r.date)) {
      toast.error(editRefusalMessage("payment"), { duration: 7000 });
      return;
    }
    setFormType(r.type);
    setEditing(r);
    setOpen(true);
  };
  const handleDelete = (r: Payment) => {
    if (!deleteAllowed) {
      toast.error("You don't have permission to delete payments");
      return;
    }
    if (!canPost(r.date)) return;
    // Anything dated before today is cancelled, not destroyed — its month has
    // already been counted. See lib/voiding.ts.
    if (!canDeleteOutright(r.date)) {
      const existing = PaymentRepo.get(r.id);
      if (!existing) {
        toast.info("This payment is no longer there");
        refresh();
        return;
      }
      if (isVoided(existing)) {
        toast.info("This payment is already voided");
        return;
      }
      setVoiding(existing);
      return;
    }
    if (!confirm("Delete this payment record? Amounts applied to invoices/bills will be reversed."))
      return;
    // Bail if another device already deleted this payment — the invoice-paid
    // and bank reversals below are blind atomic decrements, so running them a
    // second time would reverse the money twice. Reverse from the LIVE record.
    const live = PaymentRepo.get(r.id);
    if (!live) {
      toast.info("This payment was already deleted");
      refresh();
      return;
    }
    const batch = newBatch();
    undoPaymentEffects(batch, live);
    PaymentRepo.removeBatched(batch, live.id);
    commitBatch(batch, "delete payment");
    refresh();
    toast.success("Payment deleted");
  };

  /**
   * What a payment did to the bills it settled and to a bank balance, undone.
   *
   * Shared by delete and void: they owe the shop exactly the same reversals,
   * and a second copy would drift from this one silently.
   */
  const undoPaymentEffects = (batch: ReturnType<typeof newBatch>, live: Payment) => {
    const repo = live.type === "in" ? SalesRepo : PurchaseRepo;
    if (live.allocations?.length) {
      for (const a of live.allocations) {
        // Cash plus any write-off — the same total that was added to `paid`.
        if (repo.get(a.invoiceId))
          repo.adjustFieldBatched(batch, a.invoiceId, "paid", -(a.amount + (a.discount ?? 0)));
      }
    } else if (live.ref) {
      reverseLegacyRefApplication(batch, repo, live.ref, live.amount);
    }
    if (live.mode === "bank" && live.bankId && BankRepo.get(live.bankId)) {
      BankRepo.adjustFieldBatched(
        batch,
        live.bankId,
        "balance",
        live.type === "in" ? -live.amount : live.amount,
      );
    }
  };

  const handleVoid = (live: Payment, reason: string) => {
    const batch = newBatch();
    undoPaymentEffects(batch, live);
    if (!PaymentRepo.voidBatched(batch, live.id, reason)) {
      toast.info("This payment was already voided");
      setVoiding(null);
      return;
    }
    commitBatch(batch, "void payment");
    setVoiding(null);
    refresh();
    toast.success("Payment voided — it stays on record");
  };

  const columns: Column<Payment>[] = [
    {
      key: "date",
      label: "Date",
      width: "82px",
      // Short form here: this table carries eight columns, and "24 Aug 2026"
      // spent width the Action buttons were then pushed off the edge for.
      render: (r) => <span className="whitespace-nowrap">{fmtDateShort(r.date)}</span>,
      sortValue: (r) => r.date,
    },
    {
      key: "type",
      label: "Type",
      width: "120px",
      render: (r) => (r.type === "in" ? "Received" : "Paid Out"),
      sortValue: (r) => r.type,
    },
    {
      key: "party",
      label: "Party",
      render: (r) => r.partyName,
      sortValue: (r) => r.partyName,
    },
    {
      key: "linked",
      label: "Linked Invoice / Bill",
      render: (r) => (
        <span className="font-mono text-xs">
          {r.allocations?.length ? (
            r.allocations.map((a) => a.number).join(", ")
          ) : r.ref && r.ref.match(/^(INV|PUR)-/) ? (
            r.ref
          ) : (
            <span className="text-gray-400">—</span>
          )}
        </span>
      ),
    },
    {
      key: "mode",
      label: "Mode",
      width: "90px",
      render: (r) => <span className="text-gray-600">{fmtMode(r.mode)}</span>,
    },
    {
      key: "ref",
      label: "Reference",
      render: (r) => (
        <span className="font-mono text-gray-500">
          {r.ref && (r.allocations?.length || !r.ref.match(/^(INV|PUR)-/)) ? r.ref : "—"}
        </span>
      ),
    },
    {
      key: "amount",
      label: "Amount",
      width: "150px",
      align: "right",
      render: (r) => (
        <span className="tabular-nums">
          {r.type === "out" ? "−" : "+"}
          {fmtMoney(r.amount)}
        </span>
      ),
      sortValue: (r) => (r.type === "in" ? r.amount : -r.amount),
    },
    {
      key: "actions",
      label: "Action",
      width: "70px",
      align: "center",
      render: (r) => (
        <span className="inline-flex items-center justify-center gap-0.5">
          {editAllowed && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                openEdit(r);
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-primary-soft hover:text-primary hover:border-primary/25"
              title={canEditInPlace(r.date) ? "Edit payment" : editRefusalMessage("payment")}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {deleteAllowed && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDelete(r);
              }}
              className="p-1 rounded hover:bg-rose-50 text-gray-400 hover:text-rose-500 transition"
              title={`${removalWord(r.date)} payment`}
            >
              {canDeleteOutright(r.date) ? (
                <Trash2 className="h-3.5 w-3.5" />
              ) : (
                <Ban className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col h-full bg-[#f5f6fa]">
      <PageHeader
        title="Payments"
        subtitle={`${rows.length} records`}
        icon={<Wallet className="h-5 w-5" />}
        mobileAction={
          <button
            onClick={() => setMobileFiltersOpen(true)}
            className="relative h-9 w-9 flex items-center justify-center rounded-lg border border-gray-200 bg-gray-50/60 text-gray-600"
            title="Filters"
          >
            <SlidersHorizontal className="h-4 w-4" />
            {tab !== "all" && (
              <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-primary" />
            )}
          </button>
        }
        actions={
          <>
            <button
              onClick={() => setShowVoided((v) => !v)}
              className={`hidden sm:inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border text-xs transition ${
                showVoided
                  ? "border-rose-200 bg-rose-50 text-rose-700 font-semibold"
                  : "border-gray-200 bg-gray-50/60 text-gray-500 hover:bg-gray-100"
              }`}
              title="Cancelled records stay on file — this decides whether they are in the way"
            >
              <Ban className="h-3.5 w-3.5" /> Voided
            </button>
            {/* Tabs — its own filter sheet on mobile (see Filters button
                above); this inline row is desktop only. */}
            <div className="hidden sm:flex items-center gap-0.5 h-9 border border-gray-200 rounded-lg p-0.5 bg-gray-50/60">
              {(["all", "in", "out"] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-2.5 h-7 rounded-md text-xs font-semibold transition ${
                    tab === t
                      ? t === "in"
                        ? "bg-emerald-50 text-emerald-700"
                        : t === "out"
                          ? "bg-rose-50 text-rose-700"
                          : "bg-primary text-primary-foreground"
                      : "text-gray-500 hover:bg-gray-100"
                  }`}
                >
                  {t === "all" ? "All" : t === "in" ? "Received (In)" : "Paid Out"}
                </button>
              ))}
            </div>

            {/* Search — kept inline on every screen size */}
            <div className="relative w-full sm:w-48">
              <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search party, reference…"
                className="w-full h-9 pl-9 pr-3 rounded-lg border border-gray-200 bg-gray-50/60 text-base md:text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/20 focus:bg-white transition"
              />
            </div>

            {editAllowed && (
              <button
                onClick={() => openForm("in")}
                className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 h-9 px-3 bg-emerald-600 text-white rounded-lg text-sm font-semibold hover:bg-emerald-700 transition"
              >
                <ArrowDownCircle className="h-4 w-4" /> Receive Payment
              </button>
            )}
            {editAllowed && (
              <button
                onClick={() => openForm("out")}
                className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 h-9 px-3 bg-rose-600 text-white rounded-lg text-sm font-semibold hover:bg-rose-700 transition"
              >
                <ArrowUpCircle className="h-4 w-4" /> Make Payment
              </button>
            )}
          </>
        }
      />

      {/* Mobile filter sheet — the In/Out tabs don't fit inline next to
          Search on a phone, so they live here behind the header's Filters
          button instead, same state as the desktop inline tabs. */}
      <Dialog open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Filters</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-gray-500 block mb-1.5">Type</label>
              <div className="flex items-center gap-1 border border-gray-200 rounded-lg p-1 bg-gray-50/60">
                {(["all", "in", "out"] as Tab[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`flex-1 h-8 rounded-md text-xs font-semibold transition ${
                      tab === t
                        ? t === "in"
                          ? "bg-emerald-50 text-emerald-700"
                          : t === "out"
                            ? "bg-rose-50 text-rose-700"
                            : "bg-primary text-primary-foreground"
                        : "text-gray-500 hover:bg-gray-100"
                    }`}
                  >
                    {t === "all" ? "All" : t === "in" ? "Received" : "Paid Out"}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-end pt-1">
              <button
                onClick={() => setMobileFiltersOpen(false)}
                className="h-8 px-4 bg-primary text-primary-foreground rounded-md text-sm font-semibold hover:opacity-90 transition"
              >
                Done
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Mobile card list — a table of 8 columns doesn't fit a phone; this
          is the same data as one tappable card per payment instead. */}
      <div className="md:hidden flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <Wallet className="h-10 w-10 mx-auto mb-3 text-gray-200" />
            <p className="font-medium">No payments found</p>
            <p className="text-xs mt-1">
              Try adjusting filters or use the buttons above to record one
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pg.paged.map((r) => {
              const isIn = r.type === "in";
              const refText = r.allocations?.length
                ? r.allocations.map((a) => a.number).join(", ")
                : r.ref && r.ref.match(/^(INV|PUR)-/)
                  ? r.ref
                  : "";
              return (
                <div
                  key={r.id}
                  onClick={() => openEdit(r)}
                  className="bg-white px-4 py-3 active:bg-gray-50 flex items-center gap-3"
                >
                  <div
                    className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${isIn ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"}`}
                  >
                    {isIn ? (
                      <ArrowDownCircle className="h-4 w-4" />
                    ) : (
                      <ArrowUpCircle className="h-4 w-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-[13px] text-gray-800 truncate leading-tight">
                        {r.partyName}
                      </p>
                      <p
                        className={`font-bold text-[13px] tabular-nums shrink-0 leading-tight ${isIn ? "text-emerald-600" : "text-rose-600"}`}
                      >
                        {isIn ? "+" : "−"}
                        {fmtMoney(r.amount)}
                      </p>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-1">
                      <p className="text-[11px] text-gray-400 truncate">
                        {fmtDate(r.date)} · {isIn ? "Received" : "Paid Out"} · {fmtMode(r.mode)}
                      </p>
                      {refText && (
                        <span className="font-mono text-[11px] text-gray-400 truncate shrink-0 max-w-[38%]">
                          {refText}
                        </span>
                      )}
                    </div>
                  </div>
                  {(editAllowed || deleteAllowed) && (
                    <div className="flex flex-col gap-0.5 shrink-0 -mr-1.5">
                      {editAllowed && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openEdit(r);
                          }}
                          className="p-1.5 rounded hover:bg-blue-50 text-gray-300 hover:text-blue-600 transition"
                          title={
                            canEditInPlace(r.date) ? "Edit payment" : editRefusalMessage("payment")
                          }
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {deleteAllowed && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(r);
                          }}
                          className="p-1.5 rounded hover:bg-rose-50 text-gray-300 hover:text-rose-500 transition"
                          title={`${removalWord(r.date)} payment`}
                        >
                          {canDeleteOutright(r.date) ? (
                            <Trash2 className="h-3.5 w-3.5" />
                          ) : (
                            <Ban className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Table (desktop) */}
      <div className="hidden md:flex flex-1 min-h-0 p-6">
        <DataTable
          storageKey="payments"
          activateOnClick
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.id}
          onRowActivate={openEdit}
          onDelete={handleDelete}
          emptyMessage="No payments recorded — use the buttons above to record one"
          footer={
            <tr>
              <td colSpan={6}>
                Received <span className="text-gray-300">|</span>{" "}
                <span className="tabular-nums">{fmtMoney(totalIn)}</span>
                <span className="text-gray-300"> · </span>
                Paid Out <span className="text-gray-300">|</span>{" "}
                <span className="tabular-nums">{fmtMoney(totalOut)}</span>
              </td>
              <td className="text-right tabular-nums">{fmtMoney(net)}</td>
              <td />
            </tr>
          }
        />
      </div>

      <ReceivePaymentDialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) setEditing(null);
        }}
        type={formType}
        editing={editing}
        onSaved={refresh}
      />

      <VoidDialog
        open={!!voiding}
        onOpenChange={(v) => !v && setVoiding(null)}
        what="this payment"
        effects={[
          "Amounts applied to bills go back to being unpaid",
          ...(voiding?.mode === "bank" && voiding?.bankId
            ? ["The bank account it moved is put back"]
            : []),
        ]}
        onConfirm={(reason) => voiding && handleVoid(voiding, reason)}
      />
    </div>
  );
}

/* ─── Proper Payment Dialog ──────────────────────────────────────────── */

interface ApplyRow {
  invoice: Invoice;
  due: number;
  apply: number;
  /** Written off on this bill so it can be closed without the last few
   * rupees ever arriving — see PaymentAllocation.discount. */
  discount: number;
  checked: boolean;
}

function ReceivePaymentDialog({
  open,
  onOpenChange,
  type,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  type: "in" | "out";
  editing: Payment | null;
  onSaved: () => void;
}) {
  const isIn = type === "in";
  const partyRef = useRef<HTMLInputElement>(null);
  // Refreshed every time the dialog opens (not memoized once) — otherwise a
  // party created by an earlier payment in this same session (e.g. a
  // walk-in customer typed by name) would never show up in the dedupe
  // lookup or the search suggestions, creating a duplicate Party record.
  const [allParties, setAllParties] = useState<Party[]>([]);

  const [partyQ, setPartyQ] = useState("");
  const [partyOpen, setPartyOpen] = useState(false);
  const [partyIdx, setPartyIdx] = useState(0);
  const [selectedParty, setSelectedParty] = useState<{ id: string; name: string } | null>(null);

  const [date, setDate] = useState(today());
  const [mode, setMode] = useState<PaymentMode>("cash");
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [bankId, setBankId] = useState("");
  const [bankQ, setBankQ] = useState("");
  const [bankOpen, setBankOpen] = useState(false);
  const [bankIdx, setBankIdx] = useState(0);
  const [applyRows, setApplyRows] = useState<ApplyRow[]>([]);
  const [manualAmount, setManualAmount] = useState(0);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const { canPost } = usePeriodLock();

  /* Quick entry vs bill-by-bill.
   *
   * The counter takes one amount off a customer against everything they owe;
   * they do not think in invoices, and making them tick boxes and type into
   * one box per bill was the slow, error-prone part of this screen. Quick
   * entry asks for the amount (and any discount) once and settles the OLDEST
   * bills first, which is what "paying off the account" means everywhere.
   *
   * Bill-by-bill is still one click away for the cases FIFO cannot know
   * about — "this cheque is specifically for INV-0042". Editing an existing
   * payment always opens there, because a recorded allocation is a decision
   * someone already made and re-spreading it silently would rewrite history. */
  const [allocMode, setAllocMode] = useState<"auto" | "manual">("auto");
  const [payAmount, setPayAmount] = useState(0);
  const [payDiscount, setPayDiscount] = useState(0);

  // Archived parties are hidden from the picker; the full `allParties` list is
  // still used for save-time dedup (which auto-restores an archived match).
  const activeParties = allParties.filter((p) => !p.archived);
  const suggests = partyQ.trim()
    ? activeParties.filter((p) => p.name.toLowerCase().includes(partyQ.toLowerCase())).slice(0, 6)
    : activeParties.slice(0, 6);

  const bankSuggests = bankQ.trim()
    ? banks.filter(
        (b) =>
          b.name.toLowerCase().includes(bankQ.toLowerCase()) ||
          (b.accountNumber ?? "").toLowerCase().includes(bankQ.toLowerCase()),
      )
    : banks;
  const selectBank = (b: BankAccount) => {
    setBankId(b.id);
    setBankQ(b.name);
    setBankOpen(false);
  };

  // Reset (or prefill when editing) on open
  useEffect(() => {
    if (open) {
      setAllParties(PartyRepo.all());
      setBanks(BankRepo.all());
      if (editing) {
        setPartyQ(editing.partyName);
        setSelectedParty({ id: editing.partyId, name: editing.partyName });
        setDate(editing.date);
        setMode(editing.mode);
        setBankId(editing.bankId ?? "");
        setBankQ(BankRepo.all().find((b) => b.id === editing.bankId)?.name ?? "");
        setManualAmount(editing.allocations?.length ? 0 : editing.amount);
        setAllocMode("manual");
        setPayAmount(editing.amount);
        setPayDiscount(r2((editing.allocations ?? []).reduce((s, a) => s + (a.discount ?? 0), 0)));
      } else {
        setPartyQ("");
        setSelectedParty(null);
        setDate(today());
        setMode("cash");
        setBankId("");
        setBankQ("");
        setManualAmount(0);
        setAllocMode("auto");
        setPayAmount(0);
        setPayDiscount(0);
        setTimeout(() => partyRef.current?.focus(), 60);
      }
      setApplyRows([]);
      setSaving(false);
      savingRef.current = false;
    }
  }, [open, editing]);

  // Load invoices/bills when party selected. When editing, this payment's own
  // allocations are added back to each invoice's due and pre-selected.
  useEffect(() => {
    if (!selectedParty) {
      setApplyRows([]);
      return;
    }
    const repo = isIn ? SalesRepo : PurchaseRepo;
    const allocOf = new Map((editing?.allocations ?? []).map((a) => [a.invoiceId, a.amount]));
    const discOf = new Map((editing?.allocations ?? []).map((a) => [a.invoiceId, a.discount ?? 0]));
    const invoices = repo
      .all()
      .filter(
        (inv) =>
          inv.partyId === selectedParty.id &&
          (r2(inv.total - inv.paid) > 0.01 || allocOf.has(inv.id)),
      )
      .sort((a, b) => a.date.localeCompare(b.date));
    setApplyRows(
      invoices.map((inv) => {
        const back = allocOf.get(inv.id) ?? 0;
        const backDisc = discOf.get(inv.id) ?? 0;
        return {
          invoice: inv,
          // Both the cash AND the discount this payment previously settled
          // have to come back onto the due, or reopening the dialog would
          // show the bill as already closed and silently drop the write-off.
          due: r2(inv.total - inv.paid + back + backDisc),
          apply: back,
          discount: backDisc,
          checked: back > 0 || backDisc > 0,
        };
      }),
    );
  }, [selectedParty, isIn, editing]);

  // Quick entry: re-spread the amount over the bills whenever it, the
  // discount, or the bill list changes. Returning the previous array
  // unchanged when nothing moved is what stops this looping — the effect
  // depends on the rows it writes.
  useEffect(() => {
    if (allocMode !== "auto") return;
    setApplyRows((rows) => {
      const spread = spreadFifo(
        rows.map((r) => r.due),
        payAmount,
        payDiscount,
      );
      let changed = false;
      const next = rows.map((r, i) => {
        const s = spread[i];
        const checked = s.apply > 0 || s.discount > 0;
        if (r.apply === s.apply && r.discount === s.discount && r.checked === checked) return r;
        changed = true;
        return { ...r, apply: s.apply, discount: s.discount, checked };
      });
      return changed ? next : rows;
    });
  }, [allocMode, payAmount, payDiscount, applyRows]);

  const selectParty = (p: { id: string; name: string }) => {
    setSelectedParty(p);
    setPartyQ(p.name);
    setPartyOpen(false);
  };

  const totalOutstanding = applyRows.reduce((s, r) => s + r.due, 0);
  // The invoice-level "due" total above misses debt that isn't tied to any
  // invoice at all — most commonly a party's opening balance carried over
  // from before this system was used. Without this, a party who owes only
  // an opening balance (no unpaid invoices) would show "₹0.00 outstanding /
  // no invoices" here even though the Dashboard and their own statement
  // correctly show they owe money.
  const partyTrueBalance = (() => {
    if (!selectedParty) return 0;
    const party = PartyRepo.get(selectedParty.id);
    if (!party) return 0;
    // ONE signed net for the party, not a receivable total and a payable
    // total worked out separately.
    //
    // This screen used to run partyBalances over one side at a time — sales
    // for a receipt, purchases for a payment — and an opening balance is
    // counted by both. So a party carrying ₹2,000 showed "OUTSTANDING
    // RECEIVABLE ₹2,000" on Receive Payment and "OUTSTANDING PAYABLE ₹2,000"
    // on Make Payment: the same ₹2,000, offered twice, in opposite
    // directions. The same double-count the Dashboard had, and the same fix.
    const [position] = netPartyPositions([party], {
      sales: SalesRepo.all(),
      purchases: PurchaseRepo.all(),
      saleReturns: SaleReturnRepo.all(),
      purchaseReturns: PurchaseReturnRepo.all(),
      payments: PaymentRepo.all(),
    });
    const net = position?.net ?? 0;
    // Positive = they owe us. Only the side this dialog is actually for has
    // anything outstanding; the other side is nil, and says so.
    return Math.max(0, isIn ? net : -net);
  })();
  // Portion of the true balance not already represented by an open invoice
  // row above (e.g. opening balance, or a manual ledger correction).
  const unlinkedBalance = Math.max(0, r2(partyTrueBalance - totalOutstanding));
  /** Everything this party owes — open bills PLUS anything carried outside
   *  them, such as an opening balance. What "pay in full" has to mean. */
  const totalDue = r2(totalOutstanding + unlinkedBalance);
  const totalApplied = r2(applyRows.reduce((s, r) => s + r.apply, 0));
  const totalDiscount = r2(applyRows.reduce((s, r) => s + r.discount, 0));
  // Advance / general payment whenever nothing is actually applied to an
  // invoice — not just when there are no open invoices at all. Without this,
  // editing an old advance payment for a party that has since accrued open
  // invoices would populate an all-unchecked list, drive this to 0, hide the
  // manual amount field (it was only shown when applyRows.length===0), and
  // permanently block saving.
  // In quick entry the CASH TAKEN is what the shopkeeper typed, not the part
  // of it that happened to land on a bill: hand over 25,000 against 20,000 of
  // open bills and the extra 5,000 is a real advance that must be recorded,
  // not quietly dropped from the receipt.
  const effectiveAmount =
    allocMode === "auto" ? payAmount : totalApplied > 0 ? totalApplied : manualAmount;
  const advanceLeft = Math.max(0, r2(payAmount - totalApplied));
  const unusedDiscount = Math.max(0, r2(payDiscount - totalDiscount));

  const toggleRow = (idx: number) => {
    setApplyRows((rows) =>
      rows.map((r, i) => {
        if (i !== idx) return r;
        const checked = !r.checked;
        return { ...r, checked, apply: checked ? r2(r.due - r.discount) : 0 };
      }),
    );
  };

  const setApply = (idx: number, num: number) => {
    setApplyRows((rows) =>
      rows.map((r, i) =>
        i === idx
          ? {
              ...r,
              // Cash + discount can never settle more than the bill owes.
              apply: Math.min(r2(r.due - r.discount), Math.max(0, num)),
              checked: num > 0 || r.discount > 0,
            }
          : r,
      ),
    );
  };

  /** Write-off on one bill. Capped at what's left after the cash applied, so
   * a bill can be closed exactly — never over-settled into a phantom credit. */
  const setRowDiscount = (idx: number, num: number) => {
    setApplyRows((rows) =>
      rows.map((r, i) =>
        i === idx
          ? {
              ...r,
              discount: Math.min(r2(r.due - r.apply), Math.max(0, num)),
              checked: r.apply > 0 || num > 0,
            }
          : r,
      ),
    );
  };

  const applyAll = () => {
    setApplyRows((rows) =>
      rows.map((r) => ({ ...r, checked: true, apply: r2(r.due - r.discount) })),
    );
  };

  const clearAll = () => {
    setApplyRows((rows) => rows.map((r) => ({ ...r, checked: false, apply: 0, discount: 0 })));
  };

  const save = () => {
    if (savingRef.current) return; // double-click protection
    if (!selectedParty && !partyQ.trim()) {
      toast.error("Select or enter a party");
      return;
    }
    if (!date) {
      toast.error("Enter a payment date");
      return;
    }
    if (!canPost(date, editing?.date)) return;
    const amount = effectiveAmount;
    if ((!amount || amount <= 0) && totalDiscount <= 0) {
      toast.error("Enter or select an amount to pay");
      return;
    }
    if (mode === "bank" && !bankId) {
      toast.error("Select which bank account this goes to");
      return;
    }
    savingRef.current = true;
    setSaving(true);

    // Wrapped so an unexpected failure partway through (reversing an old
    // allocation, applying new ones, persisting the Payment record) can't
    // leave the Confirm button permanently stuck disabled/spinning — saving
    // state is only otherwise reset by the dialog's open effect.
    try {
      // Party creation, invoice-paid changes, bank-balance changes, and the
      // Payment record itself must all land together — a shared batch
      // commits them atomically instead of independent writes that could
      // partially fail (e.g. money moves on the bank account but the
      // invoice never shows as paid).
      const batch = newBatch();

      let partyId = selectedParty?.id ?? "";
      const partyName = selectedParty?.name ?? partyQ.trim();
      if (!partyId) {
        const match = allParties.find((p) => p.name.toLowerCase() === partyName.toLowerCase());
        partyId = match?.id ?? genId();
        if (!match)
          PartyRepo.addBatched(batch, {
            id: partyId,
            name: partyName,
            type: "both",
            openingBalance: 0,
          });
      }
      // Recording a NEW payment against an archived party reactivates them —
      // restore in the same batch (matches the sale/purchase form). Only for a
      // new payment: editing an existing payment whose party is already
      // archived must not silently un-archive it.
      if (!editing && partyId && PartyRepo.get(partyId)?.archived) {
        PartyRepo.updateBatched(batch, partyId, { archived: false });
      }

      const repo = isIn ? SalesRepo : PurchaseRepo;

      // Editing: first reverse this payment's previous applications (atomic).
      // Both the allocations model AND the legacy ref model must be handled —
      // a legacy payment being edited previously reversed NOTHING here, so the
      // new allocation was applied on top of the old lump, overstating each
      // invoice's paid. The legacy branch below fixes that; `ref: undefined`
      // in the update patch then migrates the record cleanly to allocations.
      if (editing?.allocations?.length) {
        for (const a of editing.allocations) {
          // Reverse the full settlement — cash plus any amount written off —
          // because that is what was added to `paid` when it was saved.
          if (repo.get(a.invoiceId))
            repo.adjustFieldBatched(batch, a.invoiceId, "paid", -(a.amount + (a.discount ?? 0)));
        }
      } else if (editing?.ref) {
        reverseLegacyRefApplication(batch, repo, editing.ref, editing.amount);
      }
      // Editing: reverse the old bank-account effect too, before applying
      // the new one below — handles both "same account, new amount" and
      // "switched to a different account" correctly.
      if (editing?.mode === "bank" && editing.bankId && BankRepo.get(editing.bankId)) {
        BankRepo.adjustFieldBatched(
          batch,
          editing.bankId,
          "balance",
          editing.type === "in" ? -editing.amount : editing.amount,
        );
      }

      // Apply to invoices — atomic increments so simultaneous cashiers both count.
      // row.due/row.apply were computed from a snapshot taken when the party
      // was selected, which can go stale if another payment lands on the same
      // invoice before this one saves (this payment's own prior allocation was
      // already reversed above, so `cur` here reflects that reversal too) —
      // re-check against the live due right before applying so paid can never
      // be pushed past total.
      const allocations: PaymentAllocation[] = [];
      let clamped = false;
      for (const row of applyRows) {
        if (row.apply > 0 || row.discount > 0) {
          const cur = repo.get(row.invoice.id);
          if (!cur) continue;
          const liveDue = Math.max(0, r2(cur.total - cur.paid));
          // Cash first, then the write-off fills whatever is left of the due.
          const amt = Math.min(r2(row.apply), liveDue);
          const disc = Math.min(r2(row.discount), Math.max(0, r2(liveDue - amt)));
          const settled = r2(amt + disc);
          if (settled <= 0) continue;
          if (amt < r2(row.apply) || disc < r2(row.discount)) clamped = true;
          // `paid` moves by the whole settlement so the bill closes, while the
          // Payment's own `amount` (cash) is what reaches cash/bank.
          repo.adjustFieldBatched(batch, cur.id, "paid", settled);
          allocations.push({
            invoiceId: cur.id,
            number: cur.number,
            amount: amt,
            discount: disc > 0 ? disc : undefined,
          });
        }
      }
      if (clamped) {
        toast.warning(
          "Some amounts were reduced — one or more invoices had already been partly paid elsewhere",
        );
      }

      // Move money on the selected bank account for this (new) payment.
      if (mode === "bank" && bankId) {
        BankRepo.adjustFieldBatched(batch, bankId, "balance", isIn ? amount : -amount);
      }

      // Record payment
      if (editing) {
        PaymentRepo.updateBatched(batch, editing.id, {
          date,
          partyId,
          partyName,
          type,
          amount: r2(amount),
          mode,
          bankId: mode === "bank" ? bankId : undefined,
          allocations: allocations.length ? allocations : undefined,
          // Clear any legacy `ref` — its application was just reversed above,
          // so leaving it would double-count on the NEXT edit/delete and show
          // a stale linked-invoice list. The record is now allocations-based.
          ref: undefined,
        });
      } else {
        const payment: Payment = {
          id: genId(),
          date,
          partyId,
          partyName,
          type,
          amount: r2(amount),
          mode,
          bankId: mode === "bank" ? bankId : undefined,
          allocations: allocations.length ? allocations : undefined,
          createdAt: new Date().toISOString(),
        };
        PaymentRepo.addBatched(batch, payment);
      }

      commitBatch(batch, "save payment");

      const invWord = isIn ? "invoice" : "bill";
      if (editing) {
        toast.success(`Payment updated — ${fmtMoney(amount)}`);
      } else if (allocations.length) {
        toast.success(
          `${fmtMoney(amount)} applied to ${allocations.length} ${invWord}${allocations.length > 1 ? "s" : ""}`,
        );
      } else {
        toast.success(`Payment ${isIn ? "received" : "sent"} recorded`);
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      console.error("Payment save failed", err);
      toast.error("Could not save payment — please try again");
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {isIn ? (
              <>
                <ArrowDownCircle className="h-5 w-5 text-emerald-600" />{" "}
                {editing ? "Edit Payment (Received)" : "Receive Payment from Customer"}
              </>
            ) : (
              <>
                <ArrowUpCircle className="h-5 w-5 text-rose-600" />{" "}
                {editing ? "Edit Payment (Paid Out)" : "Make Payment to Supplier"}
              </>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-1">
          {/* Party search */}
          <div className="relative">
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="font-semibold text-gray-600">
                {isIn ? "Customer (Received From)" : "Supplier (Paid To)"} *
              </span>
              <input
                ref={partyRef}
                value={partyQ}
                onChange={(e) => {
                  setPartyQ(e.target.value);
                  setPartyOpen(true);
                  setPartyIdx(0);
                  setSelectedParty(null);
                  setApplyRows([]);
                }}
                onFocus={() => setPartyOpen(true)}
                onBlur={() => setTimeout(() => setPartyOpen(false), 150)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setPartyIdx((i) => Math.min(suggests.length - 1, i + 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setPartyIdx((i) => Math.max(0, i - 1));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    if (suggests[partyIdx]) selectParty(suggests[partyIdx]);
                  }
                }}
                className="h-9 px-3 border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none text-sm"
                placeholder="Type to search party…"
              />
            </label>
            {partyOpen && suggests.length > 0 && (
              <div className="absolute z-30 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-lg max-h-40 overflow-auto">
                {suggests.map((p, i) => (
                  <div
                    key={p.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectParty(p);
                    }}
                    className={`px-3 py-2 text-sm cursor-pointer flex items-center justify-between ${i === partyIdx ? "bg-accent" : "hover:bg-accent"}`}
                  >
                    <span className="font-medium">{p.name}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-gray-400" />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Outstanding panel */}
          {selectedParty && (
            <div
              className={`rounded-lg border-2 p-4 ${isIn ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"}`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide truncate">
                    {isIn ? "Outstanding Receivable from" : "Outstanding Payable to"}{" "}
                    {selectedParty.name}
                  </p>
                  <p
                    className={`text-[22px] font-bold tabular-nums mt-0.5 ${isIn ? "text-emerald-700" : "text-rose-700"}`}
                  >
                    {fmtMoney(totalOutstanding + unlinkedBalance)}
                  </p>
                </div>
                {applyRows.length > 0 && allocMode === "manual" && (
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={applyAll}
                      className="flex-1 sm:flex-none text-xs px-3 py-1.5 rounded-md bg-white border font-medium text-gray-700 hover:bg-gray-50 transition"
                    >
                      Apply All
                    </button>
                    <button
                      onClick={clearAll}
                      className="flex-1 sm:flex-none text-xs px-3 py-1.5 rounded-md bg-white border font-medium text-gray-700 hover:bg-gray-50 transition"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>

              {/* ── Quick entry: one amount, settled oldest bill first ───── */}
              {allocMode === "auto" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-[12px] font-semibold text-gray-600 flex items-center justify-between mb-1">
                        {isIn ? "Amount Received" : "Amount Paid"} (₹) *
                        {totalDue > 0.01 && (
                          <button
                            type="button"
                            onClick={() => {
                              setPayAmount(r2(Math.max(0, totalDue - payDiscount)));
                            }}
                            className="text-[11px] font-semibold text-blue-600 hover:underline"
                          >
                            Full {fmtMoney(r2(Math.max(0, totalDue - payDiscount)))}
                          </button>
                        )}
                      </span>
                      <NumInput
                        value={payAmount}
                        onValue={setPayAmount}
                        // The visible label wraps a "Full ₹x" shortcut too, so
                        // spell the accessible name out rather than letting it
                        // read as "Amount Received Full ₹20,500".
                        aria-label={isIn ? "Amount received" : "Amount paid"}
                        placeholder="0.00"
                        className={`w-full h-11 px-3 border-2 rounded-md text-right font-bold text-lg outline-none focus:border-primary bg-white tabular-nums ${isIn ? "text-emerald-700" : "text-rose-700"}`}
                      />
                    </label>
                    <label className="block">
                      <span className="text-[12px] font-semibold text-gray-600 flex items-center justify-between mb-1">
                        Discount / Write-off (₹)
                        {/* The everyday case: take a round figure and knock off
                            the odd rupees so the bill actually closes, instead
                            of leaving a few rupees open on it forever. */}
                        {r2(totalDue - payAmount - payDiscount) > 0.01 && payAmount > 0 && (
                          <button
                            type="button"
                            onClick={() => setPayDiscount(r2(totalDue - payAmount))}
                            className="text-[11px] font-semibold text-amber-700 hover:underline"
                          >
                            Settle rest {fmtMoney(r2(totalDue - payAmount))}
                          </button>
                        )}
                      </span>
                      <NumInput
                        value={payDiscount}
                        onValue={setPayDiscount}
                        aria-label="Discount or write-off"
                        placeholder="0.00"
                        className="w-full h-11 px-3 border-2 rounded-md text-right font-bold text-lg outline-none focus:border-primary bg-white text-amber-700 tabular-nums"
                      />
                    </label>
                  </div>

                  {applyRows.length > 0 && (
                    <div className="bg-white/70 rounded-md border border-gray-200 overflow-hidden">
                      <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide px-3 pt-2">
                        Settles oldest {isIn ? "invoice" : "bill"} first
                      </p>
                      <div className="max-h-40 overflow-y-auto divide-y divide-gray-100 mt-1">
                        {applyRows.map((row) => {
                          const settled = r2(row.apply + row.discount);
                          const closes = settled > 0 && r2(row.due - settled) < 0.01;
                          return (
                            <div
                              key={row.invoice.id}
                              className="flex items-center gap-2 px-3 py-1.5 text-xs"
                            >
                              <span className="font-mono font-semibold text-blue-600 shrink-0">
                                {row.invoice.number}
                              </span>
                              <span className="text-gray-400 shrink-0 hidden sm:inline">
                                {fmtDate(row.invoice.date)}
                              </span>
                              <span className="text-gray-500 tabular-nums shrink-0">
                                {fmtMoney(row.due)}
                              </span>
                              <span className="flex-1 text-right tabular-nums">
                                {settled <= 0 ? (
                                  <span className="text-gray-400">untouched</span>
                                ) : (
                                  <>
                                    <span className={isIn ? "text-emerald-700" : "text-rose-700"}>
                                      {fmtMoney(row.apply)}
                                    </span>
                                    {row.discount > 0 && (
                                      <span className="text-amber-700">
                                        {" + "}
                                        {fmtMoney(row.discount)} off
                                      </span>
                                    )}
                                  </>
                                )}
                              </span>
                              <span
                                className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                                  closes
                                    ? "bg-emerald-100 text-emerald-700"
                                    : settled > 0
                                      ? "bg-amber-100 text-amber-700"
                                      : "bg-gray-100 text-gray-400"
                                }`}
                              >
                                {closes ? "closed" : settled > 0 ? "partial" : "open"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-gray-600">
                      {advanceLeft > 0.01 && (
                        <span className="font-semibold text-blue-700">
                          {fmtMoney(advanceLeft)} kept as advance
                        </span>
                      )}
                      {unusedDiscount > 0.01 && (
                        <span className="font-semibold text-amber-700">
                          {advanceLeft > 0.01 ? " · " : ""}
                          {fmtMoney(unusedDiscount)} discount unused — nothing left to write off
                        </span>
                      )}
                    </span>
                    {applyRows.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setAllocMode("manual")}
                        className="font-semibold text-blue-600 hover:underline"
                      >
                        Adjust {isIn ? "invoice" : "bill"} by {isIn ? "invoice" : "bill"} →
                      </button>
                    )}
                  </div>
                </div>
              )}

              {applyRows.length === 0 && (
                <div className="flex items-center gap-2 text-xs text-gray-500 bg-white/60 rounded-md px-3 py-2 mt-3">
                  <AlertCircle className="h-4 w-4 text-gray-400" />
                  {unlinkedBalance > 0.01
                    ? `No open ${isIn ? "invoices" : "bills"}, but this party carries a balance of ${fmtMoney(unlinkedBalance)} (e.g. opening balance) — payment will be recorded as an advance against it`
                    : `No outstanding ${isIn ? "invoices" : "bills"} — this will be recorded as an advance payment`}
                </div>
              )}
              {allocMode === "manual" && applyRows.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                    {applyRows.length} Open {isIn ? "Invoice" : "Bill"}
                    {applyRows.length > 1 ? "s" : ""} — select to settle:
                  </p>
                  <div className="bg-white rounded-md border border-gray-200 overflow-hidden max-h-48 overflow-y-auto">
                    {applyRows.map((row, idx) => (
                      <div
                        key={row.invoice.id}
                        className={`flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-3 py-2.5 border-b border-gray-100 last:border-0 transition ${row.checked ? (isIn ? "bg-emerald-50/50" : "bg-rose-50/50") : ""}`}
                      >
                        <div className="flex items-start gap-3 sm:flex-1 min-w-0">
                          <button
                            type="button"
                            onClick={() => toggleRow(idx)}
                            className="shrink-0 mt-0.5"
                          >
                            {row.checked ? (
                              <CheckCircle2
                                className={`h-5 w-5 ${isIn ? "text-emerald-600" : "text-rose-500"}`}
                              />
                            ) : (
                              <Circle className="h-5 w-5 text-gray-300" />
                            )}
                          </button>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono font-semibold text-xs text-blue-600">
                                {row.invoice.number}
                              </span>
                              <span className="text-xs text-gray-400 whitespace-nowrap">
                                {fmtDate(row.invoice.date)}
                              </span>
                              {row.invoice.paid > 0 && (
                                <span className="text-[10px] font-semibold text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
                                  Partial
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 mt-0.5">
                              Total {fmtMoney(row.invoice.total)} · Already paid{" "}
                              {fmtMoney(row.invoice.paid)}
                            </div>
                          </div>
                        </div>
                        {/* On a phone this used to be Due + two 96px inputs
                            crammed onto one line, which is what made the
                            sheet feel cheap and the boxes hard to hit. It is
                            a 3-up grid with full-width controls there, and
                            only collapses to the inline row from sm: up. */}
                        <div className="grid grid-cols-3 gap-2 sm:flex sm:items-center sm:justify-end sm:gap-4 sm:shrink-0">
                          <div className="text-left sm:text-right">
                            <p className="text-[10px] text-gray-400 mb-1">Due</p>
                            <p
                              className={`text-sm font-bold tabular-nums leading-9 sm:leading-normal ${isIn ? "text-emerald-700" : "text-rose-700"}`}
                            >
                              {fmtMoney(row.due)}
                            </p>
                          </div>
                          <div className="sm:shrink-0 sm:w-24">
                            <p className="text-[10px] text-gray-400 mb-1 sm:text-right">
                              Apply (₹)
                            </p>
                            <NumInput
                              value={row.apply}
                              onValue={(n) => setApply(idx, n)}
                              placeholder="0.00"
                              className={`w-full h-9 sm:h-7 px-2 text-right text-base sm:text-xs border rounded outline-none focus:ring-1 ${row.checked ? (isIn ? "border-emerald-400 focus:ring-emerald-300 bg-white" : "border-rose-400 focus:ring-rose-300 bg-white") : "border-gray-200 bg-gray-50"} tabular-nums`}
                            />
                          </div>
                          {/* Settle the last few rupees without pretending they
                              were collected: 20,000 against a 20,500 bill plus
                              500 here closes it exactly. */}
                          <div className="sm:shrink-0 sm:w-24">
                            <p className="text-[10px] text-gray-400 mb-1 sm:text-right">
                              Discount (₹)
                            </p>
                            <NumInput
                              value={row.discount}
                              onValue={(n) => setRowDiscount(idx, n)}
                              placeholder="0.00"
                              className={`w-full h-9 sm:h-7 px-2 text-right text-base sm:text-xs border rounded outline-none focus:ring-1 tabular-nums ${row.discount > 0 ? "border-amber-400 focus:ring-amber-300 bg-white" : "border-gray-200 bg-gray-50"}`}
                            />
                            {r2(row.due - row.apply - row.discount) > 0.01 && row.checked && (
                              <button
                                type="button"
                                onClick={() => setRowDiscount(idx, r2(row.due - row.apply))}
                                className="mt-1 w-full text-[10px] text-amber-700 hover:underline text-right"
                              >
                                Write off {fmtMoney(r2(row.due - row.apply))}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {allocMode === "manual" && applyRows.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAllocMode("auto")}
                  className="mt-2 text-xs font-semibold text-blue-600 hover:underline"
                >
                  ← Back to quick entry
                </button>
              )}

              {/* Manual amount — shown whenever nothing is applied to an invoice
                  yet, whether because there are none or none are checked. Quick
                  entry has its own amount box, so this is bill-by-bill only. */}
              {allocMode === "manual" && totalApplied === 0 && (
                <div className="mt-3">
                  <label className="text-[12px] font-semibold text-gray-600 block mb-1">
                    {applyRows.length > 0 ? "Or record as advance (₹)" : "Amount (₹) *"}
                  </label>
                  <NumInput
                    value={manualAmount}
                    onValue={setManualAmount}
                    className={`w-full h-9 px-3 border-2 rounded-md text-right font-bold text-lg outline-none focus:border-primary ${isIn ? "text-emerald-700" : "text-rose-700"}`}
                    placeholder="0.00"
                  />
                </div>
              )}
            </div>
          )}

          {/* No party selected — show general amount input */}
          {!selectedParty && (
            <div className="rounded-lg border bg-gray-50 p-4">
              <label className="text-[12px] font-semibold text-gray-600 block mb-1">
                Amount (₹) *
              </label>
              <NumInput
                value={manualAmount}
                onValue={setManualAmount}
                className={`w-full h-9 px-3 border-2 rounded-md text-right font-bold text-lg outline-none focus:border-primary ${isIn ? "text-emerald-700" : "text-rose-700"}`}
                placeholder="0.00"
              />
            </div>
          )}

          {/* Payment details */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1 text-[12px]">
              <label className="font-semibold text-gray-600">Date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="h-8 px-2 border rounded bg-white focus:border-primary outline-none text-sm"
              />
            </div>
            <div className="flex flex-col gap-1 text-[12px]">
              <label className="font-semibold text-gray-600">Payment Mode</label>
              <div className="flex items-center h-8">
                <ModePills
                  value={mode}
                  onChange={(m) => {
                    setMode(m);
                    if (m !== "bank") {
                      setBankId("");
                      setBankQ("");
                    }
                  }}
                  modes={["cash", "bank"]}
                />
              </div>
            </div>
          </div>

          {mode === "bank" && (
            <div className="relative flex flex-col gap-1 text-[12px]">
              <label className="font-semibold text-gray-600">Bank Account *</label>
              <input
                value={bankQ}
                onChange={(e) => {
                  setBankQ(e.target.value);
                  setBankOpen(true);
                  setBankIdx(0);
                  if (bankId) setBankId("");
                }}
                onFocus={() => setBankOpen(true)}
                onBlur={() => setTimeout(() => setBankOpen(false), 150)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setBankIdx((i) => Math.min(bankSuggests.length - 1, i + 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setBankIdx((i) => Math.max(0, i - 1));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    if (bankSuggests[bankIdx]) {
                      selectBank(bankSuggests[bankIdx]);
                    }
                  }
                }}
                placeholder="Search bank account…"
                className="h-9 px-2 border rounded-md bg-white focus:border-primary outline-none text-sm"
              />
              {bankOpen && bankSuggests.length > 0 && (
                <div className="absolute z-20 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-lg max-h-40 overflow-auto">
                  {bankSuggests.map((b, i) => (
                    <div
                      key={b.id}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectBank(b);
                      }}
                      className={`px-3 py-2 text-sm cursor-pointer ${i === bankIdx ? "bg-accent" : "hover:bg-accent"}`}
                    >
                      {b.name}
                      {b.accountNumber ? ` — ${b.accountNumber}` : ""} ({fmtMoney(b.balance)})
                    </div>
                  ))}
                </div>
              )}
              {bankOpen && bankQ && bankSuggests.length === 0 && (
                <div className="absolute z-20 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-lg px-3 py-2 text-xs text-muted-foreground">
                  No matching bank account
                </div>
              )}
              {banks.length === 0 && (
                <p className="text-[11px] text-amber-600">
                  No bank accounts set up yet — add one from Bank Accounts first.
                </p>
              )}
            </div>
          )}

          {/* Total + Actions */}
          <div
            className={`rounded-lg border-2 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 ${isIn ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"}`}
          >
            <div>
              <p className="text-xs text-gray-500 font-medium">
                {applyRows.some((r) => r.checked)
                  ? `Applied to ${applyRows.filter((r) => r.checked).length} ${isIn ? "invoice" : "bill"}${applyRows.filter((r) => r.checked).length > 1 ? "s" : ""}`
                  : "General payment (advance)"}
              </p>
              <p
                className={`text-[22px] font-extrabold tabular-nums ${isIn ? "text-emerald-700" : "text-rose-700"}`}
              >
                {fmtMoney(effectiveAmount)}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => onOpenChange(false)}
                className="flex-1 sm:flex-none"
              >
                Cancel
              </Button>
              <Button
                onClick={save}
                disabled={saving}
                className={`flex-1 sm:flex-none ${
                  isIn
                    ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                    : "bg-rose-600 hover:bg-rose-700 text-white"
                }`}
              >
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Saving…
                  </>
                ) : isIn ? (
                  <>
                    <ArrowDownCircle className="h-4 w-4 mr-1.5" /> Confirm Receipt
                  </>
                ) : (
                  <>
                    <ArrowUpCircle className="h-4 w-4 mr-1.5" /> Confirm Payment
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

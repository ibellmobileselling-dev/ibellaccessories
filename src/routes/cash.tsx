import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { nextVoucherNo } from "@/repositories";
import { usePeriodLock } from "@/hooks/usePeriodLock";
import { VoidDialog, VoidedBadge } from "@/components/VoidDialog";
import {
  canDeleteOutright,
  canEditInPlace,
  editRefusalMessage,
  isVoided,
  removalWord,
} from "@/lib/voiding";
import { matchesQuery } from "@/lib/search";
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import {
  SalesRepo,
  PurchaseRepo,
  ExpenseRepo,
  PaymentRepo,
  CashAdjustmentRepo,
  BankTxnRepo,
  BankRepo,
} from "@/repositories";
import type { BankTxn, CashAdjustment } from "@/types";
import { newBatch, commitBatch } from "@/repositories/base";
import { useRepoData } from "@/hooks/useRepoData";
import { cashFlows, type FlowEntry } from "@/lib/ledger";
import { transferLegsFor } from "@/lib/transferLegs";

/**
 * Why a cash row moved, as far as the data can say.
 *
 * The stamped purpose when there is one; otherwise "transfer" if this entry
 * is one leg of a recognised pair. Only a genuinely unexplained entry comes
 * back undefined — which is what the amber flag is for.
 */
function rowPurpose(e: FlowEntry): string | undefined {
  if (e.purpose) return e.purpose;
  if (e.source?.kind !== "adjustment") return undefined;
  const adj = CashAdjustmentRepo.get(e.source.id);
  if (adj && transferLegsFor(adj, BankTxnRepo.all()).length > 0) return "transfer";
  return undefined;
}
import {
  CHOOSABLE_PURPOSES,
  purposeSpec,
  purposeLabel,
  totalsByPurpose,
  type CashPurpose,
} from "@/lib/cashPurpose";
import { fmtMoney, fmtDate, today, fmtDateShort } from "@/lib/format";
import { DataTable } from "@/components/DataTable";
import { usePagination } from "@/hooks/usePagination";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/Field";
import { NumField } from "@/components/NumInput";
import {
  Banknote,
  Search,
  Calendar,
  X,
  SlidersHorizontal,
  ArrowLeftRight,
  ArrowRight,
  Pencil,
  Trash2,
  Ban,
  ExternalLink,
} from "lucide-react";
import { CashBankTransferDialog } from "@/components/CashBankTransferDialog";
import { toast } from "sonner";
import { usePermissions } from "@/hooks/usePermissions";

export const Route = createFileRoute("/cash")({ component: CashPage });

function CashPage() {
  const { isOwner, canEdit } = usePermissions();
  const editAllowed = isOwner || canEdit("cashBank");
  const [entries, setEntries] = useState<FlowEntry[]>([]);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [editAdj, setEditAdj] = useState<CashAdjustment | null>(null);
  const [editTransfer, setEditTransfer] = useState<CashAdjustment | null>(null);
  const { canPost } = usePeriodLock();
  const [q, setQ] = useState("");
  // Cancelled entries stay on file; this only decides whether they are in
  // the way. Off by default, and they never count towards a total.
  const [showVoided, setShowVoided] = useState(false);
  const [voiding, setVoiding] = useState<CashAdjustment | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const refresh = () =>
    setEntries(
      cashFlows(
        SalesRepo.all(),
        PurchaseRepo.all(),
        ExpenseRepo.all(),
        PaymentRepo.all(),
        // Cancelled entries are fetched only when asked for, and are stripped
        // out of every total below — see `counting`.
        showVoided ? CashAdjustmentRepo.allWithVoided() : CashAdjustmentRepo.all(),
      ),
    );
  const _repoV = useRepoData();
  useEffect(refresh, [_repoV, showVoided]);

  /**
   * Remove a manual cash entry — and everything that entry is half of.
   *
   * A plain adjustment is its own record and simply goes. A TRANSFER leg is
   * not: it was written together with a bank deposit or withdrawal, and
   * deleting one side alone would leave the money out of one account and
   * never into the other. Both legs go on one batch, and the bank balance is
   * put back by the same amount it was moved.
   */
  const deleteRow = (row: FlowEntry) => {
    const id = row.source?.kind === "adjustment" ? row.source.id : null;
    if (!id) return;
    const adj = CashAdjustmentRepo.get(id);
    if (!adj) return;
    if (!canPost(adj.date)) return;

    const legs = transferLegsFor(adj, BankTxnRepo.all());
    const what = legs.length
      ? `Delete this transfer? It will be removed from cash AND from ${legs
          .map((t) => BankRepo.get(t.bankId)?.name ?? "the bank account")
          .join(", ")}.`
      : `Delete this cash entry of ${fmtMoney(adj.amount)}?`;
    // Anything dated before today is cancelled, not destroyed — its month has
    // already been counted. See lib/voiding.ts.
    if (!canDeleteOutright(adj.date)) {
      if (isVoided(adj)) {
        toast.info("This entry is already voided");
        return;
      }
      setVoiding(adj);
      return;
    }
    if (!confirm(what)) return;

    const batch = newBatch();
    CashAdjustmentRepo.removeBatched(batch, adj.id);
    for (const leg of legs) {
      BankTxnRepo.removeBatched(batch, leg.id);
      undoLegOnBank(batch, leg);
    }
    commitBatch(batch, "delete cash entry").then((ok) => {
      if (!ok) {
        toast.error("Could not delete — reload and check before trying again");
        return;
      }
      toast.success(legs.length ? "Transfer deleted from both accounts" : "Cash entry deleted");
      refresh();
    });
  };

  /**
   * The rows that count.
   *
   * A cancelled entry is on the list to be seen, not to be added up. Applied
   * at every total on this page rather than at the list, because the two
   * questions are genuinely different: what happened, and what the shop has.
   */
  const counting = (list: FlowEntry[]) => list.filter((e) => !e.voided);

  /** Put a transfer's bank side back: a deposit added to the account, so
   *  undoing it subtracts, and the other way round. */
  const undoLegOnBank = (batch: ReturnType<typeof newBatch>, leg: BankTxn) => {
    BankRepo.adjustFieldBatched(
      batch,
      leg.bankId,
      "balance",
      leg.type === "deposit" ? -leg.amount : leg.amount,
    );
  };

  /**
   * Cancel a cash entry older than today — and everything it is half of.
   *
   * A transfer's two legs are voided together for the same reason they are
   * deleted together: cancelling one side alone leaves the money out of one
   * account and never into the other.
   */
  const voidRow = (adj: CashAdjustment, reason: string) => {
    const legs = transferLegsFor(adj, BankTxnRepo.allWithVoided());
    const batch = newBatch();
    if (!CashAdjustmentRepo.voidBatched(batch, adj.id, reason)) {
      toast.info("This entry was already voided");
      setVoiding(null);
      return;
    }
    for (const leg of legs) {
      BankTxnRepo.voidBatched(batch, leg.id, reason);
      undoLegOnBank(batch, leg);
    }
    commitBatch(batch, "void cash entry").then((ok) => {
      setVoiding(null);
      if (!ok) {
        toast.error("Could not void — reload and check before trying again");
        return;
      }
      toast.success(
        legs.length ? "Transfer voided on both accounts" : "Cash entry voided — it stays on record",
      );
      refresh();
    });
  };

  // Balance is the true running cash-in-hand as of now — it doesn't change
  // when a date range is applied, only the period's In/Out totals do.
  const balance = counting(entries).reduce((s, e) => s + e.in - e.out, 0);

  const dateFiltered = useMemo(() => {
    if (!dateFrom && !dateTo) return entries;
    return entries.filter(
      (e) => (!dateFrom || e.date >= dateFrom) && (!dateTo || e.date <= dateTo),
    );
  }, [entries, dateFrom, dateTo]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return dateFiltered;
    return dateFiltered.filter((e) => matchesQuery(s, e.type, e.ref));
  }, [dateFiltered, q]);

  // Footer In/Out cover the filtered rows the table actually shows (date
  // range AND search) — `balance` above stays all-time by design.
  const totalIn = counting(filtered).reduce((s, e) => s + e.in, 0);
  const totalOut = counting(filtered).reduce((s, e) => s + e.out, 0);

  // Manual entries only: a sale's reason is its bill, and lumping those in
  // would drown the figures this is for.
  const purposeTotals = useMemo(
    () =>
      totalsByPurpose(
        counting(filtered)
          .filter((e) => e.source?.kind === "adjustment")
          .map((e) => ({
            purpose: rowPurpose(e),
            type: e.in > 0 ? ("add" as const) : ("reduce" as const),
            amount: e.in > 0 ? e.in : e.out,
          })),
      ),
    [filtered],
  );

  const pg = usePagination(filtered, "cash");

  return (
    <div className="flex flex-col h-full bg-[#f5f6fa]">
      <PageHeader
        title="Cash"
        subtitle={`${filtered.length} of ${entries.length} transactions`}
        icon={<Banknote className="h-5 w-5" />}
        mobileAction={
          <button
            onClick={() => setMobileFiltersOpen(true)}
            className="relative h-9 w-9 flex items-center justify-center rounded-lg border border-gray-200 bg-gray-50/60 text-gray-600"
            title="Filters"
          >
            <SlidersHorizontal className="h-4 w-4" />
            {(dateFrom || dateTo) && (
              <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-primary" />
            )}
          </button>
        }
        actions={
          <>
            {/* Date range — its own filter sheet on mobile (see Filters
                button above); this inline row is desktop only. */}
            <div className="hidden sm:flex items-center gap-1.5 h-9 pl-3 pr-2.5 rounded-lg border border-gray-200 bg-gray-50/60 shrink-0">
              <Calendar className="h-3.5 w-3.5 text-gray-400 shrink-0" />
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="bg-transparent text-xs text-gray-700 focus:outline-none w-[104px]"
              />
              <span className="text-gray-300 text-xs">–</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="bg-transparent text-xs text-gray-700 focus:outline-none w-[104px]"
              />
              {(dateFrom || dateTo) && (
                <button
                  onClick={() => {
                    setDateFrom("");
                    setDateTo("");
                  }}
                  className="text-gray-400 hover:text-gray-600 transition"
                  title="Clear date range"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="relative w-full sm:w-56">
              <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search type, reference…"
                className="w-full h-9 pl-9 pr-3 rounded-lg border border-gray-200 bg-gray-50/60 text-base md:text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/20 focus:bg-white transition"
              />
            </div>
            {editAllowed && (
              <>
                {/* "Put the day's takings in the bank" had no home on this
                    page at all — it was a checkbox inside one bank account's
                    Deposit action. */}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setTransferOpen(true)}
                  className="w-full sm:w-auto"
                >
                  <ArrowLeftRight className="h-3.5 w-3.5" /> Transfer
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowVoided((v) => !v)}
                  className={`w-full sm:w-auto ${showVoided ? "border-rose-200 bg-rose-50 text-rose-700" : ""}`}
                  title="Cancelled entries stay on file, and never count towards a total"
                >
                  <Ban className="h-3.5 w-3.5" /> Voided
                </Button>
                <Button size="sm" onClick={() => setAdjustOpen(true)} className="w-full sm:w-auto">
                  <Banknote className="h-3.5 w-3.5" /> Adjust Cash
                </Button>
              </>
            )}
          </>
        }
      />

      {/* Mobile filter sheet — Date Range doesn't fit inline next to Search
          on a phone, so it lives here behind the header's Filters button
          instead, same state as the desktop inline control. */}
      <Dialog open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Filters</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-gray-500 block mb-1.5">Date Range</label>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="flex-1 h-9 px-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <span className="text-gray-300">–</span>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="flex-1 h-9 px-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
            <div className="flex items-center justify-between pt-1">
              {dateFrom || dateTo ? (
                <button
                  onClick={() => {
                    setDateFrom("");
                    setDateTo("");
                  }}
                  className="text-xs text-gray-400 hover:text-gray-600 transition flex items-center gap-1"
                >
                  <X className="h-3 w-3" /> Clear
                </button>
              ) : (
                <span />
              )}
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

      {/* Mobile card list — a table of 5 columns doesn't fit a phone; this is
          the same data as one row-card per transaction instead (read-only, same
          as the desktop table — no click action here either). */}
      <div className="md:hidden flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <Banknote className="h-10 w-10 mx-auto mb-3 text-gray-200" />
            <p className="font-medium">No cash transactions yet</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pg.paged.map((e, i) => (
              <div
                key={`${e.date}-${e.type}-${e.ref}-${e.in}-${e.out}-${i}`}
                className="bg-white p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-800 truncate">{e.type}</p>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">
                      {fmtDate(e.date)} · {e.ref}
                    </p>
                  </div>
                  <p
                    className={`font-bold tabular-nums shrink-0 ${e.in ? "text-emerald-600" : e.out ? "text-rose-600" : "text-gray-800"}`}
                  >
                    {e.in ? `+${fmtMoney(e.in)}` : e.out ? `−${fmtMoney(e.out)}` : "—"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Where the manual cash went, by reason. The rows below say what
          happened; this says what it adds up to — and how much of it is still
          unaccounted for, which is the number that matters most. */}
      {purposeTotals.length > 0 && (
        <div
          role="group"
          aria-label="Cash movement by reason"
          className="hidden md:flex px-6 pt-4 gap-2 flex-wrap"
        >
          {purposeTotals.map((t) => (
            <div
              key={t.key}
              className={`rounded-lg border px-3 py-2 ${
                t.key === "uncategorised"
                  ? "border-amber-200 bg-amber-50"
                  : "border-gray-200 bg-white"
              }`}
            >
              <p
                className={`text-[10px] font-semibold uppercase tracking-wide ${
                  t.key === "uncategorised" ? "text-amber-700" : "text-gray-500"
                }`}
              >
                {t.label}
                <span className="ml-1.5 font-normal tabular-nums opacity-70">({t.count})</span>
              </p>
              <p
                className={`text-[15px] font-bold tabular-nums ${
                  t.net > 0 ? "text-emerald-700" : t.net < 0 ? "text-rose-700" : "text-gray-700"
                }`}
              >
                {t.net > 0 ? "+" : ""}
                {fmtMoney(t.net)}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="hidden md:flex flex-1 min-h-0 p-6">
        <DataTable
          storageKey="cash"
          columns={[
            {
              key: "date",
              label: "Date",
              render: (e) => fmtDateShort(e.date),
              sortValue: (e) => e.date,
            },
            {
              key: "type",
              label: "Type",
              render: (e) => e.type,
              sortValue: (e) => e.type,
            },
            {
              key: "purpose",
              label: "Reason",
              width: "150px",
              render: (e) =>
                e.source?.kind === "adjustment" ? (
                  <span
                    className={
                      rowPurpose(e)
                        ? "text-[11px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600"
                        : "text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200"
                    }
                    title={
                      rowPurpose(e)
                        ? undefined
                        : "Made before the app asked why — edit it to say, or the P&L is guessing"
                    }
                  >
                    {purposeLabel(rowPurpose(e))}
                  </span>
                ) : (
                  <span className="text-gray-300">—</span>
                ),
              sortValue: (e) => purposeLabel(rowPurpose(e)),
            },
            {
              key: "ref",
              label: "Reference",
              render: (e) => e.ref,
              sortValue: (e) => e.ref,
            },
            {
              key: "in",
              label: "Cash In",
              align: "right",
              render: (e) => <span className="tabular-nums">{e.in ? fmtMoney(e.in) : "—"}</span>,
              sortValue: (e) => e.in,
            },
            {
              key: "out",
              label: "Cash Out",
              align: "right",
              render: (e) => <span className="tabular-nums">{e.out ? fmtMoney(e.out) : "—"}</span>,
              sortValue: (e) => e.out,
            },
            {
              key: "action",
              label: "Action",
              width: "84px",
              align: "center",
              render: (e) => (
                <CashRowActions
                  row={e}
                  onEdit={(adj) => {
                    if (!canEditInPlace(adj.date)) {
                      toast.error(editRefusalMessage("entry"), { duration: 7000 });
                      return;
                    }
                    if (transferLegsFor(adj, BankTxnRepo.all()).length > 0) setEditTransfer(adj);
                    else setEditAdj(adj);
                  }}
                  onDelete={deleteRow}
                />
              ),
            },
          ]}
          rows={filtered}
          rowKey={(e) => e.source?.id ?? `${e.date}-${e.type}-${e.ref}-${e.in}-${e.out}`}
          emptyMessage={
            entries.length === 0 ? "No cash transactions yet" : "No matches for your search"
          }
          footer={
            <tr>
              <td colSpan={3}>
                Total <span className="text-gray-300">|</span>{" "}
                <span className="tabular-nums">{fmtMoney(balance)}</span>
              </td>
              <td className="text-right tabular-nums">{fmtMoney(totalIn)}</td>
              <td className="text-right tabular-nums">{fmtMoney(totalOut)}</td>
            </tr>
          }
        />
      </div>
      <CashBankTransferDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        onSaved={refresh}
        editing={editTransfer}
        onEditingDone={() => setEditTransfer(null)}
      />
      <VoidDialog
        open={!!voiding}
        onOpenChange={(v) => !v && setVoiding(null)}
        what="this cash entry"
        effects={
          voiding && transferLegsFor(voiding, BankTxnRepo.allWithVoided()).length
            ? ["The bank side of the transfer is voided with it, and the account put back"]
            : []
        }
        onConfirm={(reason) => voiding && voidRow(voiding, reason)}
      />

      <CashAdjustDialog
        editing={editAdj}
        onEditingChange={setEditAdj}
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        onSaved={refresh}
        currentBalance={balance}
      />
    </div>
  );
}

/**
 * What a cash row can actually be asked to do.
 *
 * Only a manual adjustment owns itself. Every other line here is the cash
 * side of a bill, an expense or a payment — the number is real, but it is
 * that document's number, so the honest action is to open the document
 * rather than to pretend the cash line can be edited on its own.
 */
function CashRowActions({
  row,
  onEdit,
  onDelete,
}: {
  row: FlowEntry;
  onEdit: (a: CashAdjustment) => void;
  onDelete: (row: FlowEntry) => void;
}) {
  const navigate = useNavigate();
  const src = row.source;
  if (!src) return <span className="text-gray-300">—</span>;

  if (src.kind === "adjustment") {
    const adj = CashAdjustmentRepo.get(src.id);
    // A transfer leg is editable only as a whole, from the transfer itself —
    // changing one side's amount here would move the cash and leave the bank
    // account saying something else. Recognised by its partner record, not by
    // a flag, so transfers made before the two legs were stamped with a
    // shared id are refused too. Those are the ones that mattered: they were
    // being offered for edit.
    const isTransfer = !!adj && transferLegsFor(adj, BankTxnRepo.all()).length > 0;
    if (isVoided(adj)) {
      return <VoidedBadge reason={adj?.voidReason} at={adj?.voidedAt} />;
    }
    return (
      <span
        className="inline-flex items-center justify-center gap-0.5"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => adj && onEdit(adj)}
          disabled={!adj}
          title={
            !canEditInPlace(row.date)
              ? editRefusalMessage("entry")
              : isTransfer
                ? "Edit this transfer (both accounts)"
                : "Edit entry"
          }
          className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-primary-soft hover:text-primary hover:border-primary/25 disabled:opacity-30 disabled:pointer-events-none"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => onDelete(row)}
          title={
            isTransfer
              ? `${removalWord(row.date)} this transfer on both accounts`
              : `${removalWord(row.date)} entry`
          }
          className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200"
        >
          {canDeleteOutright(row.date) ? (
            <Trash2 className="h-3.5 w-3.5" />
          ) : (
            <Ban className="h-3.5 w-3.5" />
          )}
        </button>
      </span>
    );
  }

  const to =
    src.kind === "sale"
      ? `/sales/${src.id}`
      : src.kind === "purchase"
        ? `/purchase/${src.id}`
        : src.kind === "expense"
          ? "/expenses"
          : "/payments";
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigate({ to });
      }}
      title={`This came from a ${src.kind} — open it to change it`}
      className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-primary-soft hover:text-primary hover:border-primary/25"
    >
      <ExternalLink className="h-3.5 w-3.5" />
    </button>
  );
}

function CashAdjustDialog({
  open,
  onOpenChange,
  onSaved,
  currentBalance,
  editing,
  onEditingChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
  currentBalance: number;
  /** An existing manual entry being corrected, rather than a new one. */
  editing?: CashAdjustment | null;
  onEditingChange?: (v: CashAdjustment | null) => void;
}) {
  const [type, setType] = useState<"add" | "reduce">("add");
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState("");
  const [purpose, setPurpose] = useState<CashPurpose | "">("");
  const chosenPurpose = purposeSpec(purpose || undefined);
  const [saving, setSaving] = useState(false);
  const { canPost } = usePeriodLock();

  // Editing is the same form, opened over an existing row.
  const isOpen = open || !!editing;
  const close = (v: boolean) => {
    if (v) return;
    onEditingChange?.(null);
    onOpenChange(false);
  };

  useEffect(() => {
    if (!isOpen) return;
    setType(editing?.type ?? "add");
    setAmount(editing?.amount ?? 0);
    setDate(editing?.date ?? today());
    setReason(editing?.reason ?? "");
    // No default: an unstated reason is the thing this exists to stop, and a
    // pre-picked one would be a guess wearing the shopkeeper's answer.
    setPurpose(editing?.purpose ?? "");
    setSaving(false);
  }, [isOpen, editing]);

  const n = amount;
  const signed = (t: "add" | "reduce", amt: number) => (t === "add" ? amt : -amt);
  const nextBalance =
    Math.round(
      (currentBalance - (editing ? signed(editing.type, editing.amount) : 0) + signed(type, n)) *
        100,
    ) / 100;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (n <= 0) {
      toast.error("Enter amount to adjust");
      return;
    }
    if (!purpose) {
      toast.error("Say why the cash moved — that is what makes the books add up");
      return;
    }
    // Both dates: where the entry is now, and where it is being moved to.
    // Checking only one would let an entry be dragged into or out of a closed
    // month, which changes that month's totals either way.
    if (!canPost(date, editing?.date)) return;
    setSaving(true);
    if (editing) {
      CashAdjustmentRepo.update(editing.id, {
        date,
        type,
        amount: n,
        purpose,
        reason: reason.trim() || undefined,
      });
      toast.success(`Cash entry updated: ${fmtMoney(n)}`);
    } else {
      CashAdjustmentRepo.add({
        voucherNo: nextVoucherNo("CV-", CashAdjustmentRepo.allWithVoided()),
        date,
        type,
        amount: n,
        purpose,
        reason: reason.trim() || undefined,
      });
      toast.success(`Cash ${type === "add" ? "added" : "reduced"}: ${fmtMoney(n)}`);
    }
    onSaved();
    close(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Cash Entry" : "Add Cash Entry"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="space-y-3.5">
          {/* WHY the cash moved, asked before how much.
              This screen used to ask only for a direction and a free-text
              reason, which is how ₹29,000 of cash arrived with the note "CASH
              ADD TILL TODAY FROM VYAPAR" and no account behind it — real money
              in the drawer that the P&L then quietly absorbed as profit.
              Every accounting system answers this the same way: the movement
              has a second side, and the second side is an account.

              Asked FIRST, and it sets the direction, because "owner took out"
              already says which way the money went. Asking again would be the
              same question twice. */}
          <label className="block">
            <span className="text-[12px] font-medium text-muted-foreground block mb-1">
              Why did the cash move? *
            </span>
            <div
              role="radiogroup"
              aria-label="Reason for the cash movement"
              className="grid grid-cols-1 sm:grid-cols-2 gap-1.5"
            >
              {CHOOSABLE_PURPOSES.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  role="radio"
                  aria-checked={purpose === p.key}
                  title={p.hint}
                  onClick={() => {
                    setPurpose(p.key);
                    // The purpose decides the direction where only one makes
                    // sense; the two-way ones leave whatever is set alone.
                    if (p.direction) setType(p.direction);
                  }}
                  className={`h-9 px-3 rounded-md border text-[13px] font-semibold text-left transition ${
                    purpose === p.key
                      ? "border-primary bg-primary-soft text-primary"
                      : "border-input bg-background text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {chosenPurpose && (
              <p className="text-[11px] text-gray-400 mt-1.5">{chosenPurpose.hint}</p>
            )}
          </label>

          {/* Direction stays visible, because the two-way purposes need it and
              because seeing which way the money went is worth a glance even
              when the purpose already decided it. */}
          <label className="block">
            <span className="text-[12px] font-medium text-muted-foreground block mb-1">
              Direction
            </span>
            <div
              role="radiogroup"
              aria-label="Direction"
              className="grid grid-cols-2 rounded-md border border-input overflow-hidden"
            >
              {(
                [
                  ["add", "Cash In"],
                  ["reduce", "Cash Out"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={type === key}
                  disabled={!!chosenPurpose?.direction}
                  title={
                    chosenPurpose?.direction
                      ? `"${chosenPurpose.label}" is always ${chosenPurpose.direction === "add" ? "cash in" : "cash out"}`
                      : undefined
                  }
                  onClick={() => setType(key)}
                  className={`h-9 text-[13px] font-semibold transition disabled:cursor-not-allowed ${
                    type === key
                      ? key === "add"
                        ? "bg-emerald-600 text-white"
                        : "bg-rose-600 text-white"
                      : "bg-background text-muted-foreground hover:bg-accent disabled:opacity-40"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </label>

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
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Opening cash, owner drawing, counting correction…"
          />

          {/* What this will DO, not what the balance happens to be. On an edit
              the useful number is where cash in hand ends up, which is the
              current figure with the old entry swapped for the new one. */}
          <div className="text-[12px] bg-muted/50 border rounded-md px-3 py-2 flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Cash in hand</span>
            <span className="flex items-center gap-2">
              <span className="tabular-nums">{fmtMoney(currentBalance)}</span>
              {nextBalance !== currentBalance && (
                <>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  <span
                    className={`font-semibold tabular-nums ${
                      nextBalance > currentBalance ? "text-emerald-700" : "text-rose-700"
                    }`}
                  >
                    {fmtMoney(nextBalance)}
                  </span>
                </>
              )}
            </span>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : editing ? "Save Changes" : "Add Entry"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

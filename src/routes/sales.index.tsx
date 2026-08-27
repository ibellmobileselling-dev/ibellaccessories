import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { matchesQuery } from "@/lib/search";
import { useEffect, useMemo, useState } from "react";
import {
  SalesRepo,
  PartyRepo,
  ItemRepo,
  PaymentRepo,
  BankRepo,
  SaleReturnRepo,
} from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";
import { newBatch, commitBatch } from "@/repositories/base";
import type { Invoice } from "@/types";
import { fmtDate, fmtDateShort, fmtMoney, today, ymd } from "@/lib/format";
import {
  Plus,
  Search,
  X,
  ChevronDown,
  FileText,
  Trash2,
  Ban,
  Pencil,
  Receipt,
  SlidersHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import { PaginationBar } from "@/components/Pagination";
import { usePagination } from "@/hooks/usePagination";
import { usePeriodLock } from "@/hooks/usePeriodLock";
import { DataTable } from "@/components/DataTable";
import { fmtMode } from "@/lib/paymentMode";
import { PageHeader } from "@/components/PageHeader";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePermissions } from "@/hooks/usePermissions";
import { VoidDialog, VoidedBadge } from "@/components/VoidDialog";
import { canDeleteOutright, isVoided, removalWord } from "@/lib/voiding";

export const Route = createFileRoute("/sales/")({ component: SalesPage });

type Status = "all" | "paid" | "partial" | "unpaid";

// Computed per mount (NOT module constants) — a tab left open overnight
// would otherwise keep filtering on yesterday's date and hide new bills
const monthStart = () => ymd(new Date(new Date().getFullYear(), new Date().getMonth(), 1));

// Keeps the filters selected everywhere — across leaving to view/edit an
// invoice, across leaving to a different page entirely and coming back,
// anything short of an actual page reload (which starts fresh again).
let filterCache: {
  dateFrom: string;
  dateTo: string;
  partyId: string;
  status: Status;
  search: string;
} | null = null;

function SalesPage() {
  const navigate = useNavigate();
  const { isOwner, canEdit, canDelete } = usePermissions();
  const editAllowed = isOwner || canEdit("sales");
  const deleteAllowed = isOwner || canDelete("sales");
  const [rows, setRows] = useState<Invoice[]>([]);
  const [parties, setParties] = useState<{ id: string; name: string }[]>([]);
  const [dateFrom, setDateFrom] = useState(() => filterCache?.dateFrom ?? monthStart());
  const [dateTo, setDateTo] = useState(() => filterCache?.dateTo ?? today());
  const [partyId, setPartyId] = useState(() => filterCache?.partyId ?? "all");
  const [status, setStatus] = useState<Status>(() => filterCache?.status ?? "all");
  const [search, setSearch] = useState(() => filterCache?.search ?? "");
  const [showPartyDrop, setShowPartyDrop] = useState(false);
  const [partyDropQ, setPartyDropQ] = useState("");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  // Cancelled bills are off the list by default. They never stop existing —
  // this only decides whether they are in the way.
  const [showVoided, setShowVoided] = useState(false);
  const [voiding, setVoiding] = useState<Invoice | null>(null);

  const refresh = () => {
    setRows(showVoided ? SalesRepo.allWithVoided() : SalesRepo.all());
    setParties(PartyRepo.all().map((p) => ({ id: p.id, name: p.name })));
  };
  const _repoV = useRepoData();
  useEffect(refresh, [_repoV, showVoided]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (dateFrom && r.date < dateFrom) return false;
      if (dateTo && r.date > dateTo) return false;
      if (partyId !== "all" && r.partyId !== partyId) return false;
      if (status !== "all") {
        const bal = Math.round((r.total - r.paid) * 100) / 100;
        if (status === "paid" && bal > 0) return false;
        if (status === "unpaid" && r.paid > 0) return false;
        if (status === "partial" && (r.paid === 0 || bal <= 0)) return false;
      }
      if (search) {
        const q = search.toLowerCase();
        if (!matchesQuery(q, r.number, r.partyName)) return false;
      }
      return true;
    });
  }, [rows, dateFrom, dateTo, partyId, status, search]);

  const { canPost } = usePeriodLock();
  const pg = usePagination(filtered, "sales");
  const totalAmount = filtered.reduce((a, r) => a + r.total, 0);
  const totalPaid = filtered.reduce((a, r) => a + r.paid, 0);
  const totalBalance = filtered.reduce((a, r) => a + Math.max(0, r.total - r.paid), 0);
  const paidCount = filtered.filter((r) => r.total - r.paid <= 0).length;
  const unpaidCount = filtered.filter((r) => r.paid === 0 && r.total > 0).length;
  const partialCount = filtered.filter((r) => r.paid > 0 && r.total - r.paid > 0).length;

  const selectedParty = parties.find((p) => p.id === partyId);

  // Local search over the dropdown only — must never overwrite `parties`
  // itself, or the master list (used for `selectedParty` lookup and "All
  // Customers") gets stuck as whatever subset was last typed/searched.
  const filteredDropdownParties = useMemo(() => {
    const q = partyDropQ.trim().toLowerCase();
    return q ? parties.filter((p) => p.name.toLowerCase().includes(q)) : parties;
  }, [parties, partyDropQ]);

  const clearFilters = () => {
    setDateFrom(monthStart());
    setDateTo(today());
    setPartyId("all");
    setStatus("all");
    setSearch("");
  };
  const filtersActive =
    dateFrom !== monthStart() ||
    dateTo !== today() ||
    partyId !== "all" ||
    status !== "all" ||
    search !== "";

  useEffect(() => {
    filterCache = { dateFrom, dateTo, partyId, status, search };
  }, [dateFrom, dateTo, partyId, status, search]);

  const handleDelete = (r: Invoice) => {
    if (!deleteAllowed) {
      toast.error("You don't have permission to delete sales");
      return;
    }
    if (!canPost(r.date)) return;
    // A sale return credits stock and the customer's balance against THIS
    // invoice. Deleting the invoice underneath it would leave the return as
    // an orphan — the credit survives with no matching sale, so the customer
    // balance goes negative (we'd "owe" them) and stock is double-counted.
    // Block until the linked return(s) are deleted first.
    const linkedReturns = SaleReturnRepo.all().filter(
      (ret) => (ret.originalRef ?? "").trim() === r.number.trim(),
    );
    if (linkedReturns.length) {
      toast.error(
        `Can't delete ${r.number} — it has ${linkedReturns.length} sale return(s) against it (${linkedReturns
          .map((x) => x.number)
          .join(", ")}). Delete the return(s) first.`,
      );
      return;
    }
    // Anything dated before today is cancelled, not destroyed — its month
    // has already been counted. See lib/voiding.ts.
    if (!canDeleteOutright(r.date)) {
      const live = SalesRepo.get(r.id);
      if (!live) {
        toast.info(`Invoice ${r.number} is no longer there`);
        refresh();
        return;
      }
      if (isVoided(live)) {
        toast.info(`${r.number} is already voided`);
        return;
      }
      setVoiding(live);
      return;
    }
    if (
      !confirm(
        `Delete invoice ${r.number}? Sold quantities will be added back to stock, and any payments applied to it will become advance payments.`,
      )
    )
      return;
    // Another device (or a stale row) may have already deleted this invoice.
    // Re-read the live doc and bail if it's gone — the stock/bank reversals
    // below are blind atomic increments, so running them a second time would
    // double-restore stock and double-reverse the bank balance. Reverse from
    // the LIVE doc, not the possibly-stale list row.
    const live = SalesRepo.get(r.id);
    if (!live) {
      toast.info(`Invoice ${r.number} was already deleted`);
      refresh();
      return;
    }
    const batch = newBatch();
    undoSaleEffects(batch, live);
    SalesRepo.removeBatched(batch, live.id);
    commitBatch(batch, "delete sale");
    refresh();
    toast.success("Invoice deleted — stock restored");
  };

  /**
   * Everything a sale did to a stored running total, put back.
   *
   * Shared by delete and void because they owe the shop exactly the same
   * reversals — stock and a bank balance are the only two figures the app
   * stores rather than derives, so they are the only two a cancelled bill
   * cannot fix by itself. Written once: two copies would drift, and the drift
   * would be silent.
   */
  const undoSaleEffects = (batch: ReturnType<typeof newBatch>, live: Invoice) => {
    for (const l of live.lineItems) {
      const it = ItemRepo.get(l.itemId);
      if (it) ItemRepo.adjustFieldBatched(batch, it.id, "stock", l.qty);
    }
    // Payments applied to this invoice: unlink them so the money stays
    // counted as an advance instead of silently disappearing.
    for (const p of PaymentRepo.all()) {
      if (p.allocations?.some((a) => a.invoiceId === live.id)) {
        const remaining = p.allocations.filter((a) => a.invoiceId !== live.id);
        PaymentRepo.updateBatched(batch, p.id, {
          allocations: remaining.length ? remaining : undefined,
        });
      }
    }
    // Undo whatever this sale moved on a specific bank account at billing
    // time, or that account's balance stays permanently wrong.
    if (live.paymentMode === "bank" && live.bankId && (live.bankPaidAmount ?? 0) > 0) {
      BankRepo.adjustFieldBatched(batch, live.bankId, "balance", -live.bankPaidAmount!);
    }
  };

  /** Cancel a bill that is older than today. It stays; it stops counting. */
  const handleVoid = (live: Invoice, reason: string) => {
    const batch = newBatch();
    undoSaleEffects(batch, live);
    if (!SalesRepo.voidBatched(batch, live.id, reason)) {
      toast.info(`Invoice ${live.number} was already voided`);
      setVoiding(null);
      return;
    }
    commitBatch(batch, "void sale");
    setVoiding(null);
    refresh();
    toast.success(`${live.number} voided — stock restored, and the bill stays on record`);
  };

  const STATUSES: { value: Status; label: string }[] = [
    { value: "all", label: "All" },
    { value: "paid", label: "Paid" },
    { value: "partial", label: "Partial" },
    { value: "unpaid", label: "Unpaid" },
  ];

  return (
    <div className="flex flex-col h-full bg-[#f5f6fa]">
      <PageHeader
        title="Sales"
        subtitle={`${filtered.length} of ${rows.length} invoices`}
        icon={<Receipt className="h-5 w-5" />}
        iconClassName="text-success"
        mobileAction={
          <button
            onClick={() => setMobileFiltersOpen(true)}
            className="relative h-9 w-9 flex items-center justify-center rounded-lg border border-gray-200 bg-gray-50/60 text-gray-600"
            title="Filters"
          >
            <SlidersHorizontal className="h-4 w-4" />
            {filtersActive && (
              <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-primary" />
            )}
          </button>
        }
        actions={
          <>
            {/* Date range — its own filter sheet on mobile (see Filters
                button above); this inline row is desktop only, since it
                doesn't fit next to Customer/Status/Search on a phone. */}
            <div className="hidden sm:flex items-center gap-1.5 h-9 pl-3 pr-2.5 rounded-lg border border-gray-200 bg-gray-50/60">
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
            </div>

            {/* Party filter — desktop only, see Filters sheet on mobile */}
            <div className="hidden sm:block relative">
              <button
                onClick={() => setShowPartyDrop((v) => !v)}
                className="flex items-center gap-2 h-9 border border-gray-200 rounded-lg text-xs px-3 text-gray-700 bg-gray-50/60 hover:bg-gray-100 transition min-w-[140px]"
              >
                <span className="flex-1 text-left truncate">
                  {selectedParty ? selectedParty.name : "All Customers"}
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
              </button>
              {showPartyDrop && (
                <div className="absolute top-full right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-30 w-56 max-h-64 overflow-auto">
                  <div className="p-2 border-b">
                    <input
                      autoFocus
                      placeholder="Search customer..."
                      value={partyDropQ}
                      className="w-full text-xs px-2 py-1.5 border border-gray-200 rounded focus:outline-none"
                      onChange={(e) => setPartyDropQ(e.target.value)}
                    />
                  </div>
                  <button
                    onClick={() => {
                      setPartyId("all");
                      setShowPartyDrop(false);
                      setPartyDropQ("");
                    }}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-blue-50 ${partyId === "all" ? "text-blue-600 font-semibold bg-blue-50" : "text-gray-700"}`}
                  >
                    All Customers
                  </button>
                  {filteredDropdownParties.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        setPartyId(p.id);
                        setShowPartyDrop(false);
                        setPartyDropQ("");
                      }}
                      className={`w-full text-left px-3 py-2 text-xs hover:bg-blue-50 truncate ${partyId === p.id ? "text-blue-600 font-semibold bg-blue-50" : "text-gray-700"}`}
                    >
                      {p.name}
                    </button>
                  ))}
                  {filteredDropdownParties.length === 0 && (
                    <p className="text-xs text-gray-400 text-center py-3">No customers found</p>
                  )}
                </div>
              )}
            </div>

            {/* Status filter — desktop only, see Filters sheet on mobile */}
            <div className="hidden sm:flex items-center gap-0.5 h-9 border border-gray-200 rounded-lg p-0.5 bg-gray-50/60">
              {STATUSES.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setStatus(s.value)}
                  className={`px-2.5 h-7 rounded-md text-xs transition outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${status === s.value ? "bg-primary text-primary-foreground font-semibold" : "text-gray-500 hover:bg-gray-100"}`}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <button
              onClick={() => setShowVoided((v) => !v)}
              className={`hidden sm:inline-flex items-center gap-1.5 h-9 px-2.5 rounded-lg border text-xs transition ${
                showVoided
                  ? "border-rose-200 bg-rose-50 text-rose-700 font-semibold"
                  : "border-gray-200 bg-gray-50/60 text-gray-500 hover:bg-gray-100"
              }`}
              title="Cancelled bills stay on record — this decides whether they are in the way"
            >
              <Ban className="h-3.5 w-3.5" /> Voided
            </button>

            {/* Search — the one filter kept inline on every screen size */}
            <div className="relative w-full sm:w-48">
              <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search invoice, customer..."
                className="w-full h-9 pl-9 pr-3 rounded-lg border border-gray-200 bg-gray-50/60 text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/20 focus:bg-white transition"
              />
            </div>

            {filtersActive && (
              <button
                onClick={clearFilters}
                className="hidden sm:flex text-xs text-gray-400 hover:text-gray-600 transition items-center gap-1"
              >
                <X className="h-3 w-3" /> Clear
              </button>
            )}

            {editAllowed && (
              <button
                onClick={() => navigate({ to: "/sales/new" })}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 h-9 px-4 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:opacity-90 transition"
              >
                <Plus className="h-4 w-4" /> Add Sale
              </button>
            )}
          </>
        }
      />

      {/* Mobile filter sheet — Date Range/Customer/Status don't fit inline
          next to Search on a phone, so they live here behind the header's
          Filters button instead, same state as the desktop inline controls. */}
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
            <div>
              <label className="text-xs font-semibold text-gray-500 block mb-1.5">Customer</label>
              <div className="relative">
                <button
                  onClick={() => setShowPartyDrop((v) => !v)}
                  className="w-full flex items-center gap-2 h-9 border border-gray-200 rounded-lg text-sm px-3 text-gray-700 bg-gray-50/60 hover:bg-gray-100 transition"
                >
                  <span className="flex-1 text-left truncate">
                    {selectedParty ? selectedParty.name : "All Customers"}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                </button>
                {showPartyDrop && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-30 max-h-52 overflow-auto">
                    <div className="p-2 border-b">
                      <input
                        autoFocus
                        placeholder="Search customer..."
                        value={partyDropQ}
                        className="w-full text-sm px-2 py-1.5 border border-gray-200 rounded focus:outline-none"
                        onChange={(e) => setPartyDropQ(e.target.value)}
                      />
                    </div>
                    <button
                      onClick={() => {
                        setPartyId("all");
                        setShowPartyDrop(false);
                        setPartyDropQ("");
                      }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 ${partyId === "all" ? "text-blue-600 font-semibold bg-blue-50" : "text-gray-700"}`}
                    >
                      All Customers
                    </button>
                    {filteredDropdownParties.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          setPartyId(p.id);
                          setShowPartyDrop(false);
                          setPartyDropQ("");
                        }}
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 truncate ${partyId === p.id ? "text-blue-600 font-semibold bg-blue-50" : "text-gray-700"}`}
                      >
                        {p.name}
                      </button>
                    ))}
                    {filteredDropdownParties.length === 0 && (
                      <p className="text-xs text-gray-400 text-center py-3">No customers found</p>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 block mb-1.5">Status</label>
              <div className="flex items-center gap-1 border border-gray-200 rounded-lg p-1 bg-gray-50/60">
                {STATUSES.map((s) => (
                  <button
                    key={s.value}
                    onClick={() => setStatus(s.value)}
                    className={`flex-1 h-8 rounded-md text-xs font-medium transition ${status === s.value ? "bg-primary text-primary-foreground font-semibold" : "text-gray-500 hover:bg-gray-100"}`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between pt-1">
              {filtersActive ? (
                <button
                  onClick={clearFilters}
                  className="text-xs text-gray-400 hover:text-gray-600 transition flex items-center gap-1"
                >
                  <X className="h-3 w-3" /> Clear all
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

      {/* Mobile card list — a table of 10 columns doesn't fit a phone;
          this is the same data as one tappable card per invoice instead. */}
      <div className="md:hidden flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <FileText className="h-10 w-10 mx-auto mb-3 text-gray-200" />
            <p className="font-medium">No invoices found</p>
            <p className="text-xs mt-1">Try adjusting filters or add a new sale</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pg.paged.map((r) => {
              const balance = Math.round((r.total - r.paid) * 100) / 100;
              const isPaid = balance <= 0;
              const isPartial = r.paid > 0 && balance > 0;
              return (
                <div
                  key={r.id}
                  onClick={() => navigate({ to: "/sales/$id", params: { id: r.id } })}
                  className="bg-white px-4 py-3 active:bg-gray-50 flex items-center gap-3"
                >
                  {/* Status-tinted icon: green=paid, amber=partial, red=unpaid */}
                  <div
                    className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${isPaid ? "bg-emerald-50 text-emerald-600" : isPartial ? "bg-amber-50 text-amber-600" : "bg-rose-50 text-rose-600"}`}
                  >
                    <Receipt className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-[13px] text-gray-800 truncate leading-tight">
                        {r.partyName}
                      </p>
                      <p className="font-bold text-[13px] text-gray-800 tabular-nums shrink-0 leading-tight">
                        {fmtMoney(r.total)}
                      </p>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-1">
                      <p className="text-[11px] text-gray-400 font-mono truncate">
                        <span className={isVoided(r) ? "line-through" : ""}>{r.number}</span> ·{" "}
                        {fmtDate(r.date)} · {fmtMode(r.paymentMode)}
                        {isVoided(r) && (
                          <>
                            {" "}
                            <VoidedBadge reason={r.voidReason} at={r.voidedAt} />
                          </>
                        )}
                      </p>
                      {balance > 0 ? (
                        <span className="text-[11px] font-semibold text-rose-600 shrink-0">
                          Due {fmtMoney(balance)}
                        </span>
                      ) : (
                        <span className="text-[11px] font-semibold text-emerald-600 shrink-0">
                          Paid
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
                            navigate({ to: "/sales/edit/$id", params: { id: r.id } });
                          }}
                          className="p-1.5 rounded hover:bg-blue-50 text-gray-300 hover:text-blue-600 transition"
                          title="Edit invoice"
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
                          title={`${removalWord(r.date)} invoice`}
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
          storageKey="sales"
          activateOnClick
          columns={[
            {
              key: "number",
              label: "Invoice #",
              render: (r) => (
                <span className="inline-flex items-center gap-1.5">
                  <span className={`font-mono ${isVoided(r) ? "line-through text-gray-400" : ""}`}>
                    {r.number}
                  </span>
                  {isVoided(r) && <VoidedBadge reason={r.voidReason} at={r.voidedAt} />}
                </span>
              ),
              sortValue: (r) => r.number,
            },
            {
              key: "date",
              label: "Date",
              render: (r) => <span className="whitespace-nowrap">{fmtDateShort(r.date)}</span>,
              sortValue: (r) => r.date,
            },
            {
              key: "customer",
              label: "Customer",
              render: (r) => <span className="max-w-[160px] truncate block">{r.partyName}</span>,
              sortValue: (r) => r.partyName,
            },
            {
              key: "items",
              label: "Items",
              align: "right",
              render: (r) => r.lineItems.length,
              sortValue: (r) => r.lineItems.length,
            },
            {
              key: "total",
              label: "Total Amount",
              align: "right",
              render: (r) => <span className="tabular-nums">{fmtMoney(r.total)}</span>,
              sortValue: (r) => r.total,
            },
            {
              key: "paid",
              label: "Paid",
              align: "right",
              render: (r) => <span className="tabular-nums">{fmtMoney(r.paid)}</span>,
              sortValue: (r) => r.paid,
            },
            {
              key: "balance",
              label: "Balance",
              align: "right",
              render: (r) => {
                const balance = Math.round((r.total - r.paid) * 100) / 100;
                return <span className="tabular-nums">{fmtMoney(Math.max(0, balance))}</span>;
              },
              sortValue: (r) => Math.max(0, Math.round((r.total - r.paid) * 100) / 100),
            },
            {
              key: "status",
              label: "Status",
              render: (r) => {
                const balance = Math.round((r.total - r.paid) * 100) / 100;
                return (
                  <StatusBadge
                    paid={balance <= 0}
                    partial={r.paid > 0 && balance > 0}
                    unpaid={r.paid === 0 && r.total > 0}
                  />
                );
              },
            },
            {
              key: "mode",
              label: "Mode",
              render: (r) => fmtMode(r.paymentMode),
            },
            {
              key: "action",
              label: "Action",
              align: "center",
              render: (r) => (
                <span className="whitespace-nowrap">
                  {editAllowed && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate({ to: "/sales/edit/$id", params: { id: r.id } });
                      }}
                      className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-primary-soft hover:text-primary hover:border-primary/25"
                      title="Edit invoice"
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
                      title={`${removalWord(r.date)} invoice`}
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
          ]}
          rows={filtered}
          rowKey={(r) => r.id}
          onRowActivate={(r) => navigate({ to: "/sales/$id", params: { id: r.id } })}
          emptyMessage="No invoices found — try adjusting filters or add a new sale"
          footer={
            <tr>
              <td colSpan={4}>Total ({filtered.length} invoices)</td>
              <td className="text-right tabular-nums">{fmtMoney(totalAmount)}</td>
              <td className="text-right tabular-nums">{fmtMoney(totalPaid)}</td>
              <td className="text-right tabular-nums">{fmtMoney(totalBalance)}</td>
              <td colSpan={3} />
            </tr>
          }
        />
      </div>
      <div className="md:hidden">
        <PaginationBar
          page={pg.page}
          totalPages={pg.totalPages}
          pageSize={pg.pageSize}
          total={pg.total}
          onPage={pg.setPage}
          onPageSize={pg.setPageSize}
        />
      </div>

      <VoidDialog
        open={!!voiding}
        onOpenChange={(v) => !v && setVoiding(null)}
        what={`invoice ${voiding?.number ?? ""}`}
        effects={[
          "Sold quantities go back into stock",
          "Payments applied to it become advances again",
          ...(voiding?.paymentMode === "bank" &&
          voiding?.bankId &&
          (voiding?.bankPaidAmount ?? 0) > 0
            ? ["The amount collected into the bank account is reversed"]
            : []),
        ]}
        onConfirm={(reason) => voiding && handleVoid(voiding, reason)}
      />
    </div>
  );
}

function StatusBadge({
  paid,
  partial,
  unpaid,
}: {
  paid: boolean;
  partial: boolean;
  unpaid: boolean;
}) {
  if (paid) return "Paid";
  if (partial) return "Partial";
  if (unpaid) return "Unpaid";
  return null;
}

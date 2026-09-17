import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { matchesQuery } from "@/lib/search";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  SalesRepo,
  PurchaseRepo,
  ExpenseRepo,
  PaymentRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  CashAdjustmentRepo,
  BankRepo,
  BankTxnRepo,
  CompanyRepo,
} from "@/repositories";
import { buildBankLedger, paidViaPayments } from "@/lib/ledger";
import { fmtMoney, fmtDate, today, ymd } from "@/lib/format";
import { printOrEscapeStandalone } from "@/lib/print";
import { useAutoPrintFromUrl } from "@/hooks/useAutoPrintFromUrl";
import { useRepoData, useRepoMemo } from "@/hooks/useRepoData";
import { downloadElementAsPdf } from "@/lib/pdf";
import { useShareablePdf } from "@/hooks/useShareablePdf";
import { PaginationBar } from "@/components/Pagination";
import { usePagination } from "@/hooks/usePagination";
import { downloadCsv } from "@/lib/csv";
import { fmtMode } from "@/lib/paymentMode";
import { splitsOf, cashPart, bankParts, unassignedPart } from "@/lib/paymentSplit";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  BookOpen,
  Printer,
  Download,
  ChevronLeft,
  ChevronRight,
  Search,
  ShoppingCart,
  Truck,
  Receipt,
  TrendingUp,
  TrendingDown,
  Wallet,
  Landmark,
  FileDown,
  Share2,
  SlidersHorizontal,
  ArrowDownLeft,
  ArrowUpRight,
  Loader2,
} from "lucide-react";

export const Route = createFileRoute("/daybook")({
  component: DaybookPage,
  // `date` here is only ever set by printOrEscapeStandalone's standalone-app
  // print escape (see lib/print.ts) — it carries the date that was on
  // screen into the freshly opened tab, so re-entry prints the same day
  // instead of whatever today()/dateCache falls back to.
  validateSearch: (search: Record<string, unknown>): { date?: string } => ({
    date: typeof search.date === "string" ? search.date : undefined,
  }),
});

// Keeps the picked date selected everywhere — across leaving to view a
// linked sale/purchase/return, across leaving to a different page entirely
// and coming back, anything short of an actual page reload (which starts
// fresh again).
let dateCache: string | null = null;

interface DayRow {
  created: string;
  type: string;
  ref: string;
  party: string;
  mode: string;
  bankId?: string;
  amount: number; // full invoice/txn value, signed — drives the Total column and Sales/Purchase totals
  cash: number; // actual money that changed hands on this date, signed — drives Money In/Out and cash reconciliation. A credit sale has amount > 0 but cash = 0.
  /* Where that money went, signed like `cash` and summing to it.
     One document can now be part cash and part bank, so a single `mode`
     cannot answer "how much of today's takings is in the drawer". It stays
     ONE row per document — `amount` drives the Sales and Purchase totals and
     splitting the row would count the bill twice — and carries the
     breakdown instead. */
  cashPart: number;
  bankPart: number;
  unassignedPart: number;
  docId?: string;
  docKind?: "sale" | "purchase" | "sale-return" | "purchase-return";
}

function DaybookPage() {
  useRepoData();
  const navigate = useNavigate();
  const { date: dateFromUrl } = Route.useSearch();
  const [date, setDate] = useState(() => dateFromUrl ?? dateCache ?? today());
  const [q, setQ] = useState("");
  const [pdfBusy, setPdfBusy] = useState<"download" | "share" | null>(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dateCache = date;
  }, [date]);

  // Re-entry point for printOrEscapeStandalone's standalone-app escape (see
  // lib/print.ts) — the day's data is already loaded synchronously from the
  // repos, so this can fire as soon as the date search param above resolves.
  useAutoPrintFromUrl(`Daybook-${date}`, true);

  const rows = useRepoMemo<DayRow[]>(() => {
    const list: DayRow[] = [];
    /** The breakdown of one document's own money, signed. `sign` is -1 for
     *  anything leaving the shop. */
    const parts = (doc: Parameters<typeof splitsOf>[0], sign: 1 | -1, settled = 0) => {
      const bank = [...bankParts(doc, settled).values()].reduce((n, v) => n + v, 0);
      return {
        cashPart: sign * cashPart(doc, settled),
        bankPart: sign * bank,
        unassignedPart: sign * unassignedPart(doc, settled),
      };
    };
    // invoice.paid already folds in amounts later applied via Payment
    // records (see ledger.ts) — if we used it as-is here, a payment
    // collected after billing would count twice: once inside the Sale row's
    // cash figure, and again as its own Payment In/Out row below.
    const applied = paidViaPayments(PaymentRepo.all());
    for (const s of SalesRepo.all().filter((x) => x.date === date))
      list.push({
        created: s.createdAt,
        type: "Sale",
        ref: s.number,
        party: s.partyName,
        mode: s.paymentMode,
        bankId: s.bankId,
        amount: s.total,
        cash: Math.max(0, (s.paid || 0) - (applied.get(s.id) ?? 0)),
        ...parts(s, 1, applied.get(s.id) ?? 0),
        docId: s.id,
        docKind: "sale",
      });
    for (const p of PurchaseRepo.all().filter((x) => x.date === date))
      list.push({
        created: p.createdAt,
        type: "Purchase",
        ref: p.number,
        party: p.partyName,
        mode: p.paymentMode,
        bankId: p.bankId,
        amount: -p.total,
        cash: -Math.max(0, (p.paid || 0) - (applied.get(p.id) ?? 0)),
        ...parts(p, -1, applied.get(p.id) ?? 0),
        docId: p.id,
        docKind: "purchase",
      });
    for (const r of SaleReturnRepo.all().filter((x) => x.date === date))
      list.push({
        created: r.createdAt,
        type: "Sale Return",
        ref: r.number,
        party: r.partyName,
        mode: "—",
        amount: -r.total,
        cash: -r.total,
        /* Returns carry no payment fields at all — money against a note is
           a Payment, which appears as its own row. Zeroes here reproduce
           exactly what mode "—" did before: counted in the day's net, and in
           neither the cash nor the unassigned bucket. Whether that is right
           is a pre-existing question about how returns reconcile, and not
           one this change should answer quietly. */
        cashPart: 0,
        bankPart: 0,
        unassignedPart: 0,
        docId: r.id,
        docKind: "sale-return",
      });
    for (const r of PurchaseReturnRepo.all().filter((x) => x.date === date))
      list.push({
        created: r.createdAt,
        type: "Purchase Return",
        ref: r.number,
        party: r.partyName,
        mode: "—",
        amount: r.total,
        cash: r.total,
        /* Returns carry no payment fields at all — money against a note is
           a Payment, which appears as its own row. Zeroes here reproduce
           exactly what mode "—" did before: counted in the day's net, and in
           neither the cash nor the unassigned bucket. Whether that is right
           is a pre-existing question about how returns reconcile, and not
           one this change should answer quietly. */
        cashPart: 0,
        bankPart: 0,
        unassignedPart: 0,
        docId: r.id,
        docKind: "purchase-return",
      });
    for (const p of PaymentRepo.all().filter((x) => x.date === date))
      list.push({
        created: p.createdAt,
        type: p.type === "in" ? "Payment In" : "Payment Out",
        ref: p.allocations?.map((a) => a.number).join(", ") || p.ref || "—",
        party: p.partyName,
        mode: p.mode,
        bankId: p.bankId,
        amount: p.type === "in" ? p.amount : -p.amount,
        cash: p.type === "in" ? p.amount : -p.amount,
        ...parts(p, p.type === "in" ? 1 : -1),
      });
    for (const e of ExpenseRepo.all().filter((x) => x.date === date))
      list.push({
        created: e.createdAt,
        type: "Expense",
        ref: e.category,
        party: "—",
        mode: e.paymentMode,
        bankId: e.bankId,
        amount: -e.amount,
        cash: -e.amount,
        ...parts(e, -1),
      });
    for (const a of CashAdjustmentRepo.all().filter((x) => x.date === date))
      list.push({
        created: a.createdAt,
        type: a.type === "add" ? "Cash Added" : "Cash Reduced",
        ref: a.reason || "Adjustment",
        party: "—",
        mode: "cash",
        amount: a.type === "add" ? a.amount : -a.amount,
        cash: a.type === "add" ? a.amount : -a.amount,
        cashPart: a.type === "add" ? a.amount : -a.amount,
        bankPart: 0,
        unassignedPart: 0,
      });
    for (const t of BankTxnRepo.all().filter((x) => x.date === date))
      list.push({
        created: t.createdAt,
        type: t.type === "deposit" ? "Bank Deposit" : "Bank Withdrawal",
        ref: t.notes || "Adjustment",
        party: "—",
        mode: "bank",
        bankId: t.bankId,
        amount: t.type === "deposit" ? t.amount : -t.amount,
        cash: t.type === "deposit" ? t.amount : -t.amount,
        cashPart: 0,
        // A deposit or withdrawal always names its account.
        bankPart: t.type === "deposit" ? t.amount : -t.amount,
        unassignedPart: 0,
      });
    list.sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));
    return list;
  }, [date]);

  const bankNameById = useRepoMemo(() => new Map(BankRepo.all().map((b) => [b.id, b.name])));
  // "Bank (unspecified)" — not "Bank" — for older records saved before bank
  // selection existed, so it reads as "this one's missing data" rather than
  // looking like the bank name feature silently isn't working.
  const modeLabel = useCallback(
    (r: DayRow) => {
      if (r.mode !== "bank") return fmtMode(r.mode);
      if (!r.bankId) return "Bank (unspecified)";
      return `Bank — ${bankNameById.get(r.bankId) ?? "unspecified"}`;
    },
    [bankNameById],
  );

  // Per-bank movement for the day, plus balance as of end of day — reuses
  // the same passbook engine as the Bank Accounts page so the two never
  // disagree on a bank's numbers.
  const bankSummaries = useRepoMemo(() => {
    const banks = BankRepo.all();
    if (!banks.length) return [];
    const data = {
      sales: SalesRepo.all(),
      purchases: PurchaseRepo.all(),
      payments: PaymentRepo.all(),
      bankTxns: BankTxnRepo.all(),
      expenses: ExpenseRepo.all(),
    };
    return banks.map((b) => {
      const dayOnly = buildBankLedger(b, data, date, date);
      const upToDate = buildBankLedger(b, data, "", date);
      const closing = upToDate.rows.length
        ? upToDate.rows[upToDate.rows.length - 1].balance
        : b.openingBalance || 0;
      return { bank: b, in: dayOnly.totalCredit, out: dayOnly.totalDebit, closing };
    });
  }, [date]);

  const sum = (type: string) =>
    rows.filter((r) => r.type === type).reduce((s, r) => s + Math.abs(r.amount), 0);
  const totalSale = sum("Sale");
  const totalPurchase = sum("Purchase");
  const expense = sum("Expense");
  // Net/cash reconciliation is driven by `cash` (actual money moved), not
  // `amount` (invoice value) — a credit or partly-paid sale shouldn't count
  // as cash in just because it happened today.
  const net = rows.reduce((s, r) => s + r.cash, 0);
  // Off the breakdown, not the row's single mode: a part-cash bill puts only
  // its cash share in the drawer, and its bank share belongs to the account.
  const cashIn = rows.filter((r) => r.cashPart > 0).reduce((s, r) => s + r.cashPart, 0);
  const cashOut = Math.abs(rows.filter((r) => r.cashPart < 0).reduce((s, r) => s + r.cashPart, 0));
  // Bank-mode entries with no bankId (older records saved before bank
  // selection was required) and legacy upi/cheque modes aren't tied to any
  // real account — bucket them so the summary always reconciles with the
  // full day total instead of silently dropping that money from the view.
  const isUnassigned = (r: DayRow) =>
    (r.mode === "bank" && !r.bankId) || r.mode === "upi" || r.mode === "cheque";
  const unassignedIn = rows
    .filter((r) => isUnassigned(r) && r.cash > 0)
    .reduce((s, r) => s + r.cash, 0);
  const unassignedOut = Math.abs(
    rows.filter((r) => isUnassigned(r) && r.cash < 0).reduce((s, r) => s + r.cash, 0),
  );

  const filteredRows = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((r) => matchesQuery(s, r.type, r.ref, r.party, modeLabel(r)));
  }, [rows, q, modeLabel]);

  const totalMoneyIn = rows.filter((r) => r.cash > 0).reduce((s, r) => s + r.cash, 0);
  const totalMoneyOut = Math.abs(rows.filter((r) => r.cash < 0).reduce((s, r) => s + r.cash, 0));

  // Table footers cover the same rows the table shows — the whole-day
  // figures above stay on the KPI cards / Excel export, but next to a
  // search-filtered row count they'd lie.
  const footerNet = filteredRows.reduce((s, r) => s + r.cash, 0);
  const footerMoneyIn = filteredRows.filter((r) => r.cash > 0).reduce((s, r) => s + r.cash, 0);
  const footerMoneyOut = Math.abs(
    filteredRows.filter((r) => r.cash < 0).reduce((s, r) => s + r.cash, 0),
  );

  // Page size deliberately generous (100, vs. the usual 25/50) — this table
  // is also the exact snapshot the PDF/print export captures, so pagination
  // must never silently cut a busy day's transactions out of that export. A
  // single day realistically never gets close to 100 entries for this app.
  const pg = usePagination(filteredRows, "daybook", 100);

  const shiftDay = (delta: number) => {
    const [y, m, dd] = date.split("-").map(Number);
    const d = new Date(y, m - 1, dd + delta);
    setDate(ymd(d));
  };

  const openRow = (r: DayRow) => {
    if (!r.docId || !r.docKind) return;
    if (r.docKind === "sale") navigate({ to: "/sales/$id", params: { id: r.docId } });
    else if (r.docKind === "purchase") navigate({ to: "/purchase/$id", params: { id: r.docId } });
    else if (r.docKind === "sale-return")
      navigate({ to: "/sale-return/$id", params: { id: r.docId } });
    else navigate({ to: "/purchase-return/$id", params: { id: r.docId } });
  };

  const downloadExcel = () => {
    const meta: string[][] = [
      ["Daybook"],
      [`Company: ${CompanyRepo.get().name}`],
      [`Date: ${fmtDate(date)}`],
      [`Generated: ${fmtDate(new Date().toISOString())}`],
      [],
      ["Cash & Bank Summary"],
      ["Account", "In", "Out", "Closing Balance"],
      ["Cash", fmtMoney(cashIn), fmtMoney(cashOut), ""],
      ...bankSummaries.map((b) => [
        b.bank.name,
        fmtMoney(b.in),
        fmtMoney(b.out),
        fmtMoney(b.closing),
      ]),
      ...(unassignedIn || unassignedOut
        ? [["Other / Unspecified Bank", fmtMoney(unassignedIn), fmtMoney(unassignedOut), ""]]
        : []),
      [],
    ];
    const header = [
      "#",
      "Name",
      "Ref No",
      "Type",
      "Payment Type",
      "Total",
      "Money In",
      "Money Out",
    ];
    const body = rows.map((r, i) => [
      String(i + 1),
      r.party,
      r.ref,
      r.type,
      modeLabel(r),
      fmtMoney(Math.abs(r.amount)),
      r.cash > 0 ? fmtMoney(r.cash) : "",
      r.cash < 0 ? fmtMoney(Math.abs(r.cash)) : "",
    ]);
    const totalsRow = [
      "",
      "",
      "",
      "",
      "",
      "",
      `Total Money-In: ${fmtMoney(totalMoneyIn)}`,
      `Total Money-Out: ${fmtMoney(totalMoneyOut)}`,
    ];
    const netRow = [
      "",
      "",
      "",
      "",
      "",
      "",
      "Net for the day",
      `${net >= 0 ? "" : "-"}${fmtMoney(Math.abs(net))}`,
    ];
    const allRows = [...meta, header, ...body, [], totalsRow, netRow];
    downloadCsv(`Daybook-${date}`, allRows[0], allRows.slice(1));
  };

  const { shareReady, share, resetShare } = useShareablePdf("Daybook");

  const handleDownloadPdf = async () => {
    if (!printRef.current || pdfBusy) return;
    resetShare();
    setPdfBusy("download");
    try {
      await downloadElementAsPdf(printRef.current, `Daybook-${date}`, "portrait");
      toast.success("Daybook downloaded as PDF");
    } catch {
      toast.error("Could not generate PDF — try Print instead");
    } finally {
      setPdfBusy(null);
    }
  };

  const handleShare = async () => {
    if (!printRef.current || pdfBusy) return;
    setPdfBusy("share");
    try {
      await share(printRef.current, `Daybook-${date}`, "portrait");
    } catch {
      toast.error("Could not share daybook — try Download PDF instead");
    } finally {
      setPdfBusy(null);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#f5f6fa]">
      <div className="no-print bg-white border-b px-5 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center justify-between sm:justify-start gap-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-md bg-primary-soft text-primary flex items-center justify-center">
              <BookOpen className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-[17px] font-bold text-gray-800">Daybook</h1>
              <p className="text-[12px] text-gray-400">
                {rows.length} transactions on {fmtDate(date)}
              </p>
            </div>
          </div>
          {/* Date navigation + Search move into the Filters sheet on
              mobile — they don't fit inline next to the export/print icons
              on a phone. */}
          <button
            onClick={() => setMobileFiltersOpen(true)}
            className="sm:hidden relative h-9 w-9 shrink-0 flex items-center justify-center rounded-lg border border-gray-200 bg-gray-50/60 text-gray-600"
            title="Filters"
          >
            <SlidersHorizontal className="h-4 w-4" />
            {(date !== today() || q) && (
              <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-primary" />
            )}
          </button>
        </div>
        <div className="flex items-center gap-2 sm:ml-auto w-full sm:w-auto">
          <div className="hidden sm:flex items-center gap-2">
            <button
              onClick={() => shiftDay(-1)}
              className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-center text-gray-500"
              title="Previous day"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="border border-gray-200 rounded-md text-sm px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
            <button
              onClick={() => shiftDay(1)}
              className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-center text-gray-500"
              title="Next day"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              onClick={() => setDate(today())}
              className="h-8 px-3 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-xs font-semibold text-gray-600"
            >
              Today
            </button>
          </div>
          {/* Export/print actions — kept inline on every screen size,
              compact enough not to need a sheet of their own. */}
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              onClick={downloadExcel}
              className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition"
              title="Download daybook as Excel"
            >
              <Download className="h-4 w-4" />
            </button>
            <button
              onClick={handleDownloadPdf}
              disabled={pdfBusy !== null}
              className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition disabled:opacity-50"
              title="Download daybook as PDF"
            >
              <FileDown className="h-4 w-4" />
            </button>
            <button
              onClick={handleShare}
              disabled={pdfBusy !== null}
              className={`h-8 w-8 shrink-0 rounded-md border bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition disabled:opacity-50 ${shareReady ? "border-primary ring-2 ring-primary animate-pulse" : "border-gray-200"}`}
              title={shareReady ? "PDF ready — tap again to share" : "Share daybook PDF"}
            >
              <Share2 className="h-4 w-4" />
            </button>
            <button
              onClick={() =>
                printOrEscapeStandalone(`Daybook-${date}`, { date }, handleDownloadPdf)
              }
              disabled={!!pdfBusy}
              className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 h-8 px-3.5 bg-white border border-gray-200 rounded-md text-xs font-semibold text-gray-600 hover:bg-gray-50 transition disabled:opacity-60 disabled:cursor-not-allowed"
              title="Print"
            >
              {pdfBusy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Preparing…
                </>
              ) : (
                <>
                  <Printer className="h-4 w-4" /> Print
                </>
              )}
            </button>
          </div>
          <div className="hidden sm:block relative w-full sm:w-44 lg:w-56">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, ref no, type…"
              className="w-full h-8 pl-8 pr-3 border border-gray-200 rounded-md text-base sm:text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
          </div>
        </div>
      </div>

      {/* Mobile filter sheet — Date navigation and Search don't fit inline
          next to the export/print icons on a phone, so they live here
          behind the header's Filters button instead, same state as the
          desktop inline controls. */}
      <Dialog open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Filters</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-gray-500 block mb-1.5">Date</label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => shiftDay(-1)}
                  className="h-9 w-9 shrink-0 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-center text-gray-500"
                  title="Previous day"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="flex-1 h-9 border border-gray-200 rounded-lg text-sm px-2 bg-white focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <button
                  onClick={() => shiftDay(1)}
                  className="h-9 w-9 shrink-0 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-center text-gray-500"
                  title="Next day"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setDate(today())}
                  className="h-9 px-3 shrink-0 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-xs font-semibold text-gray-600"
                >
                  Today
                </button>
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 block mb-1.5">Search</label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search name, ref no, type…"
                  className="w-full h-9 pl-8 pr-3 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
            <div className="flex justify-end pt-1">
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

      {/* Summary — day totals and every cash/bank account as compact KPI
          cards in one row, so the table below gets the space instead of two
          stacked summary blocks. Payment In/Out were dropped — they just
          repeated numbers already visible per-account below. */}
      <div className="no-print bg-white border-b px-5 py-3 overflow-x-auto">
        <div className="flex items-stretch gap-3 min-w-max">
          <KpiCard
            icon={<ShoppingCart className="h-4 w-4" />}
            label="Sales"
            value={totalSale}
            tone="emerald"
          />
          <KpiCard
            icon={<Truck className="h-4 w-4" />}
            label="Purchase"
            value={totalPurchase}
            tone="rose"
          />
          <KpiCard
            icon={<Receipt className="h-4 w-4" />}
            label="Expenses"
            value={expense}
            tone="rose"
          />
          <KpiCard
            icon={
              net >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />
            }
            label="Net"
            value={net}
            tone={net >= 0 ? "emerald" : "rose"}
            signed
          />
          <div className="w-px bg-gray-100 my-1.5" />
          <AccountCard
            icon={<Wallet className="h-4 w-4" />}
            label="Cash"
            in={cashIn}
            out={cashOut}
          />
          {bankSummaries.map(({ bank, in: bankIn, out: bankOut, closing }) => (
            <AccountCard
              key={bank.id}
              icon={<Landmark className="h-4 w-4" />}
              label={bank.name}
              in={bankIn}
              out={bankOut}
              balance={closing}
            />
          ))}
          {(unassignedIn > 0 || unassignedOut > 0) && (
            <AccountCard
              icon={<Landmark className="h-4 w-4" />}
              label="Other / Unspecified"
              in={unassignedIn}
              out={unassignedOut}
              warn
            />
          )}
        </div>
      </div>

      <div className="p-6 flex-1 min-h-0 flex">
        <div
          ref={printRef}
          className="print-visible flex-1 min-h-0 flex flex-col bg-white border border-gray-200/80 rounded-xl shadow-card overflow-hidden print:shadow-none print:border-none print:rounded-none print:p-6"
        >
          <div className="data-table flex-1 overflow-auto">
            {/* The mobile/desktop split below is screen-only — print must
                always show the real table regardless of the device it's
                triggered from (a phone's own Print button included), so
                this overrides both sides of the split back for @media
                print rather than trusting how a given browser resolves
                `md:` during an actual print render. */}
            <style>{`@media print {
              .daybook-mobile-cards { display: none !important; }
              .daybook-table { display: table !important; }
            }`}</style>
            {/* Mobile card list — an 8-column table doesn't fit a phone;
                this is the same day's transactions as one tappable card per
                entry instead. */}
            <div className="md:hidden daybook-mobile-cards">
              {pg.paged.length === 0 ? (
                <p className="text-center py-14 text-gray-400">
                  {rows.length === 0 ? "No transactions on this day" : "No matches for your search"}
                </p>
              ) : (
                <div className="divide-y divide-gray-100">
                  {pg.paged.map((r, i) => {
                    const isIn = r.cash > 0;
                    const isOut = r.cash < 0;
                    return (
                      <div
                        key={i}
                        onClick={() => openRow(r)}
                        className={`flex items-center gap-3 px-4 py-3 ${r.docId ? "cursor-pointer active:bg-gray-50" : ""}`}
                      >
                        <div
                          className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${isIn ? "bg-emerald-50 text-emerald-600" : isOut ? "bg-rose-50 text-rose-600" : "bg-gray-100 text-gray-400"}`}
                        >
                          {isOut ? (
                            <ArrowUpRight className="h-4 w-4" />
                          ) : (
                            <ArrowDownLeft className="h-4 w-4" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-semibold text-[13px] text-gray-800 truncate leading-tight">
                              {r.party}
                            </p>
                            <p className="font-bold text-[13px] tabular-nums shrink-0 leading-tight text-gray-800">
                              {fmtMoney(Math.abs(r.amount))}
                            </p>
                          </div>
                          <div className="flex items-center justify-between gap-2 mt-1">
                            <p className="text-[11px] text-gray-400 truncate">
                              {r.type} · {modeLabel(r)}
                              {r.ref ? ` · ${r.ref}` : ""}
                            </p>
                            {r.cash !== 0 && (
                              <span
                                className={`text-[11px] font-semibold shrink-0 ${isIn ? "text-emerald-600" : "text-rose-600"}`}
                              >
                                {isIn ? `+${fmtMoney(r.cash)}` : `−${fmtMoney(Math.abs(r.cash))}`}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {filteredRows.length > 0 && (
                <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-t text-xs font-bold text-gray-600">
                  <span>Total ({filteredRows.length})</span>
                  <span className="tabular-nums">{fmtMoney(footerNet)}</span>
                </div>
              )}
            </div>

            <table className="hidden md:table daybook-table w-full min-w-max text-[12.5px]">
              <thead>
                <tr>
                  {[
                    "#",
                    "Name",
                    "Ref No",
                    "Type",
                    "Payment Type",
                    "Total",
                    "Money In",
                    "Money Out",
                  ].map((h, i) => (
                    <th key={h} style={{ textAlign: i >= 5 ? "right" : "left" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pg.paged.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-14 text-gray-400">
                      {rows.length === 0
                        ? "No transactions on this day"
                        : "No matches for your search"}
                    </td>
                  </tr>
                ) : (
                  pg.paged.map((r, i) => (
                    <tr
                      key={i}
                      onClick={() => openRow(r)}
                      title={r.docId ? "Open this bill" : undefined}
                      className={r.docId ? "cursor-pointer" : ""}
                    >
                      <td className="text-gray-400 text-[11px]">
                        {(pg.page - 1) * pg.pageSize + i + 1}
                      </td>
                      <td>{r.party}</td>
                      <td className="font-mono text-xs">{r.ref}</td>
                      <td>{r.type}</td>
                      <td className="text-gray-500 text-xs">{modeLabel(r)}</td>
                      <td className="text-right tabular-nums">{fmtMoney(Math.abs(r.amount))}</td>
                      <td className="text-right tabular-nums">
                        {r.cash > 0 ? fmtMoney(r.cash) : "—"}
                      </td>
                      <td className="text-right tabular-nums">
                        {r.cash < 0 ? fmtMoney(Math.abs(r.cash)) : "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {filteredRows.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={5}>Total ({filteredRows.length} transactions)</td>
                    <td className="text-right tabular-nums">{fmtMoney(footerNet)}</td>
                    <td className="text-right tabular-nums">{fmtMoney(footerMoneyIn)}</td>
                    <td className="text-right tabular-nums">{fmtMoney(footerMoneyOut)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <div className="no-print">
            <PaginationBar
              page={pg.page}
              totalPages={pg.totalPages}
              pageSize={pg.pageSize}
              total={pg.total}
              onPage={pg.setPage}
              onPageSize={pg.setPageSize}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

const TONES = {
  emerald: { bg: "bg-emerald-50", text: "text-emerald-600" },
  rose: { bg: "bg-rose-50", text: "text-rose-600" },
} as const;

function KpiCard({
  icon,
  label,
  value,
  tone,
  signed,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tone: keyof typeof TONES;
  signed?: boolean;
}) {
  const t = TONES[tone];
  return (
    <div className="shrink-0 flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg border border-gray-100 bg-white">
      <div
        className={`h-8 w-8 rounded-md flex items-center justify-center shrink-0 ${t.bg} ${t.text}`}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wide mb-0.5 whitespace-nowrap">
          {label}
        </p>
        <p className={`text-[14px] font-bold tabular-nums whitespace-nowrap ${t.text}`}>
          {signed && value < 0 ? "−" : ""}
          {fmtMoney(Math.abs(value))}
        </p>
      </div>
    </div>
  );
}

function AccountCard({
  icon,
  label,
  in: inAmt,
  out: outAmt,
  balance,
  warn,
}: {
  icon: ReactNode;
  label: string;
  in: number;
  out: number;
  balance?: number;
  warn?: boolean;
}) {
  return (
    <div
      className={`shrink-0 flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg border ${
        warn ? "border-amber-200 bg-amber-50/50" : "border-gray-100 bg-white"
      }`}
    >
      <div
        className={`h-8 w-8 rounded-md flex items-center justify-center shrink-0 ${
          warn ? "bg-amber-100 text-amber-600" : "bg-primary-soft text-primary"
        }`}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wide mb-0.5 truncate max-w-[130px]">
          {label}
        </p>
        <p className="text-[12px] tabular-nums whitespace-nowrap">
          <span className="text-emerald-600 font-semibold">In {fmtMoney(inAmt)}</span>
          <span className="text-gray-300 mx-1.5">·</span>
          <span className="text-rose-600 font-semibold">Out {fmtMoney(outAmt)}</span>
          {balance !== undefined && (
            <>
              <span className="text-gray-300 mx-1.5">·</span>
              <span className="text-gray-600">Bal {fmtMoney(balance)}</span>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

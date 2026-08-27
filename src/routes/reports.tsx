import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  SalesRepo,
  PurchaseRepo,
  ExpenseRepo,
  PartyRepo,
  ItemRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  PaymentRepo,
  CompanyRepo,
} from "@/repositories";
import { fmtMoney, fmtDate, today, ymd } from "@/lib/format";
import { printOrEscapeStandalone } from "@/lib/print";
import { useAutoPrintFromUrl } from "@/hooks/useAutoPrintFromUrl";
import { useRepoData, useRepoMemo } from "@/hooks/useRepoData";
import type { Invoice } from "@/types";
import {
  computeCogs,
  buildPartyStatement,
  valueExTax,
  totalSettlementDiscount,
} from "@/lib/ledger";
import { downloadCsv } from "@/lib/csv";
import { downloadXlsx } from "@/lib/xlsx";
import { downloadElementAsPdf } from "@/lib/pdf";
import { useShareablePdf } from "@/hooks/useShareablePdf";
import { partyStatementSheet } from "@/lib/partySheet";
import { PartyStatementRowBlock, PartyStatementCardBlock } from "./parties_.$id";
import { fmtMode } from "@/lib/paymentMode";
import {
  TrialBalanceReport,
  ReconciliationReport,
  BalanceSheetReport,
  LedgerProfitLossReport,
} from "@/components/LedgerReports";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  FileText,
  BarChart3,
  Users,
  Package,
  Wallet,
  RefreshCcw,
  Printer,
  Download,
  FileDown,
  Share2,
  Search,
  Calendar,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Loader2,
  Scale,
  ShieldCheck,
  Landmark,
} from "lucide-react";

export const Route = createFileRoute("/reports")({
  component: ReportsPage,
  validateSearch: (search: Record<string, unknown>): { r?: string } => ({
    r: typeof search.r === "string" ? search.r : undefined,
  }),
});

const monthStart = () => ymd(new Date(new Date().getFullYear(), new Date().getMonth(), 1));

const r2 = (n: number) => Math.round(n * 100) / 100;

const REPORTS = [
  { key: "pl", label: "Profit & Loss", icon: BarChart3, desc: "Revenue, costs, net profit" },
  {
    key: "pl-ledger",
    label: "Profit & Loss (ledger)",
    icon: BarChart3,
    desc: "The same postings as the Balance Sheet — they cannot disagree",
  },
  {
    key: "balance-sheet",
    label: "Balance Sheet",
    icon: Landmark,
    desc: "What the shop owns, owes and is worth — and the year close",
  },
  {
    key: "trial-balance",
    label: "Trial Balance",
    icon: Scale,
    desc: "Every account, debit and credit — the accountant's first question",
  },
  {
    key: "reconcile",
    label: "Ledger Reconciliation",
    icon: ShieldCheck,
    desc: "Does the ledger agree with what the app prints?",
  },
  { key: "sales", label: "Sales Report", icon: FileText, desc: "Invoice-wise sales" },
  { key: "purchase", label: "Purchase Report", icon: FileText, desc: "Bill-wise purchases" },
  { key: "sale-return", label: "Sale Returns", icon: RefreshCcw, desc: "Credit notes issued" },
  {
    key: "purchase-return",
    label: "Purchase Returns",
    icon: RefreshCcw,
    desc: "Debit notes issued",
  },
  { key: "payments", label: "Payments Ledger", icon: Wallet, desc: "All payment in/out" },
  { key: "gst", label: "GST Summary", icon: BarChart3, desc: "Output vs input tax" },
  {
    key: "party-ledger",
    label: "Party Ledger",
    icon: Users,
    desc: "Full statement per party — sales, purchases, returns & payments",
  },
  { key: "stock", label: "Stock Report", icon: Package, desc: "Item-wise stock & value" },
  { key: "daily", label: "Today's Summary", icon: BarChart3, desc: "Today's activity" },
];

// Keeps the tab/range selected everywhere — across leaving to view a linked
// invoice/party, across leaving to a different page entirely and coming
// back, anything short of an actual page reload (which starts fresh again).
let activeReportCache: string | null = null;
let dateCache: { dateFrom: string; dateTo: string } | null = null;

function ReportsPage() {
  useRepoData();
  const { r } = Route.useSearch();
  const [active, setActive] = useState(() =>
    REPORTS.some((x) => x.key === r) ? (r as string) : (activeReportCache ?? "pl"),
  );
  const [dateFrom, setDateFrom] = useState(() => dateCache?.dateFrom ?? monthStart());
  const [dateTo, setDateTo] = useState(() => dateCache?.dateTo ?? today());
  const [pdfBusy, setPdfBusy] = useState<"download" | "share" | null>(null);
  // Mobile-only: the report list and the report content don't fit side by
  // side on a phone the way they do on desktop's two-pane layout, so mobile
  // shows one at a time — the list first (like picking from a menu), then
  // the chosen report full-width with a way back. Arriving via a direct
  // link (?r=sales) skips straight to that report instead of the menu.
  const [mobileShowReport, setMobileShowReport] = useState(() => REPORTS.some((x) => x.key === r));
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    activeReportCache = active;
  }, [active]);
  useEffect(() => {
    dateCache = { dateFrom, dateTo };
  }, [dateFrom, dateTo]);

  const current = REPORTS.find((r) => r.key === active);
  const reportFilename = () =>
    `${(current?.label ?? "Report").replace(/\s+/g, "-")}-${dateFrom}-to-${dateTo}`;

  // Re-entry point for printOrEscapeStandalone's standalone-app escape (see
  // lib/print.ts) — the ?r= param already in this URL restores the same
  // report on reopen, so this just needs to fire once it has.
  useAutoPrintFromUrl(current ? reportFilename() : null, !!current);

  const { shareReady, share, resetShare } = useShareablePdf("Report");

  const handleDownloadPdf = async () => {
    if (!printRef.current || pdfBusy) return;
    resetShare();
    setPdfBusy("download");
    try {
      await downloadElementAsPdf(printRef.current, reportFilename(), "landscape");
      toast.success("Report downloaded as PDF");
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
      await share(printRef.current, reportFilename(), "landscape");
    } catch {
      toast.error("Could not share report — try Download PDF instead");
    } finally {
      setPdfBusy(null);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#f7f7f9]">
      <div className="bg-white border-b px-5 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 no-print">
        <div className="flex items-center justify-between sm:justify-start gap-2.5">
          <div className="flex items-center gap-2.5">
            <BarChart3 className="h-5 w-5 text-primary shrink-0" />
            <div>
              <h1 className="text-[17px] font-bold text-gray-800 leading-tight">Reports</h1>
              <p className="text-[12px] text-gray-400 leading-tight">{current?.desc}</p>
            </div>
          </div>
          {/* Date Range moves into the Filters sheet on mobile — its own
              inline row next to Download/Share/Print doesn't fit a phone. */}
          <button
            onClick={() => setMobileFiltersOpen(true)}
            className="sm:hidden relative h-9 w-9 shrink-0 flex items-center justify-center rounded-lg border border-gray-200 bg-gray-50/60 text-gray-600"
            title="Filters"
          >
            <SlidersHorizontal className="h-4 w-4" />
            {(dateFrom !== monthStart() || dateTo !== today()) && (
              <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-primary" />
            )}
          </button>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="hidden sm:flex items-center gap-1.5 h-9 pl-3 pr-2.5 rounded-lg border border-gray-200 bg-gray-50/60">
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
          </div>
          <button
            onClick={handleDownloadPdf}
            disabled={pdfBusy !== null}
            className="h-9 w-9 shrink-0 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 hover:shadow-sm text-gray-600 flex items-center justify-center transition disabled:opacity-50"
            title="Download report as PDF"
          >
            <FileDown className="h-4 w-4" />
          </button>
          <button
            onClick={handleShare}
            disabled={pdfBusy !== null}
            className={`h-9 w-9 shrink-0 rounded-lg border bg-white hover:bg-gray-50 hover:shadow-sm text-gray-600 flex items-center justify-center transition disabled:opacity-50 ${shareReady ? "border-primary ring-2 ring-primary animate-pulse" : "border-gray-200"}`}
            title={shareReady ? "PDF ready — tap again to share" : "Share report PDF"}
          >
            <Share2 className="h-4 w-4" />
          </button>
          <button
            onClick={() =>
              printOrEscapeStandalone(reportFilename(), { r: active }, handleDownloadPdf)
            }
            disabled={!!pdfBusy}
            className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 h-9 px-3.5 bg-white border border-gray-200 rounded-lg text-xs font-semibold text-gray-600 hover:bg-gray-50 hover:shadow-sm transition disabled:opacity-60 disabled:cursor-not-allowed"
            title="Print"
          >
            {pdfBusy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Preparing…
              </>
            ) : (
              <>
                <Printer className="h-3.5 w-3.5" /> Print
              </>
            )}
          </button>
        </div>
      </div>

      {/* Mobile filter sheet — Date Range doesn't fit inline next to
          Download/Share/Print on a phone, so it lives here behind the
          header's Filters button instead, same state as the desktop
          inline control. */}
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
              {dateFrom !== monthStart() || dateTo !== today() ? (
                <button
                  onClick={() => {
                    setDateFrom(monthStart());
                    setDateTo(today());
                  }}
                  className="text-xs text-gray-400 hover:text-gray-600 transition flex items-center gap-1"
                >
                  Reset to this month
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

      <div className="flex-1 flex min-h-0">
        {/* Sidebar — full-width report menu on mobile until one is picked;
            a fixed 224px rail sitting alongside the content on desktop. */}
        <aside
          className={`${mobileShowReport ? "hidden" : "flex"} md:flex flex-col w-full md:w-56 border-r bg-white overflow-y-auto shrink-0 no-print p-2`}
        >
          {REPORTS.map((r) => {
            const Icon = r.icon;
            const isActive = active === r.key;
            return (
              <button
                key={r.key}
                onClick={() => {
                  setActive(r.key);
                  setMobileShowReport(true);
                }}
                className={`w-full text-left mb-1 px-2.5 py-2 rounded-xl flex items-center gap-3 transition ${isActive ? "bg-primary-soft" : "hover:bg-gray-50"}`}
              >
                <div
                  className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${isActive ? "bg-primary text-white" : "bg-gray-100 text-gray-500"}`}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p
                    className={`text-[13px] truncate ${isActive ? "font-semibold text-primary" : "font-medium text-gray-700"}`}
                  >
                    {r.label}
                  </p>
                  {/* Description only on the mobile full-width list — the
                      desktop rail (w-56) is too narrow for it. */}
                  <p className="md:hidden text-[11px] text-gray-400 truncate mt-0.5">{r.desc}</p>
                </div>
                <ChevronRight className="md:hidden h-4 w-4 text-gray-300 shrink-0" />
              </button>
            );
          })}
        </aside>

        {/* Report content (print-area so Print/PDF/Share all capture exactly
            this) — hidden on mobile until a report is picked from the menu. */}
        <div
          ref={printRef}
          className={`${mobileShowReport ? "flex" : "hidden"} md:flex flex-1 flex-col overflow-auto p-6 print-visible print:p-6`}
        >
          <button
            onClick={() => setMobileShowReport(false)}
            className="md:hidden no-print flex items-center gap-1 text-sm font-medium text-gray-500 hover:text-gray-700 mb-3 -mt-1"
          >
            <ChevronLeft className="h-4 w-4" /> All Reports
          </button>
          <ReportView which={active} dateFrom={dateFrom} dateTo={dateTo} />
        </div>
      </div>
    </div>
  );
}

function inRange(date: string, from: string, to: string) {
  return (!from || date >= from) && (!to || date <= to);
}

function ReportView({
  which,
  dateFrom,
  dateTo,
}: {
  which: string;
  dateFrom: string;
  dateTo: string;
}) {
  const label = REPORTS.find((r) => r.key === which)?.label ?? which;
  const navigate = useNavigate();
  useRepoData();

  const sales = useRepoMemo(
    () => SalesRepo.all().filter((s) => inRange(s.date, dateFrom, dateTo)),
    [dateFrom, dateTo],
  );
  const purchases = useRepoMemo(
    () => PurchaseRepo.all().filter((s) => inRange(s.date, dateFrom, dateTo)),
    [dateFrom, dateTo],
  );
  const expenses = useRepoMemo(
    () => ExpenseRepo.all().filter((s) => inRange(s.date, dateFrom, dateTo)),
    [dateFrom, dateTo],
  );
  const saleReturns = useRepoMemo(
    () => SaleReturnRepo.all().filter((s) => inRange(s.date, dateFrom, dateTo)),
    [dateFrom, dateTo],
  );
  const purchaseReturns = useRepoMemo(
    () => PurchaseReturnRepo.all().filter((s) => inRange(s.date, dateFrom, dateTo)),
    [dateFrom, dateTo],
  );
  const payments = useRepoMemo(
    () => PaymentRepo.all().filter((s) => inRange(s.date, dateFrom, dateTo)),
    [dateFrom, dateTo],
  );
  const parties = useRepoMemo(() => PartyRepo.all());
  const items = useRepoMemo(() => ItemRepo.all());
  const [partySearch, setPartySearch] = useState("");

  // Every party's full statement, built ONCE per (report, date-range) — not on
  // every keystroke of the party search below. Building it is O(parties × all
  // documents), so rebuilding it per keystroke froze the search box at scale.
  // Only built when the Party Ledger report is actually open. `partySearch`
  // is deliberately NOT a dependency — it only filters the memoized result.
  const partyLedgerAll = useRepoMemo(() => {
    if (which !== "party-ledger") return [];
    const data = {
      sales: SalesRepo.all(),
      purchases: PurchaseRepo.all(),
      saleReturns: SaleReturnRepo.all(),
      purchaseReturns: PurchaseReturnRepo.all(),
      payments: PaymentRepo.all(),
    };
    return parties
      .map((p) => ({ party: p, ledger: buildPartyStatement(p, data, dateFrom, dateTo) }))
      .filter(({ ledger }) => ledger.rows.length > 0)
      .sort((a, b) => a.party.name.localeCompare(b.party.name));
  }, [which, dateFrom, dateTo, parties]);

  if (which === "pl-ledger") return <LedgerProfitLossReport from={dateFrom} to={dateTo} />;
  if (which === "balance-sheet") return <BalanceSheetReport asAt={dateTo || today()} />;
  if (which === "trial-balance") return <TrialBalanceReport asAt={dateTo || today()} />;
  if (which === "reconcile") return <ReconciliationReport />;

  if (which === "pl") {
    // Excluding GST — the tax collected on a sale is a liability owed to the
    // government, not revenue, and COGS below is already tax-exclusive.
    const revenue = valueExTax(sales);
    const saleReturnTotal = valueExTax(saleReturns);
    const netRevenue = r2(revenue - saleReturnTotal);
    // Stock-based COGS: cost of items actually sold (net of returned goods),
    // not total purchases — unsold stock does not reduce profit.
    const cogs = computeCogs(sales, saleReturns, items);
    const netPurchases = r2(valueExTax(purchases) - valueExTax(purchaseReturns));
    const grossProfit = r2(netRevenue - cogs);
    const exp = expenses.reduce((a, s) => a + s.amount, 0);
    // Amounts waived when settling a bill are a real cost — the sale was
    // booked at full value, so without this the waived part would quietly
    // inflate profit. A discount a SUPPLIER gave us works the other way.
    const discountAllowed = totalSettlementDiscount(payments.filter((p) => p.type === "in"));
    const discountReceived = totalSettlementDiscount(payments.filter((p) => p.type === "out"));
    const netProfit = r2(grossProfit - exp - discountAllowed + discountReceived);

    return (
      <div className="max-w-2xl">
        <h2 className="text-lg font-bold text-gray-800 mb-4">{label}</h2>
        <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
          <div className="px-5 py-3 bg-gray-50 border-b">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Revenue</p>
          </div>
          <PLRow label="Sales Revenue (excl. GST)" value={revenue} />
          <PLRow label="Sale Returns (−)" value={-saleReturnTotal} indent />
          <PLRow label="Net Revenue" value={netRevenue} bold />
          <div className="px-5 py-3 bg-gray-50 border-b border-t">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Cost of Goods Sold
            </p>
          </div>
          <PLRow label="Cost of Goods Sold (item cost of sold qty)" value={-cogs} bold />
          <div className="px-5 py-2 flex justify-between items-center border-b border-gray-100 text-[11px] text-gray-400">
            <span className="pl-4">
              Purchases during period, excl. GST (net of returns) — for reference, not in profit
            </span>
            <span className="tabular-nums">{fmtMoney(netPurchases)}</span>
          </div>
          <div className="px-5 py-3 bg-gray-50 border-b border-t">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Gross Profit
            </p>
          </div>
          <PLRow
            label="Gross Profit"
            value={grossProfit}
            bold
            large
            className={grossProfit >= 0 ? "text-emerald-600" : "text-rose-600"}
          />
          <div className="px-5 py-3 bg-gray-50 border-b border-t">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Expenses</p>
          </div>
          <PLRow label="Operating Expenses" value={-exp} />
          {discountAllowed > 0 && (
            <PLRow label="Discount Allowed (settlements)" value={-discountAllowed} />
          )}
          {discountReceived > 0 && (
            <PLRow label="Discount Received (settlements)" value={discountReceived} />
          )}
          <div className="px-5 py-4 bg-primary/5 border-t-2 border-primary flex justify-between items-center">
            <span className="text-base font-bold text-gray-800">Net Profit</span>
            <span
              className={`text-[20px] font-extrabold tabular-nums ${netProfit >= 0 ? "text-emerald-600" : "text-rose-600"}`}
            >
              {fmtMoney(netProfit)}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (which === "sales") {
    const total = sales.reduce((a, s) => a + s.total, 0);
    const paid = sales.reduce((a, s) => a + s.paid, 0);
    return (
      <TableReport
        label={label}
        totalRows={[
          ["Total", fmtMoney(total)],
          ["Collected", fmtMoney(paid)],
          ["Outstanding", fmtMoney(total - paid)],
        ]}
        cols={["Invoice #", "Date", "Customer", "Mode", "Total", "Paid", "Balance", "Status"]}
        rows={sales
          .sort((a, b) => b.date.localeCompare(a.date))
          .map((s) => {
            const bal = Math.max(0, s.total - s.paid);
            const status = bal <= 0 ? "Paid" : s.paid > 0 ? "Partial" : "Unpaid";
            return [
              s.number,
              fmtDate(s.date),
              s.partyName,
              fmtMode(s.paymentMode),
              fmtMoney(s.total),
              fmtMoney(s.paid),
              fmtMoney(bal),
              status,
            ];
          })}
      />
    );
  }

  if (which === "purchase") {
    const total = purchases.reduce((a, s) => a + s.total, 0);
    const paid = purchases.reduce((a, s) => a + s.paid, 0);
    return (
      <TableReport
        label={label}
        totalRows={[
          ["Total", fmtMoney(total)],
          ["Paid", fmtMoney(paid)],
          ["Payable", fmtMoney(total - paid)],
        ]}
        cols={["Bill #", "Date", "Supplier", "Mode", "Total", "Paid", "Balance", "Status"]}
        rows={purchases
          .sort((a, b) => b.date.localeCompare(a.date))
          .map((s) => {
            const bal = Math.max(0, s.total - s.paid);
            const status = bal <= 0 ? "Paid" : s.paid > 0 ? "Partial" : "Unpaid";
            return [
              s.number,
              fmtDate(s.date),
              s.partyName,
              fmtMode(s.paymentMode),
              fmtMoney(s.total),
              fmtMoney(s.paid),
              fmtMoney(bal),
              status,
            ];
          })}
      />
    );
  }

  if (which === "sale-return") {
    const total = saleReturns.reduce((a, r) => a + r.total, 0);
    return (
      <TableReport
        label={label}
        totalRows={[["Total Credit", fmtMoney(total)]]}
        cols={["Credit Note #", "Date", "Original Ref", "Customer", "Items", "Total"]}
        rows={saleReturns
          .sort((a, b) => b.date.localeCompare(a.date))
          .map((r) => [
            r.number,
            fmtDate(r.date),
            r.originalRef || "—",
            r.partyName,
            String(r.lineItems.length),
            fmtMoney(r.total),
          ])}
      />
    );
  }

  if (which === "purchase-return") {
    const total = purchaseReturns.reduce((a, r) => a + r.total, 0);
    return (
      <TableReport
        label={label}
        totalRows={[["Total Debit", fmtMoney(total)]]}
        cols={["Debit Note #", "Date", "Original Ref", "Supplier", "Items", "Total"]}
        rows={purchaseReturns
          .sort((a, b) => b.date.localeCompare(a.date))
          .map((r) => [
            r.number,
            fmtDate(r.date),
            r.originalRef || "—",
            r.partyName,
            String(r.lineItems.length),
            fmtMoney(r.total),
          ])}
      />
    );
  }

  if (which === "payments") {
    const totalIn = payments.filter((p) => p.type === "in").reduce((a, p) => a + p.amount, 0);
    const totalOut = payments.filter((p) => p.type === "out").reduce((a, p) => a + p.amount, 0);
    return (
      <TableReport
        label={label}
        totalRows={[
          ["Received (In)", fmtMoney(totalIn)],
          ["Paid (Out)", fmtMoney(totalOut)],
          ["Net", fmtMoney(totalIn - totalOut)],
        ]}
        cols={["Date", "Type", "Party", "Mode", "Reference", "Amount"]}
        rows={payments
          .sort((a, b) => b.date.localeCompare(a.date))
          .map((p) => [
            fmtDate(p.date),
            p.type === "in" ? "In" : "Out",
            p.partyName,
            fmtMode(p.mode),
            p.ref || "—",
            `${p.type === "in" ? "+" : "−"}${fmtMoney(p.amount)}`,
          ])}
      />
    );
  }

  if (which === "gst") {
    const agg = (all: Invoice[]) => {
      // Only GST bills belong in GST returns
      const invoices = all.filter((inv) => inv.gstEnabled !== false);
      const map = new Map<number, { taxable: number; cgst: number; sgst: number }>();
      invoices.forEach((inv) =>
        inv.lineItems.forEach((l) => {
          // Guard against legacy/imported line items missing a numeric field —
          // one bad record must not turn the whole GST summary into NaN.
          const qty = l.qty ?? 0;
          const price = l.price ?? 0;
          const discountPct = l.discountPct ?? 0;
          const gstRate = l.gstRate ?? 0;
          const taxable = qty * price * (1 - discountPct / 100);
          const tax = taxable * (gstRate / 100);
          const cur = map.get(gstRate) ?? { taxable: 0, cgst: 0, sgst: 0 };
          map.set(gstRate, {
            taxable: cur.taxable + taxable,
            cgst: cur.cgst + tax / 2,
            sgst: cur.sgst + tax / 2,
          });
        }),
      );
      return Array.from(map, ([rate, v]) => ({ rate, ...v })).sort((a, b) => a.rate - b.rate);
    };
    const outRows = agg(sales);
    const inRows = agg(purchases);
    const outTax = outRows.reduce((a, r) => a + r.cgst + r.sgst, 0);
    const inTax = inRows.reduce((a, r) => a + r.cgst + r.sgst, 0);

    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 max-w-4xl">
        <div>
          <h2 className="text-base font-bold text-gray-800 mb-3">GSTR-1 — Output Tax (Sales)</h2>
          <TableReport
            label=""
            totalRows={[["Total Output Tax", fmtMoney(outTax)]]}
            cols={["GST Rate", "Taxable Value", "CGST", "SGST", "Total Tax"]}
            rows={outRows.map((r) => [
              `${r.rate}%`,
              fmtMoney(r.taxable),
              fmtMoney(r.cgst),
              fmtMoney(r.sgst),
              fmtMoney(r.cgst + r.sgst),
            ])}
          />
        </div>
        <div>
          <h2 className="text-base font-bold text-gray-800 mb-3">GSTR-2 — Input Tax (Purchase)</h2>
          <TableReport
            label=""
            totalRows={[
              ["Total Input Tax", fmtMoney(inTax)],
              ["Net GST Payable", fmtMoney(outTax - inTax)],
            ]}
            cols={["GST Rate", "Taxable Value", "CGST", "SGST", "Total Tax"]}
            rows={inRows.map((r) => [
              `${r.rate}%`,
              fmtMoney(r.taxable),
              fmtMoney(r.cgst),
              fmtMoney(r.sgst),
              fmtMoney(r.cgst + r.sgst),
            ])}
          />
        </div>
      </div>
    );
  }

  if (which === "party-ledger") {
    // Every party is both customer & supplier now — one combined statement
    // (sales, purchases, returns, payments, running balance, and each
    // transaction's own item breakdown) per party, instead of splitting by a
    // customer/supplier field that no longer means anything. Always built
    // from FULL history — dateFrom/dateTo only control the visible window
    // inside buildPartyStatement (via a proper "Balance b/f" line), same as
    // the per-party Statement page.
    const perPartyAll = partyLedgerAll;
    const q = partySearch.trim().toLowerCase();
    const perParty = q
      ? perPartyAll.filter(({ party: p }) => p.name.toLowerCase().includes(q))
      : perPartyAll;

    const closingOf = (rows: { balance: number }[]) =>
      rows.length ? rows[rows.length - 1].balance : 0;
    const totalReceivable = perParty.reduce(
      (s, { ledger }) => s + Math.max(0, closingOf(ledger.rows)),
      0,
    );
    const totalPayable = perParty.reduce(
      (s, { ledger }) => s + Math.max(0, -closingOf(ledger.rows)),
      0,
    );
    const fmtBal = (n: number) => `${fmtMoney(Math.abs(n))}${n > 0 ? " Dr" : n < 0 ? " Cr" : ""}`;

    if (perPartyAll.length === 0) {
      return (
        <div>
          <h2 className="text-base font-bold text-gray-800 mb-3">{label}</h2>
          <div className="bg-white border rounded-lg p-8 text-center text-gray-400">
            <FileText className="h-8 w-8 mx-auto mb-2 text-gray-200" />
            <p>No party activity for selected date range</p>
          </div>
        </div>
      );
    }

    const company = CompanyRepo.get();
    const periodLabel = `${dateFrom ? fmtDate(dateFrom) : "Beginning"} to ${dateTo ? fmtDate(dateTo) : "Today"}`;
    const sheets = perParty.map(({ party: p, ledger }) =>
      partyStatementSheet(p, ledger.rows, company, periodLabel),
    );

    const openRow = (r: { docId?: string; docKind?: string }) => {
      if (!r.docId || !r.docKind) return;
      if (r.docKind === "sale") navigate({ to: "/sales/$id", params: { id: r.docId } });
      else if (r.docKind === "purchase") navigate({ to: "/purchase/$id", params: { id: r.docId } });
      else if (r.docKind === "sale-return")
        navigate({ to: "/sale-return/$id", params: { id: r.docId } });
      else navigate({ to: "/purchase-return/$id", params: { id: r.docId } });
    };

    return (
      <div>
        {/* Each party's table is 9 columns wide plus a nested item
            breakdown — too wide for portrait A4, so it gets cut off at the
            right edge when printed. Landscape gives it room to fit. */}
        <style>{`@media print { @page { size: A4 landscape; margin: 12mm; } }`}</style>
        <div className="flex items-center justify-between gap-2 mb-3">
          <h2 className="text-base font-bold text-gray-800 truncate">{label}</h2>
          <button
            onClick={() => downloadXlsx("Party Ledger", sheets)}
            title="Export Excel (one sheet per party)"
            className="no-print shrink-0 inline-flex items-center gap-1.5 h-8 px-3 bg-white border border-gray-200 rounded-md text-xs font-semibold text-gray-600 hover:bg-gray-50 transition"
          >
            <Download className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Export Excel (one sheet per party)</span>
            <span className="sm:hidden">Export Excel</span>
          </button>
        </div>
        <div className="mb-4 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-white border rounded-lg px-4 py-3">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">
                Total Receivable
              </p>
              <p className="text-base font-bold text-rose-600 tabular-nums">
                {fmtMoney(totalReceivable)}
              </p>
            </div>
            <div className="bg-white border rounded-lg px-4 py-3">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">
                Total Payable
              </p>
              <p className="text-base font-bold text-amber-600 tabular-nums">
                {fmtMoney(totalPayable)}
              </p>
            </div>
          </div>
          <div className="no-print flex items-center gap-1.5 border border-gray-200 rounded-lg px-3 py-2 bg-white">
            <Search className="h-3.5 w-3.5 text-gray-400 shrink-0" />
            <input
              value={partySearch}
              onChange={(e) => setPartySearch(e.target.value)}
              placeholder="Search party…"
              className="text-xs flex-1 outline-none placeholder-gray-400 bg-transparent"
            />
          </div>
        </div>
        {perParty.length === 0 && (
          <div className="bg-white border rounded-lg p-8 text-center text-gray-400 mb-4">
            <Search className="h-8 w-8 mx-auto mb-2 text-gray-200" />
            <p>No party matches "{partySearch}"</p>
          </div>
        )}
        <div className="space-y-4">
          {perParty.map(({ party: p, ledger }) => {
            const closing = closingOf(ledger.rows);
            return (
              <div
                key={p.id}
                className="bg-white border rounded-lg shadow-sm overflow-hidden"
                style={{ breakInside: "avoid" }}
              >
                <div className="px-4 py-2.5 bg-gray-50 border-b flex items-center justify-between gap-3">
                  <button
                    onClick={() => navigate({ to: "/parties/$id", params: { id: p.id } })}
                    className="no-print font-bold text-sm text-gray-800 hover:text-primary hover:underline text-left"
                    title="Open full party statement"
                  >
                    {p.name}
                  </button>
                  <span className="hidden print:inline font-bold text-sm text-gray-800">
                    {p.name}
                  </span>
                  <span
                    className={`text-xs font-bold tabular-nums ${closing > 0 ? "text-rose-600" : closing < 0 ? "text-amber-600" : "text-gray-500"}`}
                  >
                    Closing: {fmtBal(closing)}
                  </span>
                </div>
                {/* The mobile/desktop split below is screen-only — print
                    must always show the real table regardless of the
                    device it's triggered from (a phone's own Print button
                    included), so this overrides both sides of the split
                    back for @media print rather than trusting how a given
                    browser resolves `md:` during an actual print render. */}
                <style>{`@media print {
                  .party-ledger-mobile-cards { display: none !important; }
                  .party-ledger-table { display: table !important; }
                }`}</style>
                <div className="md:hidden party-ledger-mobile-cards divide-y divide-gray-100">
                  {ledger.rows.map((r, i) => (
                    <PartyStatementCardBlock key={i} row={r} onOpen={() => openRow(r)} />
                  ))}
                  <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-t text-[10px] font-bold uppercase text-gray-500">
                    <span>Closing Balance</span>
                    <span
                      className={
                        closing > 0
                          ? "text-rose-600"
                          : closing < 0
                            ? "text-amber-600"
                            : "text-gray-500"
                      }
                    >
                      {closing > 0
                        ? `${fmtMoney(closing)} Dr`
                        : closing < 0
                          ? `${fmtMoney(-closing)} Cr`
                          : "Settled"}
                    </span>
                  </div>
                </div>
                <table className="hidden md:table party-ledger-table w-full text-[12px] border-collapse">
                  <thead>
                    <tr className="bg-gray-50/60">
                      {[
                        "Date",
                        "Txn Type",
                        "Ref No.",
                        "Payment Status",
                        "Total",
                        "Received/Paid",
                        "Txn Balance",
                        "Receivable Balance",
                        "Payable Balance",
                      ].map((h, i) => (
                        <th
                          key={h}
                          className={`px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 border-b border-gray-100 whitespace-nowrap ${i >= 4 ? "text-right" : "text-left"}`}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.rows.map((r, i) => (
                      <PartyStatementRowBlock key={i} row={r} onOpen={() => openRow(r)} />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-gray-50 border-t-2 border-gray-200 font-bold">
                      <td colSpan={7} className="px-3 py-2.5 text-[10px] uppercase text-gray-500">
                        Closing Balance
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-rose-600">
                        {closing > 0 ? fmtMoney(closing) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-amber-600">
                        {closing < 0 ? fmtMoney(-closing) : "—"}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (which === "stock") {
    const totalValue = items.reduce((a, i) => a + i.stock * i.purchasePrice, 0);
    const lowStock = items.filter(
      (i) => (i.minStock != null && i.stock <= i.minStock) || i.stock < 0,
    ).length;
    return (
      <TableReport
        label={label}
        totalRows={[
          ["Total Stock Value", fmtMoney(totalValue)],
          ["Low Stock Items", String(lowStock)],
        ]}
        cols={[
          "Item",
          "SKU",
          "Category",
          "Stock",
          "Unit",
          "Min Stock",
          "Purchase Price",
          "Sale Price",
          "Stock Value",
        ]}
        rows={items
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((i) => [
            i.name,
            i.sku || "—",
            i.category || "—",
            String(i.stock),
            i.unit,
            i.minStock ? String(i.minStock) : "—",
            fmtMoney(i.purchasePrice),
            fmtMoney(i.salePrice),
            fmtMoney(i.stock * i.purchasePrice),
          ])}
      />
    );
  }

  if (which === "daily") {
    const t = today();
    const todaySales = SalesRepo.all().filter((x) => x.date === t);
    const todayPurchases = PurchaseRepo.all().filter((x) => x.date === t);
    const todayExpenses = ExpenseRepo.all().filter((x) => x.date === t);
    const todayPayIn = PaymentRepo.all().filter((x) => x.date === t && x.type === "in");
    const todayPayOut = PaymentRepo.all().filter((x) => x.date === t && x.type === "out");
    const s = todaySales.reduce((a, b) => a + b.total, 0);
    const p = todayPurchases.reduce((a, b) => a + b.total, 0);
    const e = todayExpenses.reduce((a, b) => a + b.amount, 0);
    const pi = todayPayIn.reduce((a, b) => a + b.amount, 0);
    const po = todayPayOut.reduce((a, b) => a + b.amount, 0);

    return (
      <div className="max-w-lg">
        <h2 className="text-lg font-bold text-gray-800 mb-4">Today's Summary — {fmtDate(t)}</h2>
        <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
          <PLRow label="Sales" value={s} positive />
          <PLRow label="Payment In" value={pi} positive />
          <PLRow label="Purchase" value={-p} />
          <PLRow label="Expenses" value={-e} />
          <PLRow label="Payment Out" value={-po} />
          <div className="px-5 py-4 bg-primary/5 border-t-2 border-primary flex justify-between items-center">
            <span className="text-base font-bold">Net Cash Flow</span>
            <span
              className={`text-[20px] font-extrabold tabular-nums ${s + pi - p - e - po >= 0 ? "text-emerald-600" : "text-rose-600"}`}
            >
              {fmtMoney(s + pi - p - e - po)}
            </span>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatCard
            label="Invoices"
            value={todaySales.length}
            sub="created"
            color="text-blue-600"
          />
          <StatCard
            label="Bills"
            value={todayPurchases.length}
            sub="created"
            color="text-gray-600"
          />
          <StatCard
            label="Expenses"
            value={todayExpenses.length}
            sub="recorded"
            color="text-rose-600"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="text-muted-foreground text-sm p-4">Select a report from the left panel.</div>
  );
}

function PLRow({
  label,
  value,
  bold,
  large,
  indent,
  positive,
  className = "",
}: {
  label: string;
  value: number;
  bold?: boolean;
  large?: boolean;
  indent?: boolean;
  positive?: boolean;
  className?: string;
}) {
  const isPos = positive ? value >= 0 : value >= 0;
  const display = fmtMoney(Math.abs(value));
  const prefix = value < 0 ? "−" : "";
  return (
    <div
      className={`px-5 py-3 flex justify-between items-center border-b border-gray-100 ${bold ? "bg-gray-50" : ""}`}
    >
      <span
        className={`text-sm ${indent ? "pl-4 text-gray-500" : "text-gray-700"} ${bold ? "font-bold" : ""} ${large ? "text-base" : ""}`}
      >
        {label}
      </span>
      <span
        className={`tabular-nums text-sm ${bold ? "font-bold" : "font-medium"} ${large ? "text-base" : ""} ${className || (isPos && !positive && value === 0 ? "text-gray-400" : value < 0 ? "text-rose-600" : value > 0 && positive ? "text-emerald-600" : "text-gray-800")}`}
      >
        {prefix}
        {display}
      </span>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: number;
  sub: string;
  color: string;
}) {
  return (
    <div className="bg-white border rounded-lg p-3 text-center">
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-xs text-gray-500 mt-0.5">
        {label} {sub}
      </p>
    </div>
  );
}

// Cells here are already display-formatted strings (₹1,200.00, dates, plain
// numbers, dashes for empty) shared across every report table — this strips
// currency/comma formatting to compare numerically when it can, and falls
// back to plain string comparison for text columns and "—" placeholders.
function smartCompare(a: string, b: string): number {
  const na = parseFloat(a.replace(/[₹,]/g, ""));
  const nb = parseFloat(b.replace(/[₹,]/g, ""));
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return a.localeCompare(b);
}

// Colour cues shared by the report cards — the status column becomes a pill
// and the summary totals get tinted by what they mean, detected from the text
// so this stays generic across every differently-shaped report.
const STATUS_PILL: Record<string, string> = {
  paid: "bg-emerald-50 text-emerald-700 border-emerald-200",
  partial: "bg-amber-50 text-amber-700 border-amber-200",
  unpaid: "bg-rose-50 text-rose-700 border-rose-200",
  overdue: "bg-rose-50 text-rose-700 border-rose-200",
};
const isStatusValue = (v: string) => v.trim().toLowerCase() in STATUS_PILL;
const totalTone = (k: string) => {
  const s = k.toLowerCase();
  if (/outstand|payable|\bdue\b|debit|payable/.test(s)) return "text-rose-600";
  if (/collect|received/.test(s)) return "text-emerald-600";
  return "text-gray-800";
};

function TableReport({
  label,
  cols,
  rows,
  totalRows,
}: {
  label: string;
  cols: string[];
  rows: string[][];
  totalRows: [string, string][];
}) {
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const toggleSort = (i: number) => {
    if (sortCol === i) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortCol(i);
      setSortDir("asc");
    }
  };

  const sortedRows =
    sortCol == null
      ? rows
      : [...rows].sort((a, b) => {
          const cmp = smartCompare(a[sortCol] ?? "", b[sortCol] ?? "");
          return sortDir === "asc" ? cmp : -cmp;
        });

  if (rows.length === 0) {
    return (
      <div>
        {label && <h2 className="text-base font-bold text-gray-800 mb-3">{label}</h2>}
        <div className="bg-white border border-gray-200/80 rounded-xl shadow-card p-10 text-center text-gray-400">
          <FileText className="h-8 w-8 mx-auto mb-2 text-gray-200" />
          <p>No data for selected date range</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {label && (
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold text-gray-800">{label}</h2>
          <button
            onClick={() => downloadCsv(label, cols, sortedRows)}
            className="no-print inline-flex items-center gap-1.5 h-8 px-3 bg-white border border-gray-200 rounded-lg text-xs font-semibold text-gray-600 hover:bg-gray-50 hover:shadow-sm transition"
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </button>
        </div>
      )}
      <div className="bg-white border border-gray-200/80 rounded-xl shadow-card overflow-hidden">
        {/* The mobile/desktop split below is screen-only — print must
            always show the real table regardless of the device it's
            triggered from (a phone's own Print button included), so this
            overrides both sides of the split back for @media print rather
            than trusting how a given browser resolves `md:` during an
            actual print render. */}
        <style>{`@media print {
          .table-report-mobile-cards { display: none !important; }
          .table-report-table { display: table !important; }
        }`}</style>
        {/* Mobile card list — this report's column count varies (up to 8+
            for some reports) and never fits a phone; this shows every
            column as a label:value pair per row instead, generically,
            since this one component renders many differently-shaped
            reports. */}
        <div className="md:hidden table-report-mobile-cards">
          <div className="divide-y divide-gray-100">
            {sortedRows.map((row, ri) => (
              <div key={ri} className="px-4 py-3">
                {/* Identifier on the left, the report's last column (status /
                    headline total, depending on the report) emphasised right */}
                <div className="flex items-center justify-between gap-2 mb-2.5">
                  <p className="font-bold text-[14px] text-gray-800 truncate leading-tight">
                    {row[0]}
                  </p>
                  {cols.length > 1 &&
                    (isStatusValue(row[row.length - 1]) ? (
                      <span
                        className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_PILL[row[row.length - 1].trim().toLowerCase()]}`}
                      >
                        {row[row.length - 1]}
                      </span>
                    ) : (
                      <p className="font-bold text-[13px] text-gray-800 tabular-nums shrink-0 leading-tight">
                        {row[row.length - 1]}
                      </p>
                    ))}
                </div>
                {/* Middle columns as a tidy label/value grid instead of a
                    wrapped run-on line */}
                {cols.length > 2 && (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                    {cols.slice(1, -1).map((c, i) => (
                      <div key={c} className="min-w-0">
                        <p className="text-[9.5px] uppercase tracking-wide text-gray-400 leading-none">
                          {c}
                        </p>
                        <p className="text-[12px] text-gray-700 truncate mt-1 tabular-nums">
                          {row[i + 1]}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="hidden md:block data-table table-report-table overflow-auto max-h-[calc(100vh-300px)]">
          <table className="w-full text-[12.5px] min-w-max">
            <thead>
              <tr>
                {cols.map((c, i) => (
                  <th
                    key={c}
                    onClick={() => toggleSort(i)}
                    style={{ textAlign: i > 0 ? "right" : "left" }}
                    className="cursor-pointer select-none"
                  >
                    {c}
                    {sortCol === i && <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      style={{ textAlign: ci === 0 ? "left" : "right" }}
                      className={
                        ci === 0 ? "font-medium text-gray-800" : "text-gray-700 tabular-nums"
                      }
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalRows.length > 0 && (
          <div className="border-t border-gray-200/80 bg-gray-50/60 px-4 sm:px-5 py-1">
            {totalRows.map(([k, v], i) => (
              <div
                key={i}
                className={`flex items-center justify-between gap-4 py-2.5 ${i > 0 ? "border-t border-gray-100" : ""}`}
              >
                <span className="text-[12px] font-medium text-gray-500">{k}</span>
                <span className={`text-[14px] font-bold tabular-nums ${totalTone(k)}`}>{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

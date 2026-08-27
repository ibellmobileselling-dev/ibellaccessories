import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useGoBack } from "@/hooks/useGoBack";
import { useEffect, useMemo, useRef, useState } from "react";
import { PayeeRepo, ExpenseRepo, BankRepo, CompanyRepo } from "@/repositories";
import { fmtDate, fmtDateShort, fmtMoney } from "@/lib/format";
import { printOrEscapeStandalone } from "@/lib/print";
import { useAutoPrintFromUrl } from "@/hooks/useAutoPrintFromUrl";
import { useRepoData, useRepoMemo } from "@/hooks/useRepoData";
import { downloadElementAsPdf } from "@/lib/pdf";
import { useShareablePdf } from "@/hooks/useShareablePdf";
import { downloadXlsx } from "@/lib/xlsx";
import { fmtMode } from "@/lib/paymentMode";
import type { Payee } from "@/types";
import { ArrowLeft, Printer, FileDown, Share2, Download, AlertCircle } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/payees_/$id")({ component: PayeeLedgerPage });

const r2 = (n: number) => Math.round(n * 100) / 100;

// Keeps the date range selected everywhere — across switching to a
// different payee entirely, anything short of an actual page reload (which
// starts fresh again).
let dateCache: { dateFrom: string; dateTo: string } | null = null;

function PayeeLedgerPage() {
  const _repoV = useRepoData();
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const goBack = useGoBack("/payees");
  const [payee, setPayee] = useState<Payee | null | undefined>(undefined);
  const [dateFrom, setDateFrom] = useState(() => dateCache?.dateFrom ?? "");
  const [dateTo, setDateTo] = useState(() => dateCache?.dateTo ?? "");
  const [pdfBusy, setPdfBusy] = useState<"download" | "share" | null>(null);
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPayee(PayeeRepo.get(id) ?? null);
  }, [id, _repoV]);

  useEffect(() => {
    dateCache = { dateFrom, dateTo };
  }, [dateFrom, dateTo]);

  const bankNameById = useRepoMemo(() => new Map(BankRepo.all().map((b) => [b.id, b.name])));

  // Every expense ever paid to this payee, oldest first, with a running
  // total — same shape as the party ledgers, but one-directional (an
  // expense only ever adds to what's been paid, never reduces it).
  const allRows = useRepoMemo(() => {
    if (!payee) return [];
    return ExpenseRepo.all()
      .filter((e) => e.payeeId === payee.id)
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  }, [payee]);

  const rows = useMemo(() => {
    let running = 0;
    const before = dateFrom ? allRows.filter((e) => e.date < dateFrom) : [];
    for (const e of before) running = r2(running + e.amount);
    const windowRows = allRows.filter(
      (e) => (!dateFrom || e.date >= dateFrom) && (!dateTo || e.date <= dateTo),
    );
    return windowRows.map((e) => {
      running = r2(running + e.amount);
      return { ...e, running };
    });
  }, [allRows, dateFrom, dateTo]);

  const totalPaid = rows.reduce((s, r) => s + r.amount, 0);
  const allTimeTotal = allRows.reduce((s, r) => s + r.amount, 0);

  const pdfName = () => `Payee-Ledger-${(payee?.name ?? "Payee").replace(/\s+/g, "-")}`;

  // Re-entry point for printOrEscapeStandalone's standalone-app escape (see
  // lib/print.ts) — this tab opened fresh with ?print=1, so print
  // immediately once the payee has loaded.
  useAutoPrintFromUrl(payee ? pdfName() : null, !!payee);

  const { shareReady, share, resetShare } = useShareablePdf("Ledger");

  const handleDownloadPdf = async () => {
    if (!printRef.current || pdfBusy) return;
    resetShare();
    setPdfBusy("download");
    try {
      await downloadElementAsPdf(printRef.current, pdfName(), "portrait");
      toast.success("Ledger downloaded as PDF");
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
      await share(printRef.current, pdfName(), "portrait");
    } catch {
      toast.error("Could not share ledger — try Download PDF instead");
    } finally {
      setPdfBusy(null);
    }
  };

  const downloadExcel = () => {
    if (!payee) return;
    const company = CompanyRepo.get();
    const header = ["Date", "Category", "Mode", "Notes", "Amount", "Running Total"];
    const sheetRows = rows.map((r) => [
      fmtDate(r.date),
      r.category,
      r.paymentMode === "bank"
        ? `Bank — ${bankNameById.get(r.bankId ?? "") ?? "unspecified"}`
        : fmtMode(r.paymentMode),
      r.notes ?? "",
      r.amount,
      r.running,
    ]);
    downloadXlsx(`Payee-Ledger-${payee.name}`, [
      {
        name: payee.name,
        rows: [[company.name], [`Ledger Of ${payee.name}`], [], header, ...sheetRows],
      },
    ]);
    toast.success("Ledger downloaded as Excel");
  };

  if (payee === undefined) return null;
  if (payee === null) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 text-gray-400">
        <AlertCircle className="h-12 w-12 text-gray-200" />
        <p className="font-medium">Payee not found</p>
        <button
          onClick={() => navigate({ to: "/payees" })}
          className="text-sm text-primary hover:underline"
        >
          ← Back to Payees
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#f5f6fa]">
      <div className="no-print bg-white border-b px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            onClick={goBack}
            className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 hover:border-gray-300 flex items-center justify-center text-gray-600 transition shadow-sm"
            aria-label="Go back"
            title="Back to Payees"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="h-8 w-8 shrink-0 rounded-full bg-primary-soft text-primary flex items-center justify-center font-bold text-[13px] uppercase">
            {payee.name.trim().charAt(0) || "?"}
          </div>
          <div className="min-w-0">
            <h1 className="text-[15px] font-bold text-gray-800 truncate leading-tight">
              {payee.name}
            </h1>
            <p className="text-[11px] text-gray-400 leading-tight">
              {payee.defaultCategory ? `Usually: ${payee.defaultCategory}` : "Expense payee"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <span>From</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="border border-gray-200 rounded-md text-xs px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
            <span>To</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="border border-gray-200 rounded-md text-xs px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
          </div>
          <button
            onClick={downloadExcel}
            className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition"
            title="Download as Excel"
          >
            <Download className="h-4 w-4" />
          </button>
          <button
            onClick={handleDownloadPdf}
            disabled={pdfBusy !== null}
            className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition disabled:opacity-50"
            title="Download as PDF"
          >
            <FileDown className="h-4 w-4" />
          </button>
          <button
            onClick={handleShare}
            disabled={pdfBusy !== null}
            className={`h-8 w-8 shrink-0 rounded-md border bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition disabled:opacity-50 ${shareReady ? "border-primary ring-2 ring-primary animate-pulse" : "border-gray-200"}`}
            title={shareReady ? "PDF ready — tap again to share" : "Share PDF"}
          >
            <Share2 className="h-4 w-4" />
          </button>
          <button
            onClick={() => printOrEscapeStandalone(pdfName(), undefined, handleDownloadPdf)}
            className="inline-flex items-center gap-1.5 h-8 px-3 bg-primary text-white rounded-md text-sm font-semibold hover:opacity-90 transition"
            title="Print"
          >
            <Printer className="h-4 w-4" /> Print
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-5">
        <div
          ref={printRef}
          className="print-visible bg-white border rounded-lg shadow-sm max-w-4xl mx-auto"
        >
          <style>{`@media print { @page { size: A4 portrait; margin: 0; } }`}</style>
          <div className="px-5 py-3 border-b flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-bold text-gray-800">Payee Ledger — {payee.name}</p>
              <p className="text-[11px] text-gray-400">
                {CompanyRepo.get().name} · Generated {fmtDate(new Date().toISOString())} · All-time
                total paid: {fmtMoney(allTimeTotal)}
              </p>
            </div>
          </div>
          {/* The mobile/desktop split below is screen-only — print must
              always show the real table regardless of the device it's
              triggered from (a phone's own Print button included), so this
              overrides both sides of the split back for @media print
              rather than trusting how a given browser resolves `md:` during
              an actual print render. */}
          <style>{`@media print {
            .payee-ledger-mobile-cards { display: none !important; }
            .payee-ledger-table { display: block !important; }
          }`}</style>
          {/* Mobile card list — a 6-column table doesn't fit a phone; this
              is the same read-only data as one row-card per payment instead
              (no click action here either, same as the desktop table). */}
          <div className="md:hidden payee-ledger-mobile-cards">
            {rows.length === 0 ? (
              <div className="text-center py-14 text-gray-400">No payments to {payee.name} yet</div>
            ) : (
              <div className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <div key={r.id} className="bg-white p-4">
                    <div className="flex items-start justify-between gap-3 mb-1">
                      <div className="min-w-0">
                        <p className="font-medium text-gray-800 truncate">{r.category}</p>
                        <p className="text-xs text-gray-400 mt-0.5 truncate">
                          {fmtDate(r.date)} ·{" "}
                          {r.paymentMode === "bank"
                            ? `Bank — ${bankNameById.get(r.bankId ?? "") ?? "unspecified"}`
                            : fmtMode(r.paymentMode)}
                        </p>
                      </div>
                      <p className="font-bold tabular-nums shrink-0 text-gray-800">
                        {fmtMoney(r.amount)}
                      </p>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-gray-400 truncate">{r.notes ?? "—"}</span>
                      <span className="text-xs font-semibold text-gray-500 shrink-0">
                        Total: {fmtMoney(r.running)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="hidden md:block overflow-x-auto rounded-b-lg payee-ledger-table">
            <table className="w-full text-[12px] border-collapse min-w-[640px]">
              <thead>
                <tr className="bg-gray-50">
                  {["Date", "Category", "Mode", "Notes", "Amount", "Running Total"].map((h, i) => (
                    <th
                      key={h}
                      className={`px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500 border-b border-gray-200 whitespace-nowrap ${i >= 4 ? "text-right" : "text-left"}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-14 text-gray-400">
                      No payments to {payee.name} yet
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.id} className="border-b border-gray-100">
                      <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">
                        {fmtDateShort(r.date)}
                      </td>
                      <td className="px-3 py-2.5 font-medium text-gray-800 whitespace-nowrap">
                        {r.category}
                      </td>
                      <td className="px-3 py-2.5 text-gray-500 text-xs whitespace-nowrap">
                        {r.paymentMode === "bank"
                          ? `Bank — ${bankNameById.get(r.bankId ?? "") ?? "unspecified"}`
                          : fmtMode(r.paymentMode)}
                      </td>
                      <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">
                        {r.notes ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                        {fmtMoney(r.amount)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-semibold whitespace-nowrap">
                        {fmtMoney(r.running)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="bg-gray-50 border-t-2 border-gray-200 font-bold">
                    <td colSpan={4} className="px-3 py-3 text-xs uppercase text-gray-500">
                      Total ({rows.length} payments)
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{fmtMoney(totalPaid)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {fmtMoney(rows[rows.length - 1].running)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useGoBack } from "@/hooks/useGoBack";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BankRepo,
  SalesRepo,
  PurchaseRepo,
  PaymentRepo,
  BankTxnRepo,
  ExpenseRepo,
  CompanyRepo,
} from "@/repositories";
import { buildBankLedger, type BankLedgerRow } from "@/lib/ledger";
import { fmtDate, fmtDateShort, fmtMoney } from "@/lib/format";
import { printOrEscapeStandalone } from "@/lib/print";
import { useAutoPrintFromUrl } from "@/hooks/useAutoPrintFromUrl";
import { useRepoData, useRepoMemo } from "@/hooks/useRepoData";
import { downloadCsv } from "@/lib/csv";
import { downloadElementAsPdf } from "@/lib/pdf";
import type { BankAccount } from "@/types";
import {
  ArrowLeft,
  Printer,
  Download,
  Landmark,
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/bank_/$id")({ component: BankStatementPage });

// Keeps the date range selected everywhere — across leaving to view a
// linked sale/purchase, across switching to a different bank account
// entirely, anything short of an actual page reload (which starts fresh
// again).
let dateCache: { dateFrom: string; dateTo: string } | null = null;

function BankStatementPage() {
  const _repoV = useRepoData();
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const goBack = useGoBack("/bank");
  const [bank, setBank] = useState<BankAccount | null | undefined>(undefined);
  const [dateFrom, setDateFrom] = useState(() => dateCache?.dateFrom ?? "");
  const [dateTo, setDateTo] = useState(() => dateCache?.dateTo ?? "");
  const [pdfBusy, setPdfBusy] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setBank(BankRepo.get(id) ?? null);
  }, [id, _repoV]);

  useEffect(() => {
    dateCache = { dateFrom, dateTo };
  }, [dateFrom, dateTo]);

  // Re-entry point for printOrEscapeStandalone's standalone-app escape (see
  // lib/print.ts) — this tab opened fresh with ?print=1, so print
  // immediately once the bank account has loaded.
  useAutoPrintFromUrl(bank ? `Bank-${bank.name.replace(/\s+/g, "-")}` : null, !!bank);

  const { rows } = useRepoMemo(() => {
    if (!bank) return { rows: [] as BankLedgerRow[] };
    return buildBankLedger(
      bank,
      {
        sales: SalesRepo.all(),
        purchases: PurchaseRepo.all(),
        payments: PaymentRepo.all(),
        bankTxns: BankTxnRepo.all(),
        expenses: ExpenseRepo.all(),
      },
      dateFrom,
      dateTo,
    );
  }, [bank, dateFrom, dateTo]);

  const openRow = (e: BankLedgerRow) => {
    if (!e.docId || !e.docKind) return;
    if (e.docKind === "sale") navigate({ to: "/sales/$id", params: { id: e.docId } });
    else navigate({ to: "/purchase/$id", params: { id: e.docId } });
  };

  if (bank === undefined) return null;
  if (bank === null) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 text-gray-400">
        <AlertCircle className="h-12 w-12 text-gray-200" />
        <p className="font-medium">Bank account not found</p>
        <button
          onClick={() => navigate({ to: "/bank" })}
          className="text-sm text-primary hover:underline"
        >
          ← Back to Bank Accounts
        </button>
      </div>
    );
  }

  const balance = rows.length ? rows[rows.length - 1].balance : bank.openingBalance || 0;
  const totalDebit = rows.reduce((s, e) => s + e.debit, 0);
  const totalCredit = rows.reduce((s, e) => s + e.credit, 0);

  const downloadExcel = () => {
    const company = CompanyRepo.get();
    const meta: string[][] = [
      ["Bank Passbook"],
      [`Company: ${company.name}`],
      [`Bank: ${bank.name}`],
      [`Account No: ${bank.accountNumber || "—"}`],
      [`IFSC: ${bank.ifsc || "—"}`],
      [
        `Period: ${dateFrom ? fmtDate(dateFrom) : "Beginning"} to ${dateTo ? fmtDate(dateTo) : "Today"}`,
      ],
      [`Generated: ${fmtDate(new Date().toISOString())}`],
      [],
    ];
    const header = ["Date", "Type", "Ref #", "Debit", "Credit", "Balance"];
    const body = rows.map((e) => [
      e.date ? fmtDate(e.date) : "—",
      e.type,
      e.ref,
      e.debit ? fmtMoney(e.debit) : "",
      e.credit ? fmtMoney(e.credit) : "",
      fmtMoney(e.balance),
    ]);
    const closing = [
      "",
      "",
      "Closing Balance",
      fmtMoney(totalDebit),
      fmtMoney(totalCredit),
      fmtMoney(balance),
    ];
    const allRows = [...meta, header, ...body, [], closing];
    downloadCsv(`Passbook-${bank.name}`, allRows[0], allRows.slice(1));
  };

  // Print's standalone-app fallback (see lib/print.ts) — the installed
  // home-screen app can't open a print dialog, so Print saves this same
  // passbook as a PDF instead.
  const handleDownloadPdf = async () => {
    if (!printRef.current || pdfBusy) return;
    setPdfBusy(true);
    try {
      await downloadElementAsPdf(
        printRef.current,
        `Bank-${bank.name.replace(/\s+/g, "-")}`,
        "portrait",
      );
      toast.success("Passbook downloaded as PDF");
    } catch {
      toast.error("Could not generate PDF — try again once online");
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#f5f6fa]">
      {/* Header */}
      <div className="no-print bg-white border-b px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={goBack}
            className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 hover:border-gray-300 flex items-center justify-center text-gray-600 transition shadow-sm"
            aria-label="Go back"
            title="Back to Bank Accounts"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="h-10 w-10 shrink-0 rounded-lg bg-primary-soft text-primary flex items-center justify-center">
            <Landmark className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-[17px] font-bold text-gray-800 truncate leading-tight">
              {bank.name}
            </h1>
            <p className="text-[12px] text-gray-400 truncate">
              {bank.accountNumber ? `A/C ${bank.accountNumber} · ` : ""}Balance: {fmtMoney(balance)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={downloadExcel}
            className="inline-flex items-center gap-1.5 h-8 px-4 bg-white border border-gray-200 text-gray-700 rounded-md text-sm font-semibold hover:bg-gray-50 transition"
            title="Download full passbook as Excel/CSV"
          >
            <Download className="h-4 w-4" /> Download Excel
          </button>
          <button
            onClick={() =>
              printOrEscapeStandalone(
                `Bank-${bank.name.replace(/\s+/g, "-")}`,
                undefined,
                handleDownloadPdf,
              )
            }
            disabled={!!pdfBusy}
            className="inline-flex items-center gap-1.5 h-8 px-4 bg-primary text-white rounded-md text-sm font-semibold hover:opacity-90 transition disabled:opacity-60 disabled:cursor-not-allowed"
            title="Print, or choose 'Save as PDF' in the print dialog"
          >
            {pdfBusy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Preparing…
              </>
            ) : (
              <>
                <Printer className="h-4 w-4" /> Print / PDF
              </>
            )}
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="no-print grid grid-cols-1 sm:grid-cols-3 bg-white border-b">
        <div className="px-5 py-3.5 border-r border-gray-100">
          <p className="text-[11px] text-gray-400 font-medium uppercase tracking-wide mb-1">
            Total Credit (In)
          </p>
          <p className="text-[20px] font-bold tabular-nums text-emerald-600">
            {fmtMoney(totalCredit)}
          </p>
        </div>
        <div className="px-5 py-3.5 border-r border-gray-100">
          <p className="text-[11px] text-gray-400 font-medium uppercase tracking-wide mb-1">
            Total Debit (Out)
          </p>
          <p className="text-[20px] font-bold tabular-nums text-rose-600">{fmtMoney(totalDebit)}</p>
        </div>
        <div className="px-5 py-3.5">
          <p className="text-[11px] text-gray-400 font-medium uppercase tracking-wide mb-1">
            Current Balance
          </p>
          <p className="text-[20px] font-bold tabular-nums text-gray-800">{fmtMoney(balance)}</p>
        </div>
      </div>

      {/* Passbook (also the printable area) */}
      <div className="flex-1 overflow-auto p-5">
        <div
          ref={printRef}
          className="print-visible bg-white border rounded-lg shadow-sm overflow-hidden max-w-4xl mx-auto print:p-6"
        >
          <div className="px-5 py-3 border-b flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-bold text-gray-800">Bank Passbook — {bank.name}</p>
              <p className="text-[11px] text-gray-400">
                {CompanyRepo.get().name} · Generated {fmtDate(new Date().toISOString())} · Balance:{" "}
                {fmtMoney(balance)}
              </p>
            </div>
            <div className="no-print flex items-center gap-1.5 text-xs text-gray-500">
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
              {(dateFrom || dateTo) && (
                <button
                  onClick={() => {
                    setDateFrom("");
                    setDateTo("");
                  }}
                  className="text-gray-400 hover:text-gray-600 font-semibold px-1"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
          {/* The mobile/desktop split below is screen-only — print must
              always show the real table regardless of the device it's
              triggered from (a phone's own Print button included), so this
              overrides both sides of the split back for @media print
              rather than trusting how a given browser resolves `md:` during
              an actual print render. */}
          <style>{`@media print {
            .bank-ledger-mobile-cards { display: none !important; }
            .bank-ledger-table { display: table !important; }
          }`}</style>
          {/* Mobile card list — a 6-column table doesn't fit a phone; this
              is the same data as one tappable card per row instead. */}
          <div className="md:hidden bank-ledger-mobile-cards">
            {rows.length === 0 ? (
              <div className="text-center py-14 text-gray-400">
                No transactions in this account yet
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {rows.map((e, i) => {
                  const isCredit = !!e.credit;
                  const isDebit = !!e.debit;
                  return (
                    <div
                      key={i}
                      onClick={e.docId ? () => openRow(e) : undefined}
                      title={e.docId ? "Open this bill" : undefined}
                      className={`bg-white px-4 py-3 flex items-center gap-3 ${e.docId ? "cursor-pointer active:bg-gray-50" : ""}`}
                    >
                      <div
                        className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${isCredit ? "bg-emerald-50 text-emerald-600" : isDebit ? "bg-rose-50 text-rose-600" : "bg-gray-100 text-gray-400"}`}
                      >
                        {isDebit ? (
                          <ArrowUpRight className="h-4 w-4" />
                        ) : (
                          <ArrowDownLeft className="h-4 w-4" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-semibold text-[13px] text-gray-800 truncate leading-tight">
                            {e.type}
                          </p>
                          <p
                            className={`font-bold text-[13px] tabular-nums shrink-0 leading-tight ${isDebit ? "text-rose-600" : isCredit ? "text-emerald-600" : "text-gray-800"}`}
                          >
                            {isDebit
                              ? `−${fmtMoney(e.debit)}`
                              : isCredit
                                ? `+${fmtMoney(e.credit)}`
                                : "—"}
                          </p>
                        </div>
                        <div className="flex items-center justify-between gap-2 mt-1">
                          <p className="text-[11px] text-gray-400 truncate">
                            {e.date ? fmtDate(e.date) : "—"}
                            {e.ref ? ` · ${e.ref}` : ""}
                          </p>
                          <span className="text-[11px] font-semibold text-gray-500 shrink-0 tabular-nums">
                            Bal {fmtMoney(e.balance)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <table className="hidden md:table bank-ledger-table w-full text-[12.5px] border-collapse">
            <thead>
              <tr className="bg-gray-50">
                {["Date", "Type", "Ref #", "Debit (−)", "Credit (+)", "Balance"].map((h, i) => (
                  <th
                    key={h}
                    className={`px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500 border-b border-gray-200 whitespace-nowrap ${i >= 3 ? "text-right" : "text-left"}`}
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
                    No transactions in this account yet
                  </td>
                </tr>
              ) : (
                rows.map((e, i) => (
                  <tr
                    key={i}
                    onClick={() => openRow(e)}
                    title={e.docId ? "Open this bill" : undefined}
                    className={`border-b border-gray-100 hover:bg-gray-50/60 ${e.docId ? "cursor-pointer" : ""}`}
                  >
                    <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">
                      {e.date ? fmtDateShort(e.date) : "—"}
                    </td>
                    <td className="px-4 py-2.5 font-medium text-gray-800">{e.type}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-blue-600">{e.ref}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-rose-600">
                      {e.debit ? fmtMoney(e.debit) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600">
                      {e.credit ? fmtMoney(e.credit) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-gray-800">
                      {fmtMoney(e.balance)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="bg-gray-50 border-t-2 border-gray-200 font-bold">
                  <td colSpan={3} className="px-4 py-3 text-xs uppercase text-gray-500">
                    Closing Balance
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-rose-600">
                    {fmtMoney(totalDebit)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-emerald-600">
                    {fmtMoney(totalCredit)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-800">
                    {fmtMoney(balance)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

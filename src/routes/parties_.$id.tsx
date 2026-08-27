import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useGoBack } from "@/hooks/useGoBack";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  PartyRepo,
  SalesRepo,
  PurchaseRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  PaymentRepo,
  CompanyRepo,
} from "@/repositories";
import { buildPartyStatement, buildSimpleLedgerRows, type PartyStatementRow } from "@/lib/ledger";
import { fmtMoney, fmtDate } from "@/lib/format";
import { printOrEscapeStandalone } from "@/lib/print";
import { useAutoPrintFromUrl } from "@/hooks/useAutoPrintFromUrl";
import { useRepoData, useRepoMemo } from "@/hooks/useRepoData";
import { downloadXlsx } from "@/lib/xlsx";
import { downloadElementAsPdf } from "@/lib/pdf";
import { useShareablePdf } from "@/hooks/useShareablePdf";
import { sendElementViaWhatsApp } from "@/lib/whatsappSend";
import { partyStatementSheet } from "@/lib/partySheet";
import { PartyDialog } from "./parties";
import { usePermissions } from "@/hooks/usePermissions";
import type { Party } from "@/types";
import { toast } from "sonner";
import {
  Pencil,
  Printer,
  AlertCircle,
  Phone,
  Download,
  FileDown,
  Share2,
  Receipt,
  CheckCircle2,
  FileText,
  Rows3,
  MessageCircle,
  Calendar,
  X,
  Loader2,
  type LucideIcon,
  ChevronLeft,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const r2 = (n: number) => Math.round(n * 100) / 100;
// Dr (receivable — they owe us) / Cr (payable — we owe them), so the
// Simple Ledger's Balance column reads correctly printed in black & white.
const fmtBal = (n: number) => `${fmtMoney(Math.abs(n))}${n > 0 ? " Dr" : n < 0 ? " Cr" : ""}`;

export const Route = createFileRoute("/parties_/$id")({ component: PartyStatementPage });

type LedgerRow = PartyStatementRow;

// Keeps the date range selected everywhere — across leaving to view a
// linked sale/purchase/return, across switching to a different party
// entirely, anything short of an actual page reload (which starts fresh
// again).
let dateCache: { dateFrom: string; dateTo: string } | null = null;

function PartyStatementPage() {
  const _repoV = useRepoData();
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const goBack = useGoBack("/parties");
  const { isOwner, canEdit } = usePermissions();
  const editAllowed = isOwner || canEdit("masterData");
  const [party, setParty] = useState<Party | null | undefined>(undefined);
  const [editOpen, setEditOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [dateFrom, setDateFrom] = useState(() => dateCache?.dateFrom ?? "");
  const [dateTo, setDateTo] = useState(() => dateCache?.dateTo ?? "");
  const [pdfBusy, setPdfBusy] = useState<"download" | "share" | "whatsapp" | null>(null);
  const printRef = useRef<HTMLDivElement>(null);
  const simpleLedgerRef = useRef<HTMLDivElement>(null);
  // Which of the two printable layouts is currently wired up to become the
  // printed/exported page — toggled right before a Print/PDF/Share action
  // fires, based on the user's choice in the format-picker modal below.
  // Doesn't affect normal on-screen viewing (the existing statement is
  // always visible on screen regardless — only the print-time class moves).
  const [ledgerFormat, setLedgerFormat] = useState<"full" | "simple">("full");
  const [formatPrompt, setFormatPrompt] = useState<
    null | "print" | "download" | "share" | "whatsapp"
  >(null);
  const pendingActionRef = useRef<null | "print" | "download" | "share" | "whatsapp">(null);
  // Fires the pending action below — a separate counter, not `ledgerFormat`
  // itself, because if the user picks the format that's already active
  // (e.g. "Full Detail Ledger" while ledgerFormat is already "full", the
  // default and by far the most common pick) setLedgerFormat is a no-op and
  // the effect would never re-run, silently dropping the click.
  const [actionTrigger, setActionTrigger] = useState(0);

  useEffect(() => {
    setParty(PartyRepo.get(id) ?? null);
  }, [id, refreshKey, _repoV]);

  useEffect(() => {
    dateCache = { dateFrom, dateTo };
  }, [dateFrom, dateTo]);

  const { rows } = useRepoMemo(() => {
    if (!party) return { rows: [] as LedgerRow[], fullBalance: 0 };
    return buildPartyStatement(
      party,
      {
        sales: SalesRepo.all(),
        purchases: PurchaseRepo.all(),
        saleReturns: SaleReturnRepo.all(),
        purchaseReturns: PurchaseReturnRepo.all(),
        payments: PaymentRepo.all(),
      },
      dateFrom,
      dateTo,
    );
  }, [party, refreshKey, dateFrom, dateTo]);

  // The plain Date/Particulars/Qty/Credit/Debit/Balance ledger the client
  // asked for, alongside the existing detailed statement — not replacing it.
  // Credit/Debit are derived from how much the running `balance` moved on
  // each row (not re-derived independently from total/receivedOrPaid), so
  // this can never disagree with the balance the existing statement already
  // shows and the ledger audit suite already covers.
  // Shared with the bulk ledger export — see buildSimpleLedgerRows.
  const simpleLedgerRows = useMemo(() => buildSimpleLedgerRows(rows), [rows]);

  const openRow = (e: LedgerRow) => {
    if (!e.docId || !e.docKind) return;
    if (e.docKind === "sale") navigate({ to: "/sales/$id", params: { id: e.docId } });
    else if (e.docKind === "purchase") navigate({ to: "/purchase/$id", params: { id: e.docId } });
    else if (e.docKind === "sale-return")
      navigate({ to: "/sale-return/$id", params: { id: e.docId } });
    else navigate({ to: "/purchase-return/$id", params: { id: e.docId } });
  };

  const pdfName = () => `Statement-${(party?.name ?? "Party").replace(/\s+/g, "-")}`;

  // Re-entry point for printOrEscapeStandalone's standalone-app escape (see
  // lib/print.ts) — this tab opened fresh with ?print=1, so print immediately
  // once the party has loaded rather than making the user pick a format
  // again; always uses the "full" statement (this page's own default) since
  // whatever format the original tap chose isn't carried across tabs.
  useAutoPrintFromUrl(party ? pdfName() : null, !!party);

  const activePrintEl = () =>
    ledgerFormat === "simple" ? simpleLedgerRef.current : printRef.current;

  const { shareReady, share, resetShare } = useShareablePdf("Statement");

  const handleDownloadPdf = async () => {
    const el = activePrintEl();
    if (!el || pdfBusy) return;
    resetShare();
    setPdfBusy("download");
    try {
      await downloadElementAsPdf(el, pdfName(), "landscape");
      toast.success("Statement downloaded as PDF");
    } catch {
      toast.error("Could not generate PDF — try Print instead");
    } finally {
      setPdfBusy(null);
    }
  };

  const handleShare = async () => {
    const el = activePrintEl();
    if (!el || pdfBusy) return;
    setPdfBusy("share");
    try {
      await share(el, pdfName(), "landscape");
    } catch {
      toast.error("Could not share statement — try Download PDF instead");
    } finally {
      setPdfBusy(null);
    }
  };

  const handleSendWhatsApp = async () => {
    const el = activePrintEl();
    if (!el || pdfBusy || !party) return;
    setPdfBusy("whatsapp");
    try {
      const company = CompanyRepo.get();
      await sendElementViaWhatsApp({
        el,
        phone: party.phone,
        message: `Hi ${party.name}, here's your account statement${company ? ` from ${company.name}` : ""}.`,
        fileName: pdfName(),
        orientation: "landscape",
      });
      toast.success("Statement sent on WhatsApp");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send via WhatsApp");
    } finally {
      setPdfBusy(null);
    }
  };

  // Print/Download/Share all route through the format-picker modal so the
  // user always picks a layout first. `ledgerFormat` must actually commit to
  // the DOM (toggling which block carries the print-time class) before the
  // action fires — a plain synchronous call right after setLedgerFormat
  // would still see the old DOM, since React applies the state update on
  // the next render, not immediately. This effect runs after that commit.
  //
  // Declared above the party-loaded early returns below (with everything it
  // calls guarded against `party` being null) so this hook always runs in
  // the same position on every render — conditionally calling a hook after
  // an early return breaks the Rules of Hooks.
  const promptFormat = (action: "print" | "download" | "share" | "whatsapp") =>
    setFormatPrompt(action);

  const chooseFormat = (fmt: "full" | "simple") => {
    pendingActionRef.current = formatPrompt;
    setFormatPrompt(null);
    setLedgerFormat(fmt);
    setActionTrigger((n) => n + 1);
  };

  useEffect(() => {
    const action = pendingActionRef.current;
    if (!action) return;
    pendingActionRef.current = null;
    if (action === "print") printOrEscapeStandalone(pdfName(), undefined, handleDownloadPdf);
    else if (action === "download") handleDownloadPdf();
    else if (action === "whatsapp") handleSendWhatsApp();
    else handleShare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionTrigger]);

  if (party === undefined) return null;
  if (party === null) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 text-gray-400">
        <AlertCircle className="h-12 w-12 text-gray-200" />
        <p className="font-medium">Party not found</p>
        <button
          onClick={() => navigate({ to: "/parties" })}
          className="text-sm text-primary hover:underline"
        >
          ← Back to Parties
        </button>
      </div>
    );
  }

  const balance = rows.length ? rows[rows.length - 1].balance : party.openingBalance || 0;
  const totalReceived = rows.reduce((s, e) => s + (e.total > 0 ? e.receivedOrPaid : 0), 0);
  const totalBilled = rows.reduce((s, e) => s + e.total, 0);

  // Trial-balance-style closing: the closing balance is plugged into
  // whichever column (Credit for a Dr balance, Debit for a Cr balance) makes
  // both column totals equal — same convention printed ledgers use, and
  // matches the client's reference sample exactly. Algebraically,
  // (opening-side debit + txn debits) − (opening-side credit + txn credits)
  // always equals the closing balance, so plugging it into the smaller side
  // makes both totals equal by construction — never adjust both sides.
  const openingBalance = simpleLedgerRows[0]?.balance ?? 0;
  const txnDebitSum = simpleLedgerRows.slice(1).reduce((s, r) => s + r.debit, 0);
  const txnCreditSum = simpleLedgerRows.slice(1).reduce((s, r) => s + r.credit, 0);
  const closingBalance = simpleLedgerRows.length
    ? simpleLedgerRows[simpleLedgerRows.length - 1].balance
    : openingBalance;
  const simpleDebitTotal =
    (openingBalance > 0 ? openingBalance : 0) +
    txnDebitSum +
    (closingBalance < 0 ? -closingBalance : 0);
  const simpleCreditTotal =
    (openingBalance < 0 ? -openingBalance : 0) +
    txnCreditSum +
    (closingBalance > 0 ? closingBalance : 0);

  // Vyapar-style ledger export — company/party header info, then one block
  // per transaction with its own item breakdown (matching what the client
  // asked for: the actual bill contents inside the statement, not just a
  // flat debit/credit line), then a closing balance. Reuses the exact rows
  // already shown on screen so the download always matches what's visible.
  const downloadExcel = () => {
    const company = CompanyRepo.get();
    const periodLabel = `${dateFrom ? fmtDate(dateFrom) : "Beginning"} to ${dateTo ? fmtDate(dateTo) : "Today"}`;
    // Real .xlsx via the same builder the Party Ledger report uses — proper
    // column widths and numeric amount cells (the old CSV version opened
    // with every column truncated in Excel/WPS/Numbers)
    downloadXlsx(`Statement-${party.name}`, [
      partyStatementSheet(party, rows, company, periodLabel),
    ]);
    toast.success("Statement downloaded as Excel");
  };

  return (
    <div className="flex flex-col h-full bg-[#f5f6fa]">
      {/* Header */}
      <div className="no-print bg-white border-b px-5 py-3 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            {/* You arrive here by drilling in from Parties (or from a global
                search hit), so there has to be a way back that isn't the
                browser chrome — the client reported this page in particular. */}
            <button
              type="button"
              onClick={goBack}
              aria-label="Go back"
              className="shrink-0 h-8 w-8 -ml-1 rounded-md border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-100 active:bg-gray-100 transition"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="h-8 w-8 shrink-0 rounded-full bg-primary-soft text-primary flex items-center justify-center font-bold text-[13px] uppercase">
              {party.name.trim().charAt(0) || "?"}
            </div>
            <div className="min-w-0">
              <h1 className="text-[15px] font-bold text-gray-800 truncate leading-tight">
                {party.name}
              </h1>
              <p className="text-[11px] text-gray-400 flex items-center gap-1 whitespace-nowrap">
                {party.phone ? (
                  <>
                    <Phone className="h-3 w-3" /> {party.phone}
                  </>
                ) : (
                  "No phone saved"
                )}
              </p>
            </div>
          </div>
          {/* Export/share actions — kept to the left of the edit button so
              the whole action set (Excel/PDF/Share/WhatsApp/Print) reads as
              one group with Edit, instead of its own row competing with the
              balance cards for vertical space. Pure layout move — none of
              the handlers below changed. */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={downloadExcel}
              className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition"
              title="Download full ledger as Excel"
            >
              <Download className="h-4 w-4" />
            </button>
            <button
              onClick={() => promptFormat("download")}
              disabled={pdfBusy !== null}
              className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition disabled:opacity-50"
              title="Download statement as PDF"
            >
              <FileDown className="h-4 w-4" />
            </button>
            <button
              // Once a PDF is already prepared and waiting for confirmation
              // (shareReady), this tap must go straight to handleShare() — a
              // direct, fresh click — rather than back through the format
              // modal, or the share sheet loses the user gesture it needs.
              onClick={() => (shareReady ? handleShare() : promptFormat("share"))}
              disabled={pdfBusy !== null}
              className={`h-8 w-8 shrink-0 rounded-md border bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition disabled:opacity-50 ${shareReady ? "border-primary ring-2 ring-primary animate-pulse" : "border-gray-200"}`}
              title={shareReady ? "PDF ready — tap again to share" : "Share statement PDF"}
            >
              <Share2 className="h-4 w-4" />
            </button>
            <button
              onClick={() => promptFormat("whatsapp")}
              disabled={pdfBusy !== null}
              className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition disabled:opacity-50"
              title="Send statement on WhatsApp"
            >
              <MessageCircle className="h-4 w-4" />
            </button>
            {editAllowed && (
              <button
                onClick={() => setEditOpen(true)}
                className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition"
                title="Edit party"
              >
                <Pencil className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={() => promptFormat("print")}
              disabled={!!pdfBusy}
              className="h-8 w-8 shrink-0 rounded-md bg-primary text-white flex items-center justify-center transition hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
              title="Print"
            >
              {pdfBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Printer className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        {/* Balance summary — its own row, evenly split. */}
        <div className="grid grid-cols-3 gap-2">
          <StatementCard icon={Receipt} label="Total Billed" value={totalBilled} tone="gray" />
          <StatementCard
            icon={CheckCircle2}
            label="Received / Paid"
            value={totalReceived}
            tone="emerald"
          />
          <StatementCard
            icon={AlertCircle}
            label={balance > 0 ? "They Owe You" : balance < 0 ? "You Owe Them" : "Settled"}
            value={Math.abs(balance)}
            tone={balance > 0 ? "rose" : balance < 0 ? "amber" : "emerald"}
          />
        </div>
      </div>

      {/* Statement (also the printable area) */}
      <div className="flex-1 overflow-auto p-5">
        <div
          ref={printRef}
          className={`${ledgerFormat === "full" ? "print-visible" : ""} bg-white border rounded-lg shadow-sm max-w-6xl mx-auto`}
        >
          {/* The statement is 9 columns wide plus a nested item table — too
              wide for portrait A4, so it gets cut off at the right edge on
              print/PDF. Landscape gives it enough width to fit. No margin
              here — .print-visible below already adds 12mm of its own via
              padding; setting it again here on @page doubled it to 24mm.
              Only rendered while this format is the active one — both this
              and the Simple Ledger's @page rule would otherwise both be in
              the document at once, and the later one in DOM order always
              wins the @page cascade regardless of which format is chosen. */}
          {ledgerFormat === "full" && (
            <style>{`@media print { @page { size: A4 landscape; margin: 0; } }`}</style>
          )}
          <div className="px-5 py-3 border-b flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-gray-800">Party Statement — {party.name}</p>
              {/* Balance intentionally NOT repeated here — the "They owe you" /
                summary box above already shows it, and the statement's own
                Closing Balance row shows it at the bottom. */}
              <p className="text-[11px] text-gray-400">
                {CompanyRepo.get().name} · Generated {fmtDate(new Date().toISOString())}
              </p>
            </div>
            <div className="no-print flex items-center gap-1.5 h-9 pl-3 pr-2.5 rounded-lg border border-gray-200 bg-gray-50/60 w-full sm:w-auto sm:shrink-0">
              <Calendar className="h-3.5 w-3.5 text-gray-400 shrink-0" />
              {/* iOS Safari renders an empty type="date" input as literally
                  blank — no "dd/mm/yyyy"-style hint the way desktop browsers
                  show one — so a cleared/unset date here just looks broken.
                  This label sits on top (pointer-events-none, so the tap
                  still opens the real native picker underneath) only while
                  the value is empty. */}
              <div className="relative flex-1 sm:flex-none sm:w-[104px] min-w-0">
                {!dateFrom && (
                  <span className="absolute inset-0 flex items-center text-xs text-gray-400 pointer-events-none">
                    From
                  </span>
                )}
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="w-full bg-transparent text-xs text-gray-700 focus:outline-none"
                />
              </div>
              <span className="text-gray-300 text-xs">–</span>
              <div className="relative flex-1 sm:flex-none sm:w-[104px] min-w-0">
                {!dateTo && (
                  <span className="absolute inset-0 flex items-center text-xs text-gray-400 pointer-events-none">
                    To
                  </span>
                )}
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="w-full bg-transparent text-xs text-gray-700 focus:outline-none"
                />
              </div>
              {(dateFrom || dateTo) && (
                <button
                  onClick={() => {
                    setDateFrom("");
                    setDateTo("");
                  }}
                  className="text-gray-400 hover:text-gray-600 transition shrink-0"
                  title="Clear date range"
                >
                  <X className="h-3.5 w-3.5" />
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
            .party-statement-mobile-cards { display: none !important; }
            .party-statement-table { display: block !important; }
          }`}</style>
          {/* Mobile card list — a 9-column table doesn't fit a phone; this
              is the same statement as one tappable card per transaction
              instead (item-level breakdown is left for the full bill, one
              tap away). */}
          <div className="md:hidden party-statement-mobile-cards">
            {rows.length === 0 ? (
              <div className="text-center py-14 text-gray-400">
                No transactions with this party yet
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {rows.map((e, i) => (
                  <PartyStatementCardBlock key={i} row={e} onOpen={() => openRow(e)} />
                ))}
              </div>
            )}
            {rows.length > 0 && (
              <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-t text-xs font-bold uppercase text-gray-500">
                <span>Closing Balance</span>
                <span
                  className={
                    balance > 0 ? "text-rose-600" : balance < 0 ? "text-amber-600" : "text-gray-500"
                  }
                >
                  {balance > 0
                    ? `${fmtMoney(balance)} Dr`
                    : balance < 0
                      ? `${fmtMoney(-balance)} Cr`
                      : "Settled"}
                </span>
              </div>
            )}
          </div>

          <div className="hidden md:block overflow-x-auto rounded-b-lg party-statement-table">
            <table className="w-full text-[12px] border-collapse min-w-[980px]">
              <thead>
                <tr className="bg-gray-50">
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
                    <td colSpan={9} className="text-center py-14 text-gray-400">
                      No transactions with this party yet
                    </td>
                  </tr>
                ) : (
                  rows.map((e, i) => (
                    <PartyStatementRowBlock key={i} row={e} onOpen={() => openRow(e)} />
                  ))
                )}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="bg-gray-50 border-t-2 border-gray-200 font-bold">
                    <td colSpan={7} className="px-3 py-3 text-xs uppercase text-gray-500">
                      Closing Balance
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-rose-600">
                      {balance > 0 ? fmtMoney(balance) : "—"}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-amber-600">
                      {balance < 0 ? fmtMoney(-balance) : "—"}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </div>

      {/* Simple Ledger — plain Date/Particulars/Qty/Credit/Debit/Balance
          format matching the client's reference sample. Never shown on
          screen (no "print-visible" here, ever) — only becomes the printed
          page when ledgerFormat is "simple" and a Print/PDF/Share action
          fires; see the format-picker modal below. */}
      <div
        ref={simpleLedgerRef}
        className={`${ledgerFormat === "simple" ? "print-area" : "hidden"} bg-white`}
      >
        {ledgerFormat === "simple" && (
          <style>{`@media print { @page { size: A4 portrait; margin: 0; } }`}</style>
        )}
        <div className="text-center mb-3">
          <p className="text-lg font-bold uppercase tracking-wide">{CompanyRepo.get().name}</p>
          <p className="text-[11px] text-gray-500">
            Ledger Of {party.name}
            {dateFrom || dateTo
              ? ` From ${dateFrom ? fmtDate(dateFrom) : "Beginning"} To ${dateTo ? fmtDate(dateTo) : "Today"}`
              : ""}
          </p>
        </div>
        <table className="w-full text-[11.5px] border-collapse">
          <thead>
            <tr className="border-b-2 border-black">
              {["Date", "Particulars", "Quantity", "Credit", "Debit", "Balance"].map((h, i) => (
                <th
                  key={h}
                  className={`px-2 py-1.5 font-semibold whitespace-nowrap ${i >= 2 ? "text-right" : "text-left"}`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {simpleLedgerRows.map((r, i) => (
              <tr key={i} className="border-b border-gray-200" style={{ breakInside: "avoid" }}>
                <td className="px-2 py-1 whitespace-nowrap">{r.date ? fmtDate(r.date) : ""}</td>
                <td className={`px-2 py-1 whitespace-nowrap ${i === 0 ? "font-semibold" : ""}`}>
                  {r.particulars}
                </td>
                <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">{r.qty}</td>
                <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                  {r.credit ? fmtMoney(r.credit) : ""}
                </td>
                <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                  {r.debit ? fmtMoney(r.debit) : ""}
                </td>
                <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap font-semibold">
                  {fmtBal(r.balance)}
                </td>
              </tr>
            ))}
            <tr className="font-semibold" style={{ breakInside: "avoid" }}>
              <td className="px-2 py-1.5" colSpan={2}>
                Closing Balance
              </td>
              <td />
              <td className="px-2 py-1.5 text-right tabular-nums">
                {closingBalance > 0 ? fmtMoney(closingBalance) : ""}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                {closingBalance < 0 ? fmtMoney(-closingBalance) : ""}
              </td>
              <td />
            </tr>
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-black font-bold">
              <td colSpan={3} />
              <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(simpleCreditTotal)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(simpleDebitTotal)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Format picker — Print/Download/Share all land here first so the
          existing Full Detail Ledger (unchanged) sits alongside the new
          Simple Ledger as an equal choice, not a replacement. */}
      <Dialog open={!!formatPrompt} onOpenChange={(v) => !v && setFormatPrompt(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Choose a ledger format</DialogTitle>
            <DialogDescription>
              Which layout should this{" "}
              {formatPrompt === "whatsapp" ? "WhatsApp message" : (formatPrompt ?? "action")} use?
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-2.5">
            <button
              onClick={() => chooseFormat("full")}
              className="flex items-start gap-3 p-3.5 border rounded-lg text-left hover:bg-accent hover:border-primary/40 transition"
            >
              <FileText className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-sm">Full Detail Ledger</p>
                <p className="text-xs text-muted-foreground">
                  The current statement — every bill's item breakdown, payment status, and balances.
                </p>
              </div>
            </button>
            <button
              onClick={() => chooseFormat("simple")}
              className="flex items-start gap-3 p-3.5 border rounded-lg text-left hover:bg-accent hover:border-primary/40 transition"
            >
              <Rows3 className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-sm">Simple Ledger</p>
                <p className="text-xs text-muted-foreground">
                  One line per transaction — Date, Particulars, Quantity, Credit, Debit, Balance.
                </p>
              </div>
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <PartyDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        party={party}
        onSaved={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  );
}

const STATEMENT_TONES = {
  gray: { bg: "bg-gray-100", text: "text-gray-700" },
  emerald: { bg: "bg-emerald-50", text: "text-emerald-600" },
  rose: { bg: "bg-rose-50", text: "text-rose-600" },
  amber: { bg: "bg-amber-50", text: "text-amber-600" },
} as const;

function StatementCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  tone: keyof typeof STATEMENT_TONES;
}) {
  const t = STATEMENT_TONES[tone];
  return (
    <div className="flex items-center gap-1.5 sm:gap-2.5 px-2 sm:px-3.5 py-2 sm:py-2.5 rounded-lg border border-gray-100 bg-white min-w-0">
      <div
        className={`hidden sm:flex h-8 w-8 rounded-md items-center justify-center shrink-0 ${t.bg} ${t.text}`}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-[9px] sm:text-[10px] text-gray-400 font-medium uppercase tracking-wide mb-0.5 leading-tight">
          {label}
        </p>
        <p className={`text-[12px] sm:text-[14px] font-bold tabular-nums truncate ${t.text}`}>
          {fmtMoney(value)}
        </p>
      </div>
    </div>
  );
}

/** One transaction's summary row, plus — for Sale/Purchase/Returns — a
 * nested item breakdown underneath, matching what the client's reference
 * statement (Vyapar) shows: not just a ledger line, but what was actually
 * in the bill. */
export function PartyStatementRowBlock({
  row: e,
  onOpen,
}: {
  row: PartyStatementRow;
  onOpen: () => void;
}) {
  const itemSubtotal = e.items?.reduce((s, it) => s + it.amount, 0) ?? 0;
  return (
    <>
      <tr
        onClick={onOpen}
        title={e.docId ? "Open this bill" : undefined}
        className={`border-b border-gray-100 hover:bg-gray-50/60 ${e.docId ? "cursor-pointer" : ""} ${e.type === "Beginning Balance" || e.type === "Balance b/f" ? "bg-gray-50/40 font-semibold" : ""}`}
        style={{
          breakInside: "avoid",
          breakAfter: e.items?.length ? "avoid" : undefined,
        }}
      >
        <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">
          {e.date ? fmtDate(e.date) : ""}
        </td>
        <td className="px-3 py-2.5 font-medium text-gray-800 whitespace-nowrap">{e.type}</td>
        <td className="px-3 py-2.5 font-mono text-xs text-blue-600 whitespace-nowrap">{e.ref}</td>
        <td className="px-3 py-2.5 whitespace-nowrap">
          {e.status && (
            <span
              className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                e.status === "Paid"
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : e.status === "Partial"
                    ? "bg-amber-50 text-amber-700 border-amber-200"
                    : "bg-rose-50 text-rose-700 border-rose-200"
              }`}
            >
              {e.status}
            </span>
          )}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
          {e.total ? fmtMoney(e.total) : "—"}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600 whitespace-nowrap">
          {e.receivedOrPaid ? fmtMoney(e.receivedOrPaid) : "—"}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums text-rose-600 whitespace-nowrap">
          {e.txnBalance ? fmtMoney(e.txnBalance) : "—"}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-rose-600 whitespace-nowrap">
          {e.balance > 0 ? fmtMoney(e.balance) : "—"}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-amber-600 whitespace-nowrap">
          {e.balance < 0 ? fmtMoney(-e.balance) : "—"}
        </td>
      </tr>
      {!!e.items?.length && (
        <tr
          className="border-b border-gray-100 bg-gray-50/30"
          style={{ breakInside: "avoid", breakBefore: "avoid" }}
        >
          <td colSpan={9} className="px-3 pb-3 pt-1">
            <table className="w-full text-[11.5px] border-collapse bg-white border rounded-md overflow-hidden">
              <thead>
                <tr className="bg-gray-100">
                  <th className="text-left px-2.5 py-1.5 text-[10px] font-semibold uppercase text-gray-500 w-8">
                    #
                  </th>
                  <th className="text-left px-2.5 py-1.5 text-[10px] font-semibold uppercase text-gray-500">
                    Item name
                  </th>
                  <th className="text-right px-2.5 py-1.5 text-[10px] font-semibold uppercase text-gray-500 w-20">
                    Quantity
                  </th>
                  <th className="text-right px-2.5 py-1.5 text-[10px] font-semibold uppercase text-gray-500 w-24">
                    Price/Unit
                  </th>
                  <th className="text-right px-2.5 py-1.5 text-[10px] font-semibold uppercase text-gray-500 w-24">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {e.items.map((it, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-2.5 py-1.5 text-gray-400">{i + 1}</td>
                    <td className="px-2.5 py-1.5 text-gray-800">{it.name}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{it.qty}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{fmtMoney(it.price)}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{fmtMoney(it.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-gray-200 font-semibold bg-gray-50">
                  <td
                    colSpan={4}
                    className="px-2.5 py-1.5 text-right text-gray-500 uppercase text-[10px]"
                  >
                    Sub Total
                  </td>
                  <td className="px-2.5 py-1.5 text-right tabular-nums">
                    {fmtMoney(itemSubtotal)}
                  </td>
                </tr>
                {(e.charges ?? []).map((c, i) => (
                  <tr key={i} className="border-t border-gray-100 text-gray-500">
                    <td colSpan={4} className="px-2.5 py-1 text-right uppercase text-[10px]">
                      {c.label}
                    </td>
                    <td className="px-2.5 py-1 text-right tabular-nums">
                      {c.amount < 0 ? `−${fmtMoney(-c.amount)}` : fmtMoney(c.amount)}
                    </td>
                  </tr>
                ))}
              </tfoot>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

/** Mobile-card counterpart to PartyStatementRowBlock, used the same way in
 * both the Party Statement page and the Reports page's Party Ledger report
 * — one card per transaction row instead of a 9-column table that doesn't
 * fit a phone. The nested item-breakdown table PartyStatementRowBlock shows
 * per transaction is left out here; tapping the card opens the full
 * bill/return where that detail is always available. */
export function PartyStatementCardBlock({
  row: e,
  onOpen,
}: {
  row: PartyStatementRow;
  onOpen: () => void;
}) {
  const isBalanceRow = e.type === "Beginning Balance" || e.type === "Balance b/f";
  const balanceClass =
    e.balance > 0 ? "text-rose-600" : e.balance < 0 ? "text-amber-600" : "text-gray-400";
  const balanceText =
    e.balance > 0
      ? `${fmtMoney(e.balance)} Dr`
      : e.balance < 0
        ? `${fmtMoney(-e.balance)} Cr`
        : "Settled";

  // Opening / brought-forward marker: a compact muted strip (label + running
  // balance) rather than a full transaction card — it has no bill, date, or
  // amounts to show, so the old full-card layout left a stray "· —" line.
  if (isBalanceRow) {
    return (
      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50/70">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          {e.type}
        </span>
        <span className={`text-xs font-semibold tabular-nums ${balanceClass}`}>{balanceText}</span>
      </div>
    );
  }

  const meta = [e.date ? fmtDate(e.date) : null, e.ref && e.ref !== "—" ? `#${e.ref}` : null]
    .filter(Boolean)
    .join("  ·  ");

  return (
    <div
      onClick={e.docId ? onOpen : undefined}
      className={`px-4 py-3 ${e.docId ? "cursor-pointer active:bg-gray-50" : ""}`}
    >
      {/* Header: transaction type + date/ref, and the status pill */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-gray-800 truncate leading-tight">{e.type}</p>
          {meta && <p className="text-[11px] text-gray-400 mt-0.5 truncate">{meta}</p>}
        </div>
        {e.status && (
          <span
            className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
              e.status === "Paid"
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : e.status === "Partial"
                  ? "bg-amber-50 text-amber-700 border-amber-200"
                  : "bg-rose-50 text-rose-700 border-rose-200"
            }`}
          >
            {e.status}
          </span>
        )}
      </div>
      {/* Amounts: labeled columns on the left, running balance emphasised on the right */}
      <div className="flex items-end justify-between gap-3 mt-2.5">
        <div className="flex gap-5">
          {!!e.total && (
            <div className="min-w-0">
              <p className="text-[9.5px] uppercase tracking-wide text-gray-400 leading-none mb-1">
                Total
              </p>
              <p className="text-[13px] font-medium tabular-nums text-gray-700 leading-none">
                {fmtMoney(e.total)}
              </p>
            </div>
          )}
          {!!e.receivedOrPaid && (
            <div className="min-w-0">
              <p className="text-[9.5px] uppercase tracking-wide text-gray-400 leading-none mb-1">
                Received / Paid
              </p>
              <p className="text-[13px] font-medium tabular-nums text-emerald-600 leading-none">
                {fmtMoney(e.receivedOrPaid)}
              </p>
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-[9.5px] uppercase tracking-wide text-gray-400 leading-none mb-1">
            Balance
          </p>
          <p className={`text-[13px] font-bold tabular-nums leading-none ${balanceClass}`}>
            {balanceText}
          </p>
        </div>
      </div>
    </div>
  );
}

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useGoBack } from "@/hooks/useGoBack";
import { useEffect, useRef, useState } from "react";
import { PurchaseRepo, CompanyRepo, BankRepo } from "@/repositories";
import type { Invoice, Company } from "@/types";
import { fmtMoney } from "@/lib/format";
import { describePayment } from "@/lib/paymentSplit";
import { printWithName, printOrEscapeStandalone, isStandalone } from "@/lib/print";
import { downloadElementAsPdf } from "@/lib/pdf";
import { useShareablePdf } from "@/hooks/useShareablePdf";
import { useFitScale } from "@/hooks/useFitScale";
import { fmtMode } from "@/lib/paymentMode";
import { PrintableInvoice } from "@/components/PrintableInvoice";
import { usePermissions } from "@/hooks/usePermissions";
import { useRepoData } from "@/hooks/useRepoData";
import { toast } from "sonner";
import {
  ArrowLeft,
  Printer,
  Check,
  AlertCircle,
  Pencil,
  FileText,
  FileDown,
  Share2,
  Loader2,
} from "lucide-react";

/** An account's name for display. The word "Bank" three times over is
 *  exactly what a split is meant to stop being ambiguous. */
const bankName = (id: string) => BankRepo.get(id)?.name;

export const Route = createFileRoute("/purchase/$id")({
  component: BillDetailPage,
  validateSearch: (search: Record<string, unknown>): { print?: number } => ({
    print: search.print ? 1 : undefined,
  }),
});

const r2 = (n: number) => Math.round(n * 100) / 100;

// Native pixel size of the printable A4 sheet — the preview scales down to
// fit whatever width it's actually given (see useFitScale) instead of
// forcing horizontal scroll/pan on a phone.
const A4_W = 794;
const A4_H = 1123;

function BillDetailPage() {
  const _repoV = useRepoData();
  const { id } = Route.useParams();
  const { print } = Route.useSearch();
  const navigate = useNavigate();
  const goBack = useGoBack("/purchase");
  const { isOwner, canEdit } = usePermissions();
  const editAllowed = isOwner || canEdit("purchaseExpenses");
  const [inv, setInv] = useState<Invoice | null>(null);
  const [co, setCo] = useState<Company | null>(null);
  const [pdfBusy, setPdfBusy] = useState<"download" | "share" | null>(null);
  const printRef = useRef<HTMLDivElement>(null);
  const { containerRef: previewRef, scale: previewScale } = useFitScale(A4_W);

  useEffect(() => {
    setInv(PurchaseRepo.get(id) ?? null);
    setCo(CompanyRepo.get());
  }, [id, _repoV]);

  // Save & Print flow: arrive with ?print=1 → auto-open the print dialog.
  // Inside the installed home-screen app there IS no print dialog
  // (window.print is a silent no-op there), so fall back to saving the
  // server-rendered PDF instead — same as the Print button does.
  useEffect(() => {
    if (print && inv) {
      const t = setTimeout(() => {
        if (isStandalone()) handleDownloadPdf();
        else printWithName(inv.number);
      }, 500);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [print, inv]);

  const { shareReady, share, resetShare } = useShareablePdf("Bill");

  const handleDownloadPdf = async () => {
    if (!inv || !printRef.current || pdfBusy) return;
    resetShare();
    setPdfBusy("download");
    try {
      await downloadElementAsPdf(printRef.current, inv.number, "portrait");
      toast.success("Bill downloaded as PDF");
    } catch {
      toast.error("Could not generate PDF — try Print instead");
    } finally {
      setPdfBusy(null);
    }
  };

  const handleShare = async () => {
    if (!inv || !printRef.current || pdfBusy) return;
    setPdfBusy("share");
    try {
      await share(printRef.current, inv.number, "portrait");
    } catch {
      toast.error("Could not share bill — try Download PDF instead");
    } finally {
      setPdfBusy(null);
    }
  };

  if (!inv) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 text-gray-400">
        <AlertCircle className="h-12 w-12 text-gray-200" />
        <p className="font-medium">Bill not found</p>
        <button
          onClick={() => navigate({ to: "/purchase" })}
          className="text-sm text-primary hover:underline"
        >
          ← Back to Purchase
        </button>
      </div>
    );
  }

  const balance = r2(inv.total - inv.paid);
  const isPaid = balance <= 0;

  return (
    <div className="flex flex-col h-full bg-gray-100">
      <div className="no-print bg-white border-b px-5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={goBack}
            className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 hover:border-gray-300 flex items-center justify-center text-gray-600 transition shadow-sm"
            aria-label="Go back"
            title="Back to Purchase"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="h-10 w-10 shrink-0 rounded-lg bg-warning-soft text-warning flex items-center justify-center">
            <FileText className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-[17px] font-bold text-gray-800 truncate leading-tight flex items-center gap-2">
              Bill {inv.number}
              {isPaid ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full shrink-0">
                  <Check className="h-3 w-3" /> PAID
                </span>
              ) : (
                <span className="text-[10px] font-bold text-rose-600 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-full shrink-0">
                  PAYABLE
                </span>
              )}
            </h1>
            <p className="text-[12px] text-gray-400 truncate">
              {inv.partyName} · {fmtMoney(inv.total)} · {describePayment(inv, bankName)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
          {editAllowed && (
            <button
              onClick={() => navigate({ to: "/purchase/edit/$id", params: { id: inv.id } })}
              className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 h-8 px-4 bg-white border border-gray-200 text-gray-700 rounded-md text-sm font-semibold hover:bg-gray-50 transition"
            >
              <Pencil className="h-4 w-4" /> Edit
            </button>
          )}
          <button
            onClick={handleDownloadPdf}
            disabled={pdfBusy !== null}
            className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition disabled:opacity-50"
            title="Download bill as PDF"
          >
            <FileDown className="h-4 w-4" />
          </button>
          <button
            onClick={handleShare}
            disabled={pdfBusy !== null}
            className={`h-8 w-8 shrink-0 rounded-md border bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition disabled:opacity-50 ${shareReady ? "border-primary ring-2 ring-primary animate-pulse" : "border-gray-200"}`}
            title={shareReady ? "PDF ready — tap again to share" : "Share bill PDF"}
          >
            <Share2 className="h-4 w-4" />
          </button>
          <button
            onClick={() => printOrEscapeStandalone(inv.number, undefined, handleDownloadPdf)}
            disabled={!!pdfBusy}
            className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 h-8 px-4 bg-primary text-white rounded-md text-sm font-semibold hover:opacity-90 transition disabled:opacity-60 disabled:cursor-not-allowed"
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
      </div>

      <div
        ref={previewRef}
        className="flex-1 overflow-auto py-6 px-4 flex justify-center bg-gray-100"
      >
        {co && (
          <div
            className="shrink-0"
            style={{ width: A4_W * previewScale, height: A4_H * previewScale }}
          >
            <div
              ref={printRef}
              className="preview-fit-scale bg-white w-full max-w-[794px] shadow-lg print:shadow-none print:m-0 p-6"
              style={{
                width: A4_W,
                minHeight: A4_H,
                transform: `scale(${previewScale})`,
                transformOrigin: "top left",
              }}
            >
              <PrintableInvoice inv={inv} company={co} mode="purchase" className="print-visible" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

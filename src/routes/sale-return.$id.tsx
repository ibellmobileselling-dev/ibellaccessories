import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useGoBack } from "@/hooks/useGoBack";
import { useEffect, useRef, useState } from "react";
import { SaleReturnRepo, CompanyRepo } from "@/repositories";
import type { Return, Company } from "@/types";
import { fmtMoney } from "@/lib/format";
import { printOrEscapeStandalone } from "@/lib/print";
import { downloadElementAsPdf } from "@/lib/pdf";
import { PrintableReturn } from "@/components/PrintableReturn";
import { useRepoData } from "@/hooks/useRepoData";
import { toast } from "sonner";
import { ArrowLeft, Printer, AlertCircle, CornerDownLeft, FileDown, Loader2 } from "lucide-react";

export const Route = createFileRoute("/sale-return/$id")({ component: SaleReturnDetailPage });

function SaleReturnDetailPage() {
  const _repoV = useRepoData();
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const goBack = useGoBack("/sale-return");
  const [ret, setRet] = useState<Return | null>(null);
  const [co, setCo] = useState<Company | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRet(SaleReturnRepo.get(id) ?? null);
    setCo(CompanyRepo.get());
  }, [id, _repoV]);

  // Server-rendered PDF — also the fallback Print uses inside the installed
  // app, where window.print() is a silent no-op (see lib/print.ts).
  const handleDownloadPdf = async () => {
    if (!ret || !printRef.current || pdfBusy) return;
    setPdfBusy(true);
    try {
      await downloadElementAsPdf(printRef.current, ret.number, "portrait");
      toast.success("Credit note downloaded as PDF");
    } catch {
      toast.error("Could not generate PDF — try again once online");
    } finally {
      setPdfBusy(false);
    }
  };

  if (!ret) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 text-gray-400">
        <AlertCircle className="h-12 w-12 text-gray-200" />
        <p className="font-medium">Credit note not found</p>
        <button
          onClick={() => navigate({ to: "/sale-return" })}
          className="text-sm text-primary hover:underline"
        >
          ← Back to Sale Returns
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-100">
      <div className="no-print bg-white border-b px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={goBack}
            className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 hover:border-gray-300 flex items-center justify-center text-gray-600 transition shadow-sm"
            aria-label="Go back"
            title="Back to Sale Returns"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="h-10 w-10 shrink-0 rounded-lg bg-primary-soft text-primary flex items-center justify-center">
            <CornerDownLeft className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-[17px] font-bold text-gray-800 truncate leading-tight">
              Credit Note {ret.number}
            </h1>
            <p className="text-[12px] text-gray-400 truncate">
              {ret.partyName} · {fmtMoney(ret.total)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleDownloadPdf}
            disabled={pdfBusy}
            title="Download credit note as PDF"
            className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition disabled:opacity-50"
          >
            <FileDown className="h-4 w-4" />
          </button>
          <button
            onClick={() => printOrEscapeStandalone(ret.number, undefined, handleDownloadPdf)}
            disabled={!!pdfBusy}
            className="inline-flex items-center gap-1.5 h-8 px-4 bg-primary text-white rounded-md text-sm font-semibold hover:opacity-90 transition disabled:opacity-60 disabled:cursor-not-allowed"
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

      <div className="flex-1 overflow-auto py-6 px-4 flex justify-center bg-gray-100">
        {co && (
          <div
            ref={printRef}
            className="bg-white w-full max-w-[794px] shadow-lg print:shadow-none print:m-0 p-6"
            style={{ minHeight: "1123px" }}
          >
            <PrintableReturn ret={ret} company={co} mode="sale-return" className="print-visible" />
          </div>
        )}
      </div>
    </div>
  );
}

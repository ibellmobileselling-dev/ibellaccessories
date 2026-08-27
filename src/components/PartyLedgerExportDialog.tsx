import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/Field";
import { FileDown, Sheet, Loader2, Users } from "lucide-react";
import { toast } from "sonner";
import { buildPartyStatement } from "@/lib/ledger";
import { PrintablePartyStatement } from "@/components/PrintablePartyStatement";
import { partyStatementSheet, partySimpleLedgerSheet } from "@/lib/partySheet";
import { downloadXlsx } from "@/lib/xlsx";
import { elementsToPdfBlobs, downloadFile } from "@/lib/pdf";
import { fmtDate, ymd } from "@/lib/format";
import {
  SalesRepo,
  PurchaseRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  PaymentRepo,
  CompanyRepo,
} from "@/repositories";
import type { Party } from "@/types";

const monthStart = () => ymd(new Date(new Date().getFullYear(), new Date().getMonth(), 1));

/** Browsers throttle — and Chrome outright blocks — a burst of automatic
 * downloads from one gesture. A short gap between files keeps a 20-party
 * export from silently losing most of its files. */
const DOWNLOAD_GAP_MS = 350;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Download a ledger for one party, or for many at once.
 *
 * One FILE PER PARTY, deliberately — the client asked for separate ledgers
 * they can send to each customer individually, which a single multi-sheet
 * workbook can't be used for. (The Party Ledger *report* still produces the
 * combined one-sheet-per-party workbook, for internal review.)
 *
 * Numbers come from `buildPartyStatement` and the Excel layout from
 * `partyStatementSheet` — the same builders the on-screen statement page
 * uses, so a downloaded ledger can never disagree with what the party's own
 * page shows.
 */
export function PartyLedgerExportDialog({
  open,
  onOpenChange,
  parties,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  parties: Party[];
}) {
  // Empty = the FULL ledger. The client often wants everything, and being
  // forced to pick a range first (the old default of "this month") quietly
  // truncated the download to whatever month it happened to be.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [format, setFormat] = useState<"full" | "simple">("full");
  const [busy, setBusy] = useState<null | { kind: "excel" | "pdf"; done: number }>(null);

  useEffect(() => {
    if (open) {
      setBusy(null);
      setDateFrom("");
      setDateTo("");
      setFormat("full");
    }
  }, [open]);

  const wholeLedger = !dateFrom && !dateTo;
  const periodLabel = wholeLedger
    ? "All transactions"
    : `${dateFrom ? fmtDate(dateFrom) : "Beginning"} — ${dateTo ? fmtDate(dateTo) : "Today"}`;
  /** Filenames shouldn't clIBELL a range that wasn't applied. */
  const fileSuffix = wholeLedger ? "all" : `${dateFrom || "start"}-to-${dateTo || "today"}`;

  /** Statement rows for one party over the chosen window. */
  const rowsFor = (party: Party) =>
    buildPartyStatement(
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
    ).rows;

  /** Filenames must survive a file system: no slashes, colons or quotes. */
  const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").trim();

  const downloadExcel = async () => {
    if (!parties.length) return;
    setBusy({ kind: "excel", done: 0 });
    const company = CompanyRepo.get();
    try {
      for (let i = 0; i < parties.length; i++) {
        const p = parties[i];
        const sheet =
          format === "simple"
            ? partySimpleLedgerSheet(p, rowsFor(p), company, periodLabel)
            : partyStatementSheet(p, rowsFor(p), company, periodLabel);
        await downloadXlsx(`Statement-${safeName(p.name)}-${fileSuffix}`, [sheet]);
        setBusy({ kind: "excel", done: i + 1 });
        if (i < parties.length - 1) await pause(DOWNLOAD_GAP_MS);
      }
      toast.success(
        parties.length === 1
          ? `Ledger downloaded for ${parties[0].name}`
          : `${parties.length} ledgers downloaded`,
      );
      onOpenChange(false);
    } catch (err) {
      console.error("Ledger Excel export failed", err);
      toast.error("Could not build the Excel ledger — try a shorter date range");
    } finally {
      setBusy(null);
    }
  };

  const downloadPdf = async () => {
    if (!parties.length) return;
    setBusy({ kind: "pdf", done: 0 });
    const company = CompanyRepo.get();
    // The PDF service renders an element's markup, so every statement has to
    // exist in the DOM first. They mount off-screen (not display:none — a
    // hidden element has no layout, and the renderer needs real dimensions)
    // and are all torn down together in the finally below.
    const holder = document.createElement("div");
    holder.style.cssText = "position:fixed;left:-10000px;top:0;width:1280px;";
    document.body.appendChild(holder);
    const roots: ReturnType<typeof createRoot>[] = [];
    try {
      // Build every statement's markup FIRST, then render them all in one
      // go. Doing a request per party started a whole headless Chromium per
      // party, and that launch — not the drawing — is what made this feel
      // like it had frozen. The statement is styled entirely inline, so
      // selfContained also drops ~108 KB of app CSS from every document.
      // The full statement is nine columns wide and carries an item table
      // under each transaction, so it needs the same landscape page the
      // statement screen prints on; the simple ledger is six narrow columns
      // and belongs on portrait.
      const orientation: "portrait" | "landscape" = format === "simple" ? "portrait" : "landscape";
      const docs: {
        el: HTMLElement;
        orientation: "portrait" | "landscape";
        opts: { selfContained: true };
      }[] = [];
      for (const p of parties) {
        const slot = document.createElement("div");
        holder.appendChild(slot);
        const slotRoot = createRoot(slot);
        roots.push(slotRoot);
        flushSync(() => {
          slotRoot.render(
            <PrintablePartyStatement
              party={p}
              rows={rowsFor(p)}
              company={company}
              periodLabel={periodLabel}
              format={format}
            />,
          );
        });
        const el = slot.firstElementChild as HTMLElement | null;
        if (el) docs.push({ el, orientation, opts: { selfContained: true } });
      }

      const blobs = await elementsToPdfBlobs(docs, (done) =>
        setBusy({ kind: "pdf", done: Math.min(done, parties.length) }),
      );

      for (let i = 0; i < blobs.length; i++) {
        downloadFile(
          new File([blobs[i]], `Statement-${safeName(parties[i].name)}-${fileSuffix}.pdf`, {
            type: "application/pdf",
          }),
        );
        if (i < blobs.length - 1) await pause(DOWNLOAD_GAP_MS);
      }

      toast.success(
        parties.length === 1
          ? `Ledger PDF downloaded for ${parties[0].name}`
          : `${blobs.length} ledger PDFs downloaded`,
      );
      onOpenChange(false);
    } catch (err) {
      console.error("Ledger PDF export failed", err);
      toast.error("Could not build the PDF ledger — check your connection and try again");
    } finally {
      roots.forEach((r) => r.unmount());
      holder.remove();
      setBusy(null);
    }
  };

  const many = parties.length > 1;
  const lots = parties.length > 5;

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {many ? `Download ${parties.length} Ledgers` : `Download Ledger`}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-start gap-2 text-xs bg-muted/50 border rounded-md px-3 py-2.5">
            <Users className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
            <p className="text-muted-foreground">
              {many ? (
                <>
                  A <span className="font-semibold text-foreground">separate file per party</span> —{" "}
                  {parties
                    .slice(0, 3)
                    .map((p) => p.name)
                    .join(", ")}
                  {parties.length > 3 ? ` and ${parties.length - 3} more` : ""}.
                </>
              ) : (
                <span className="font-semibold text-foreground">{parties[0]?.name}</span>
              )}
            </p>
          </div>

          {/* Same two layouts the statement page offers. */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
              Ledger format
            </p>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  [
                    "full",
                    "Full Detail",
                    "Same 9-column statement as the party page, with item breakdown",
                  ],
                  ["simple", "Simple", "One line per transaction — Credit / Debit / Balance"],
                ] as const
              ).map(([key, title, desc]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFormat(key)}
                  className={`text-left rounded-md border p-2.5 transition ${
                    format === key
                      ? "border-primary bg-primary-soft"
                      : "border-input hover:bg-accent"
                  }`}
                >
                  <p className="text-[13px] font-semibold">{title}</p>
                  <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">{desc}</p>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Date range <span className="font-normal normal-case">(optional)</span>
              </p>
              {!wholeLedger && (
                <button
                  type="button"
                  onClick={() => {
                    setDateFrom("");
                    setDateTo("");
                  }}
                  className="text-[11px] text-primary hover:underline"
                >
                  Clear — full ledger
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="From"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
              <Field
                label="To"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              {wholeLedger
                ? "Leave both empty for the complete ledger — every transaction."
                : `Showing ${periodLabel}.`}
            </p>
          </div>

          {lots && !busy && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              {parties.length} separate files will be saved — your browser may ask you to allow
              multiple downloads.
            </p>
          )}
          {busy && many && (
            <p className="text-xs text-muted-foreground text-center">
              Preparing {busy.done + 1} of {parties.length}…
            </p>
          )}

          {/* Full-width stacked on a phone, side by side from sm: up. */}
          <div className="flex flex-col sm:flex-row gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={!!busy || !parties.length}
              onClick={downloadExcel}
            >
              {busy?.kind === "excel" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sheet className="h-4 w-4" />
              )}
              Excel
            </Button>
            <Button
              type="button"
              className="w-full"
              disabled={!!busy || !parties.length}
              onClick={downloadPdf}
            >
              {busy?.kind === "pdf" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileDown className="h-4 w-4" />
              )}
              PDF
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

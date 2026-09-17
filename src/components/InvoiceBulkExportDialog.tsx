/**
 * Download several bills as PDFs in one go, in a format chosen once.
 *
 * The shop tick a handful of invoices on the list, pick A4 / A4 two-up /
 * thermal, and get one file each. Modelled deliberately on the party-ledger
 * export next door, including the part that matters most: each bill travels
 * WITH its document, so a file can never be saved under another bill's
 * number. That export shipped without it and handed one customer another
 * customer's statement.
 */

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PrintableInvoice } from "@/components/PrintableInvoice";
import { ThermalReceipt } from "@/components/ThermalReceipt";
import { CompanyRepo } from "@/repositories";
import { elementsToPdfBlobs, downloadFile } from "@/lib/pdf";
import { toast } from "sonner";
import { Loader2, FileDown } from "lucide-react";
import type { Invoice, PrintFormat } from "@/types";

/** Browsers throttle a burst of downloads; a short gap keeps them all. */
const DOWNLOAD_GAP_MS = 350;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FORMATS: { key: PrintFormat; label: string; hint: string }[] = [
  { key: "a4", label: "A4", hint: "One bill per page — the usual printed invoice" },
  {
    key: "a4-2up",
    label: "A4 · 2 per page",
    hint: "Two copies side by side on one landscape sheet",
  },
  { key: "thermal80", label: "Thermal 80mm", hint: "Counter roll printer" },
  { key: "thermal58", label: "Thermal 58mm", hint: "Narrow counter roll" },
];

/** Filenames must survive a file system: no slashes, colons or quotes. */
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").trim();

export function InvoiceBulkExportDialog({
  open,
  onOpenChange,
  invoices,
  mode,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  invoices: Invoice[];
  mode: "sale" | "purchase";
}) {
  const [format, setFormat] = useState<PrintFormat>("a4");
  const [busy, setBusy] = useState<null | { done: number }>(null);

  useEffect(() => {
    if (open) {
      setBusy(null);
      setFormat(CompanyRepo.get()?.printFormat ?? "a4");
    }
  }, [open]);

  const download = async () => {
    if (!invoices.length) return;
    setBusy({ done: 0 });
    const company = CompanyRepo.get();

    /* The renderer works from an element's markup, so every bill has to exist
       in the DOM first. Off-screen rather than display:none — a hidden
       element has no layout, and the renderer needs real dimensions. */
    const holder = document.createElement("div");
    holder.style.cssText = "position:fixed;left:-10000px;top:0;width:1280px;";
    document.body.appendChild(holder);
    const roots: ReturnType<typeof createRoot>[] = [];

    try {
      const thermal = format === "thermal80" ? 80 : format === "thermal58" ? 58 : undefined;
      const orientation: "portrait" | "landscape" = format === "a4-2up" ? "landscape" : "portrait";

      const docs: { inv: Invoice; el: HTMLElement }[] = [];
      const missed: string[] = [];

      for (const inv of invoices) {
        const slot = document.createElement("div");
        holder.appendChild(slot);
        const slotRoot = createRoot(slot);
        roots.push(slotRoot);
        flushSync(() => {
          slotRoot.render(
            thermal && company ? (
              <div className="bg-white">
                <ThermalReceipt inv={inv} company={company} width={thermal} />
              </div>
            ) : (
              <PrintableInvoice inv={inv} company={company} mode={mode} />
            ),
          );
        });
        const el = slot.firstElementChild as HTMLElement | null;
        if (el) docs.push({ inv, el });
        else missed.push(inv.number);
      }

      const blobs = await elementsToPdfBlobs(
        docs.map(({ el }) => ({ el, orientation, pageWidthMm: thermal })),
        (done) => setBusy({ done: Math.min(done, docs.length) }),
      );

      for (let i = 0; i < blobs.length; i++) {
        // Named from the bill carried with the document, never from a second
        // list walked by the same index.
        downloadFile(
          new File([blobs[i]], `${safeName(docs[i].inv.number)}.pdf`, {
            type: "application/pdf",
          }),
        );
        if (i < blobs.length - 1) await pause(DOWNLOAD_GAP_MS);
      }

      if (missed.length) {
        toast.warning(
          `Could not build ${missed.length} of ${invoices.length}: ${missed.slice(0, 3).join(", ")}${
            missed.length > 3 ? "…" : ""
          }`,
          { duration: 10000 },
        );
      }
      toast.success(
        blobs.length === 1
          ? `Downloaded ${docs[0]?.inv.number}`
          : `${blobs.length} bills downloaded`,
      );
      onOpenChange(false);
    } catch (err) {
      console.error("Bulk invoice export failed", err);
      toast.error("Could not build the PDFs — check your connection and try again");
    } finally {
      roots.forEach((r) => r.unmount());
      holder.remove();
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {invoices.length === 1 ? "Download bill" : `Download ${invoices.length} bills`}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium">Format</p>
            <div className="space-y-1.5">
              {FORMATS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFormat(f.key)}
                  className={`w-full rounded-md border px-3 py-2 text-left transition ${
                    format === f.key
                      ? "border-primary bg-primary-soft"
                      : "border-border hover:border-primary/40"
                  }`}
                >
                  <span className="block text-sm font-semibold">{f.label}</span>
                  <span className="block text-xs text-muted-foreground">{f.hint}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Said before they press it, not discovered afterwards: a browser
              asked for thirty files in a row will start asking questions. */}
          {invoices.length > 5 && (
            <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              {invoices.length} separate files will be saved. Your browser may ask permission to
              download several at once.
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={!!busy}>
              Cancel
            </Button>
            <Button onClick={download} disabled={!!busy || !invoices.length}>
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {busy.done}/{invoices.length}
                </>
              ) : (
                <>
                  <FileDown className="h-4 w-4" />
                  Download
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

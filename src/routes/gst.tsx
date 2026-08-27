import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SalesRepo, PurchaseRepo, SaleReturnRepo, PurchaseReturnRepo } from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";
import type { Invoice, LineItem, Return } from "@/types";
import { fmtMoney, ymd } from "@/lib/format";
import { downloadElementAsPdf } from "@/lib/pdf";
import { downloadXlsx } from "@/lib/xlsx";
import { FileText, FileDown, Sheet } from "lucide-react";

export const Route = createFileRoute("/gst")({ component: GstPage });

type Bucket = { rate: number; taxable: number; tax: number };

const currentPeriod = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// Month-input strings ("2026-07") parsed as local dates, not UTC — matches
// the ymd() convention used everywhere else so the period boundaries never
// drift a day off around midnight IST.
const periodRange = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return { start: ymd(new Date(y, m - 1, 1)), end: ymd(new Date(y, m, 0)) };
};

const periodLabel = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
};

// A return nets against its own transaction type's buckets — a sale return
// reduces GSTR-1 output tax, a purchase return reduces GSTR-2 input tax.
// Netting here (rather than ignoring returns) keeps the payable figure
// correct for any period where returns land against an earlier period's bill.
function aggregate(docs: (Invoice | Return)[], sign: 1 | -1, map: Map<number, Bucket>) {
  for (const doc of docs) {
    if (doc.gstEnabled === false) continue;
    for (const l of doc.lineItems as LineItem[]) {
      const qty = l.qty ?? 0;
      const price = l.price ?? 0;
      const discountPct = l.discountPct ?? 0;
      const gstRate = l.gstRate ?? 0;
      const taxable = qty * price * (1 - discountPct / 100);
      const tax = taxable * (gstRate / 100);
      const cur = map.get(gstRate) ?? { rate: gstRate, taxable: 0, tax: 0 };
      cur.taxable += sign * taxable;
      cur.tax += sign * tax;
      map.set(gstRate, cur);
    }
  }
}

const inPeriod = <T extends { date: string }>(docs: T[], start: string, end: string) =>
  docs.filter((d) => d.date >= start && d.date <= end);

function bucketsFor(invoices: Invoice[], returns: Return[]): Bucket[] {
  const map = new Map<number, Bucket>();
  aggregate(invoices, 1, map);
  aggregate(returns, -1, map);
  return Array.from(map.values()).sort((a, b) => a.rate - b.rate);
}

function GstPage() {
  const _repoV = useRepoData();
  const [period, setPeriod] = useState(currentPeriod);
  const [sales, setSales] = useState<Invoice[]>([]);
  const [purchases, setPurchases] = useState<Invoice[]>([]);
  const [saleReturns, setSaleReturns] = useState<Return[]>([]);
  const [purchaseReturns, setPurchaseReturns] = useState<Return[]>([]);
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSales(SalesRepo.all());
    setPurchases(PurchaseRepo.all());
    setSaleReturns(SaleReturnRepo.all());
    setPurchaseReturns(PurchaseReturnRepo.all());
  }, [_repoV]);

  const { start, end } = periodRange(period);

  const gstr1 = useMemo(
    () => bucketsFor(inPeriod(sales, start, end), inPeriod(saleReturns, start, end)),
    [sales, saleReturns, start, end],
  );
  const gstr2 = useMemo(
    () => bucketsFor(inPeriod(purchases, start, end), inPeriod(purchaseReturns, start, end)),
    [purchases, purchaseReturns, start, end],
  );

  const outTotal = gstr1.reduce((s, r) => s + r.tax, 0);
  const inTotal = gstr2.reduce((s, r) => s + r.tax, 0);

  const handleDownloadPdf = async () => {
    if (!printRef.current) return;
    try {
      await downloadElementAsPdf(printRef.current, `GST-${period}`, "portrait");
      toast.success("GST summary downloaded as PDF");
    } catch {
      toast.error("Could not generate PDF");
    }
  };

  const handleDownloadExcel = () => {
    const sheetRows = (rows: Bucket[]) => [
      ["GST Rate", "Taxable Value", "CGST", "SGST", "Total Tax"],
      ...rows.map((r) => [`${r.rate}%`, r.taxable, r.tax / 2, r.tax / 2, r.tax]),
      ["Total", "", "", "", rows.reduce((s, r) => s + r.tax, 0)],
    ];
    downloadXlsx(`GST-${period}`, [
      { name: "GSTR-1 Sales", rows: sheetRows(gstr1) },
      { name: "GSTR-2 Purchase", rows: sheetRows(gstr2) },
    ]);
  };

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="GST"
        subtitle={`Output: ${fmtMoney(outTotal)} · Input: ${fmtMoney(inTotal)} · Payable: ${fmtMoney(outTotal - inTotal)}`}
        icon={<FileText className="h-5 w-5" />}
        actions={
          <>
            <input
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="h-8 border border-gray-200 rounded-md text-xs px-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
            <button
              onClick={handleDownloadExcel}
              className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition"
              title="Download GST summary as Excel"
            >
              <Sheet className="h-4 w-4" />
            </button>
            <button
              onClick={handleDownloadPdf}
              className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition"
              title="Download GST summary as PDF"
            >
              <FileDown className="h-4 w-4" />
            </button>
          </>
        }
      />
      <div ref={printRef} className="p-4 overflow-auto bg-white">
        <div className="mb-3 text-sm font-semibold text-gray-600">{periodLabel(period)}</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Section title="GSTR-1 (Sales / Outward)" rows={gstr1} />
          <Section title="GSTR-2 (Purchase / Inward)" rows={gstr2} />
        </div>
        <div className="mt-4 border rounded-md bg-card p-3 flex flex-wrap gap-6 text-sm">
          <div>
            <span className="text-muted-foreground">Output Tax: </span>
            <span className="font-semibold">{fmtMoney(outTotal)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Input Tax: </span>
            <span className="font-semibold">{fmtMoney(inTotal)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Net Payable: </span>
            <span className="font-semibold">{fmtMoney(outTotal - inTotal)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, rows }: { title: string; rows: Bucket[] }) {
  const total = rows.reduce((s, r) => s + r.tax, 0);
  return (
    <div className="border rounded-md bg-card">
      <div className="px-3 py-2 border-b font-semibold">{title}</div>
      {/* The mobile/desktop split below is screen-only — print must always
          show the real table regardless of the device it's triggered from,
          so this overrides both sides of the split back for @media print
          rather than trusting how a given browser resolves `md:` during an
          actual print render. */}
      <style>{`@media print {
        .gst-mobile-cards { display: none !important; }
        .gst-table { display: table !important; }
      }`}</style>
      {/* Mobile card list — a 5-column table is still tight on a phone;
          this is the same rate buckets as one card per GST rate instead. */}
      <div className="md:hidden gst-mobile-cards">
        {rows.length === 0 ? (
          <p className="text-center py-6 text-muted-foreground">No entries</p>
        ) : (
          <div className="divide-y">
            {rows.map((r) => (
              <div key={r.rate} className="p-3 flex items-center justify-between gap-3">
                <span className="font-medium">{r.rate}% GST</span>
                <div className="text-right text-xs text-muted-foreground">
                  <p>Taxable {fmtMoney(r.taxable)}</p>
                  <p>
                    CGST {fmtMoney(r.tax / 2)} · SGST {fmtMoney(r.tax / 2)}
                  </p>
                  <p className="font-semibold text-foreground">Tax {fmtMoney(r.tax)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="hidden md:block data-table gst-table">
        <table className="w-full text-[13px]">
          <thead>
            <tr>
              <th>GST Rate</th>
              <th style={{ textAlign: "right" }}>Taxable Value</th>
              <th style={{ textAlign: "right" }}>CGST</th>
              <th style={{ textAlign: "right" }}>SGST</th>
              <th style={{ textAlign: "right" }}>Total Tax</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center py-6 text-muted-foreground">
                  No entries
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.rate}>
                  <td>{r.rate}%</td>
                  <td className="text-right">{fmtMoney(r.taxable)}</td>
                  <td className="text-right">{fmtMoney(r.tax / 2)}</td>
                  <td className="text-right">{fmtMoney(r.tax / 2)}</td>
                  <td className="text-right">{fmtMoney(r.tax)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="border-t p-2 flex justify-between font-semibold text-sm">
        <span>Total Tax</span>
        <span>{fmtMoney(total)}</span>
      </div>
    </div>
  );
}

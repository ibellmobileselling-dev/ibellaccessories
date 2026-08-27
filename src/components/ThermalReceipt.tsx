import type { Invoice, Company } from "@/types";
import { fmtMoney, fmtDate } from "@/lib/format";
import { fmtMode } from "@/lib/paymentMode";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Thermal receipt for 80mm / 58mm roll printers (mobile & kirana shops).
 * Rendered with the `print-area` class so the global print CSS shows only
 * this element; the injected @page style switches the paper size.
 */
export function ThermalReceipt({
  inv,
  company,
  width,
}: {
  inv: Invoice;
  company: Company;
  width: 80 | 58;
}) {
  const gstOn = inv.gstEnabled !== false;
  const paperMm = width === 80 ? 72 : 48; // printable width inside the roll
  // The roll is wider than the printable content (a real physical margin
  // thermal paper has) — split that leftover evenly so it reads as a
  // centered receipt, not flush-left with all the slack dumped on the right.
  const sideMarginMm = (width - paperMm) / 2;
  const balance = r2(inv.total - inv.paid);
  const base: React.CSSProperties = {
    fontFamily: "'Courier New', monospace",
    color: "#000",
    fontSize: width === 80 ? 12 : 10.5,
    lineHeight: 1.35,
    width: `${paperMm}mm`,
  };
  const dashed = { borderTop: "1px dashed #000", margin: "6px 0" };
  const row = (label: string, value: string, bold = false): React.ReactNode => (
    <div style={{ display: "flex", justifyContent: "space-between", fontWeight: bold ? 700 : 400 }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );

  return (
    <div className="print-visible thermal-receipt" style={base}>
      {/* !important on both descriptors: src/styles.css sets a global
          @page { size: A4 } default for every other printable page, and
          without !important that can win the cascade over this dynamic
          size depending on browser-specific @page ordering — forcing it
          is the only way to guarantee the thermal width always applies.
          The 12mm padding on .print-visible (styles.css) is sized for a
          full A4 sheet — on an 80mm-wide, often-short receipt that's a
          disproportionate chunk of the page, especially vertically on a
          1-2 item bill. The extra selector specificity here (two classes
          beat one) shrinks it to something sane for a narrow roll.
          left/right: styles.css's base rule pins this to the page's left
          edge (left:0) with width staying at its own fixed `paperMm` (that
          inline width has no !important, but neither does the base rule's
          width:100%, so plain cascade/specificity — inline wins — keeps it
          at paperMm, never actually 100%) — leaving 100% of the roll's
          extra width as dead space on the right only. Centering it here
          instead splits that leftover evenly on both sides. */}
      <style>{`@media print {
        @page { size: ${width}mm auto !important; margin: 3mm !important; }
        .thermal-receipt.print-visible {
          padding: 3mm !important;
          left: ${sideMarginMm}mm !important;
          right: ${sideMarginMm}mm !important;
          width: ${paperMm}mm !important;
        }
      }`}</style>

      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: width === 80 ? 16 : 13, fontWeight: 800 }}>{company.name}</div>
        {company.address && <div>{company.address}</div>}
        {company.phone && <div>Ph: {company.phone}</div>}
        {gstOn && company.gstin && <div style={{ fontWeight: 700 }}>GSTIN: {company.gstin}</div>}
      </div>

      <div style={dashed} />
      <div style={{ textAlign: "center", fontWeight: 700 }}>
        {gstOn ? "TAX INVOICE" : "BILL / RECEIPT"}
      </div>
      {row("Bill No:", inv.number)}
      {row("Date:", fmtDate(inv.date))}
      {inv.partyName && row("Customer:", inv.partyName)}
      {inv.partyPhone && row("Phone:", inv.partyPhone)}

      <div style={dashed} />
      {inv.lineItems.map((l, i) => (
        <div key={l.id} style={{ marginBottom: 3 }}>
          <div style={{ fontWeight: 700 }}>
            {i + 1}. {l.name}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>
              {l.qty} {l.unit} × {fmtMoney(l.price)}
              {l.discountPct > 0 && ` −${l.discountPct}%`}
              {gstOn && l.gstRate > 0 && ` +GST${l.gstRate}%`}
            </span>
            <span style={{ fontWeight: 700 }}>{fmtMoney(l.amount)}</span>
          </div>
        </div>
      ))}

      <div style={dashed} />
      {row(
        "Subtotal",
        fmtMoney(
          r2(inv.lineItems.reduce((s, l) => s + l.qty * l.price * (1 - l.discountPct / 100), 0)),
        ),
      )}
      {inv.discount > 0 && row("Discount", `-${fmtMoney(inv.discount)}`)}
      {gstOn && inv.taxAmount > 0 && row("GST", fmtMoney(inv.taxAmount))}
      {!!inv.shippingCharge &&
        inv.shippingCharge > 0 &&
        row("Shipping", fmtMoney(inv.shippingCharge))}
      {!!inv.roundOff &&
        Math.abs(inv.roundOff) > 0.001 &&
        row("Round Off", `${inv.roundOff > 0 ? "+" : "−"}${fmtMoney(Math.abs(inv.roundOff))}`)}
      <div style={{ ...dashed }} />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontWeight: 800,
          fontSize: width === 80 ? 15 : 12.5,
        }}
      >
        <span>TOTAL</span>
        <span>{fmtMoney(inv.total)}</span>
      </div>
      {row("Paid", fmtMoney(inv.paid))}
      {balance > 0.009 && row("Balance Due", fmtMoney(balance), true)}
      {row("Mode", fmtMode(inv.paymentMode))}

      <div style={dashed} />
      <div style={{ textAlign: "center" }}>
        <div style={{ fontWeight: 700 }}>Thank you! Visit again 🙏</div>
        <div style={{ fontSize: width === 80 ? 10 : 9 }}>
          Goods once sold will not be taken back
        </div>
      </div>
    </div>
  );
}

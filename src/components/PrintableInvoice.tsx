import type { Invoice, Company } from "@/types";
import { fmtMoney, fmtDate } from "@/lib/format";
import { fmtMode } from "@/lib/paymentMode";
import { serialTextIndex } from "@/lib/serials";
import { PrintedSerials } from "@/components/PrintedSerials";

interface Props {
  inv: Invoice;
  company: Company;
  mode: "sale" | "purchase";
  /** "print-area" (default) stays hidden until printed — used for the
   * always-mounted copy inside the create/edit form. Detail pages that show
   * this invoice on screen too should pass "print-visible" instead. */
  className?: string;
  /** Shrinks every font-size/padding/column-width proportionally — used to
   * fit two copies side by side on one landscape page. Deliberately NOT done
   * via CSS `zoom`: Chrome computes print page-breaks from the pre-zoom
   * layout size, so a zoomed block can get cut off mid-page even though it
   * visually looks like it fits — real layout-level scaling avoids that. */
  scale?: number;
}

// Number to words (Indian) - simple version
function numToWords(n: number): string {
  const a = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const inWords = (num: number): string => {
    if (num < 20) return a[num];
    if (num < 100) return b[Math.floor(num / 10)] + (num % 10 ? " " + a[num % 10] : "");
    if (num < 1000)
      return a[Math.floor(num / 100)] + " Hundred" + (num % 100 ? " " + inWords(num % 100) : "");
    if (num < 100000)
      return (
        inWords(Math.floor(num / 1000)) +
        " Thousand" +
        (num % 1000 ? " " + inWords(num % 1000) : "")
      );
    if (num < 10000000)
      return (
        inWords(Math.floor(num / 100000)) +
        " Lakh" +
        (num % 100000 ? " " + inWords(num % 100000) : "")
      );
    return (
      inWords(Math.floor(num / 10000000)) +
      " Crore" +
      (num % 10000000 ? " " + inWords(num % 10000000) : "")
    );
  };
  const rupees = Math.floor(n);
  const paise = Math.round((n - rupees) * 100);
  let s = inWords(rupees) + " Rupees";
  if (paise) s += " and " + inWords(paise) + " Paise";
  return s + " Only";
}

export function PrintableInvoice({
  inv,
  company,
  mode,
  className = "print-area",
  scale = 1,
}: Props) {
  const gstOn = inv.gstEnabled !== false;
  // One pass over the units for the whole document — see serialTextIndex.
  const serialIndex = serialTextIndex();
  const showDisc = inv.lineItems.some((l) => (l.discountPct ?? 0) > 0);

  // The line table has optional columns (Disc%, and GST%/GST Amt), so the
  // blank filler rows and the Item Total row MUST derive their cell counts
  // from the same flags as the header. Hard-coded counts are how the table
  // ended up with a phantom empty column hanging off the right edge.
  //   # · Item · Qty · Unit · Price · [Disc%] · [GST%] · [GST Amt] · Amount
  const colCount = 6 + (showDisc ? 1 : 0) + (gstOn ? 2 : 0);
  // Item Total: "Item Total" spans # + Item, then Qty is shown, then this
  // spacer covers everything up to (but not including) GST Amt / Amount.
  const totalSpacerSpan = 2 + (showDisc ? 1 : 0) + (gstOn ? 1 : 0);
  const isSale = mode === "sale";
  const title = gstOn ? "TAX INVOICE" : isSale ? "INVOICE / BILL OF SUPPLY" : "PURCHASE BILL";

  // Aggregate GST by rate for summary
  const gstBuckets: Record<string, { taxable: number; tax: number }> = {};
  let taxableTotal = 0;
  // Sum of the printed "Amount" column (taxable + GST per line) — must match
  // the line-items table footer exactly, since that footer is not the same
  // figure as the Grand Total below (which also applies Extra Discount/Round Off).
  let lineAmountTotal = 0;
  inv.lineItems.forEach((l) => {
    const taxable = l.qty * l.price * (1 - l.discountPct / 100);
    taxableTotal += taxable;
    const gstAmt = gstOn ? taxable * (l.gstRate / 100) : 0;
    lineAmountTotal += taxable + gstAmt;
    if (gstOn) {
      const key = l.gstRate.toString();
      if (!gstBuckets[key]) gstBuckets[key] = { taxable: 0, tax: 0 };
      gstBuckets[key].taxable += taxable;
      gstBuckets[key].tax += taxable * (l.gstRate / 100);
    }
  });

  const totalQty = inv.lineItems.reduce((s, l) => s + l.qty, 0);

  // Every font-size / padding / column-width number below goes through this,
  // so `scale` genuinely shrinks the rendered layout instead of just the
  // visual appearance.
  const s = (n: number) => Math.round(n * scale * 10) / 10;

  const cellStyle: React.CSSProperties = {
    border: "1px solid #000",
    padding: `${s(6)}px ${s(8)}px`,
    fontSize: s(11),
  };
  const th: React.CSSProperties = {
    ...cellStyle,
    background: "#f0f0f0",
    fontWeight: 700,
    textAlign: "left",
  };

  return (
    <div className={className} style={{ fontFamily: "Arial, sans-serif", color: "#000" }}>
      {/* Header */}
      <div
        style={{
          textAlign: "center",
          borderBottom: "2px solid #000",
          paddingBottom: s(8),
          marginBottom: s(8),
        }}
      >
        <div style={{ fontSize: s(10), fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: s(20), fontWeight: 800, marginTop: s(2) }}>
          {company.name || "Your Company"}
        </div>
        {company.address && <div style={{ fontSize: s(11) }}>{company.address}</div>}
        <div style={{ fontSize: s(11) }}>
          {company.phone && <>Phone: {company.phone}</>}
          {company.phone && company.email && " · "}
          {company.email && <>Email: {company.email}</>}
        </div>
        {gstOn && company.gstin && (
          <div style={{ fontSize: s(11), fontWeight: 600 }}>GSTIN: {company.gstin}</div>
        )}
      </div>

      {/* Party + Invoice meta */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: s(8) }}>
        <tbody>
          <tr>
            <td style={{ ...cellStyle, verticalAlign: "top" }}>
              <div style={{ fontSize: s(10), color: "#555", fontWeight: 600, marginBottom: s(3) }}>
                {isSale ? "BILL TO" : "SUPPLIER"}
              </div>
              <div style={{ fontSize: s(14), fontWeight: 700 }}>{inv.partyName || "—"}</div>
              {inv.partyPhone && <div>Phone: {inv.partyPhone}</div>}
            </td>
            <td style={{ ...cellStyle, width: "1%", whiteSpace: "nowrap", verticalAlign: "top" }}>
              <table style={{ width: "auto", fontSize: s(11) }}>
                <tbody>
                  <tr>
                    <td style={{ fontWeight: 600, paddingRight: s(6) }}>Invoice #:</td>
                    <td>{inv.number}</td>
                  </tr>
                  <tr>
                    <td style={{ fontWeight: 600 }}>Date:</td>
                    <td>{fmtDate(inv.date)}</td>
                  </tr>
                  <tr>
                    <td style={{ fontWeight: 600 }}>Payment:</td>
                    <td>{fmtMode(inv.paymentMode)}</td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Line items */}
      {/* Sale bills no longer collect a per-line discount (the whole-bill
          Extra Discount covers it), so printing a column of "0%" is just
          noise. Shown only when a line actually carries one — which keeps
          every older bill that DID use line discounts printing exactly as
          it always has. */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...th, width: s(28), textAlign: "center" }}>#</th>
            <th style={th}>Item</th>
            <th style={{ ...th, textAlign: "right", width: s(55) }}>Qty</th>
            <th style={{ ...th, width: s(45) }}>Unit</th>
            <th style={{ ...th, textAlign: "right", width: s(75) }}>Price</th>
            {showDisc && <th style={{ ...th, textAlign: "right", width: s(55) }}>Disc%</th>}
            {gstOn && <th style={{ ...th, textAlign: "right", width: s(55) }}>GST%</th>}
            {gstOn && <th style={{ ...th, textAlign: "right", width: s(75) }}>GST Amt</th>}
            <th style={{ ...th, textAlign: "right", width: s(90) }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {inv.lineItems.map((l, i) => {
            const taxable = l.qty * l.price * (1 - l.discountPct / 100);
            const gstAmt = gstOn ? taxable * (l.gstRate / 100) : 0;
            return (
              <tr key={l.id}>
                <td style={{ ...cellStyle, textAlign: "center" }}>{i + 1}</td>
                <td style={cellStyle}>
                  {l.name}
                  <PrintedSerials line={l} index={serialIndex} />
                </td>
                <td style={{ ...cellStyle, textAlign: "right" }}>{l.qty}</td>
                <td style={cellStyle}>{l.unit}</td>
                <td style={{ ...cellStyle, textAlign: "right" }}>{fmtMoney(l.price)}</td>
                {showDisc && <td style={{ ...cellStyle, textAlign: "right" }}>{l.discountPct}%</td>}
                {gstOn && <td style={{ ...cellStyle, textAlign: "right" }}>{l.gstRate}%</td>}
                {gstOn && <td style={{ ...cellStyle, textAlign: "right" }}>{fmtMoney(gstAmt)}</td>}
                <td style={{ ...cellStyle, textAlign: "right", fontWeight: 600 }}>
                  {fmtMoney(taxable + gstAmt)}
                </td>
              </tr>
            );
          })}
          {/* filler */}
          {inv.lineItems.length < 6 &&
            Array.from({ length: 6 - inv.lineItems.length }).map((_, i) => (
              <tr key={"e" + i}>
                {Array.from({ length: colCount }).map((__, c) => (
                  <td key={c} style={c === 0 ? { ...cellStyle, height: s(20) } : cellStyle}>
                    {c === 0 ? " " : ""}
                  </td>
                ))}
              </tr>
            ))}
          <tr>
            <td style={{ ...cellStyle, fontWeight: 700 }} colSpan={2}>
              Item Total
            </td>
            <td style={{ ...cellStyle, textAlign: "right", fontWeight: 700 }}>{totalQty}</td>
            <td style={cellStyle} colSpan={totalSpacerSpan}></td>
            {gstOn && (
              <td style={{ ...cellStyle, textAlign: "right", fontWeight: 700 }}>
                {fmtMoney(Object.values(gstBuckets).reduce((s, b) => s + b.tax, 0))}
              </td>
            )}
            <td style={{ ...cellStyle, textAlign: "right", fontWeight: 700 }}>
              {fmtMoney(lineAmountTotal)}
            </td>
          </tr>
        </tbody>
      </table>

      {/* Totals + tax summary */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: s(8) }}>
        <tbody>
          <tr>
            <td style={{ ...cellStyle, width: "58%", verticalAlign: "top" }}>
              <div style={{ fontSize: s(10), fontWeight: 700, marginBottom: s(4) }}>
                Amount in Words
              </div>
              <div style={{ fontSize: s(11), fontStyle: "italic" }}>{numToWords(inv.total)}</div>
              {inv.notes && (
                <>
                  <div
                    style={{
                      fontSize: s(10),
                      fontWeight: 700,
                      marginTop: s(8),
                      marginBottom: s(3),
                    }}
                  >
                    Notes
                  </div>
                  <div style={{ fontSize: s(11) }}>{inv.notes}</div>
                </>
              )}
              {gstOn && Object.keys(gstBuckets).length > 0 && (
                <div style={{ marginTop: s(8) }}>
                  <div style={{ fontSize: s(10), fontWeight: 700, marginBottom: s(3) }}>
                    Tax Summary
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: s(10) }}>
                    <thead>
                      <tr>
                        <th style={th}>GST %</th>
                        <th style={{ ...th, textAlign: "right" }}>Taxable</th>
                        <th style={{ ...th, textAlign: "right" }}>CGST</th>
                        <th style={{ ...th, textAlign: "right" }}>SGST</th>
                        <th style={{ ...th, textAlign: "right" }}>Total Tax</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(gstBuckets).map(([rate, v]) => (
                        <tr key={rate}>
                          <td style={cellStyle}>{rate}%</td>
                          <td style={{ ...cellStyle, textAlign: "right" }}>
                            {fmtMoney(v.taxable)}
                          </td>
                          <td style={{ ...cellStyle, textAlign: "right" }}>
                            {fmtMoney(v.tax / 2)}
                          </td>
                          <td style={{ ...cellStyle, textAlign: "right" }}>
                            {fmtMoney(v.tax / 2)}
                          </td>
                          <td style={{ ...cellStyle, textAlign: "right" }}>{fmtMoney(v.tax)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </td>
            <td style={{ ...cellStyle, verticalAlign: "top", padding: 0 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: s(12) }}>
                <tbody>
                  <tr>
                    <td style={{ padding: `${s(5)}px ${s(8)}px` }}>Subtotal</td>
                    <td style={{ padding: `${s(5)}px ${s(8)}px`, textAlign: "right" }}>
                      {fmtMoney(taxableTotal)}
                    </td>
                  </tr>
                  {inv.discount > 0 && (
                    <tr>
                      <td style={{ padding: `${s(5)}px ${s(8)}px` }}>Discount</td>
                      <td style={{ padding: `${s(5)}px ${s(8)}px`, textAlign: "right" }}>
                        - {fmtMoney(inv.discount)}
                      </td>
                    </tr>
                  )}
                  {gstOn && (
                    <tr>
                      <td style={{ padding: `${s(5)}px ${s(8)}px` }}>Total GST</td>
                      <td style={{ padding: `${s(5)}px ${s(8)}px`, textAlign: "right" }}>
                        {fmtMoney(inv.taxAmount)}
                      </td>
                    </tr>
                  )}
                  {!!inv.shippingCharge && inv.shippingCharge > 0 && (
                    <tr>
                      <td style={{ padding: `${s(5)}px ${s(8)}px` }}>Shipping Charge</td>
                      <td style={{ padding: `${s(5)}px ${s(8)}px`, textAlign: "right" }}>
                        {fmtMoney(inv.shippingCharge)}
                      </td>
                    </tr>
                  )}
                  {!!inv.roundOff && Math.abs(inv.roundOff) > 0.001 && (
                    <tr>
                      <td style={{ padding: `${s(5)}px ${s(8)}px` }}>Round Off</td>
                      <td style={{ padding: `${s(5)}px ${s(8)}px`, textAlign: "right" }}>
                        {inv.roundOff > 0 ? "+" : "−"} {fmtMoney(Math.abs(inv.roundOff))}
                      </td>
                    </tr>
                  )}
                  <tr style={{ background: "#f0f0f0", fontWeight: 800, fontSize: s(14) }}>
                    <td style={{ padding: s(8), borderTop: "2px solid #000" }}>Grand Total</td>
                    <td style={{ padding: s(8), textAlign: "right", borderTop: "2px solid #000" }}>
                      {fmtMoney(inv.total)}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: `${s(5)}px ${s(8)}px` }}>Paid</td>
                    <td style={{ padding: `${s(5)}px ${s(8)}px`, textAlign: "right" }}>
                      {fmtMoney(inv.paid)}
                    </td>
                  </tr>
                  <tr style={{ fontWeight: 700 }}>
                    <td style={{ padding: `${s(5)}px ${s(8)}px`, borderTop: "1px solid #000" }}>
                      Balance {inv.total - inv.paid > 0 ? "Due" : "Paid"}
                    </td>
                    <td
                      style={{
                        padding: `${s(5)}px ${s(8)}px`,
                        textAlign: "right",
                        borderTop: "1px solid #000",
                      }}
                    >
                      {fmtMoney(Math.abs(inv.total - inv.paid))}
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Footer */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: s(20) }}>
        <tbody>
          <tr>
            <td
              style={{
                width: "50%",
                fontSize: s(10),
                verticalAlign: "top",
                paddingRight: s(12),
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: s(4) }}>Terms &amp; Conditions</div>
              <div>1. Goods once sold will not be taken back.</div>
              <div>2. Interest @18% p.a. will be charged on delayed payments.</div>
              <div>3. Subject to local jurisdiction.</div>
            </td>
            <td
              style={{
                width: "50%",
                textAlign: "right",
                verticalAlign: "bottom",
                paddingTop: s(40),
              }}
            >
              <div
                style={{
                  borderTop: "1px solid #000",
                  display: "inline-block",
                  paddingTop: s(4),
                  minWidth: s(200),
                  fontSize: s(11),
                  fontWeight: 600,
                }}
              >
                For {company.name || "Company"}
                <br />
                <span style={{ fontWeight: 400, fontSize: s(10) }}>Authorised Signatory</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

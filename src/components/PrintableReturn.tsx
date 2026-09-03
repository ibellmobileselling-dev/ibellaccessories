import type { Return, Company } from "@/types";
import { fmtMoney, fmtDate } from "@/lib/format";
import { serialTextIndex } from "@/lib/serials";
import { PrintedSerials } from "@/components/PrintedSerials";

interface Props {
  ret: Return;
  company: Company;
  mode: "sale-return" | "purchase-return";
  /** "print-area" (default) stays hidden until printed. Detail pages that
   * show this document on screen too should pass "print-visible" instead. */
  className?: string;
}

/** Black-and-white credit/debit note, matching PrintableInvoice's layout so
 * every document type in the app prints the same professional way. */
export function PrintableReturn({ ret, company, mode, className = "print-area" }: Props) {
  const isSaleReturn = mode === "sale-return";
  const gstOn = ret.gstEnabled !== false;
  // One pass over the units for the whole document — see serialTextIndex.
  const serialIndex = serialTextIndex();
  const title = isSaleReturn ? "CREDIT NOTE" : "DEBIT NOTE";

  const gstBuckets: Record<string, { taxable: number; tax: number }> = {};
  let taxableTotal = 0;
  let lineAmountTotal = 0;
  ret.lineItems.forEach((l) => {
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
  const totalQty = ret.lineItems.reduce((s, l) => s + l.qty, 0);

  const cellStyle: React.CSSProperties = {
    border: "1px solid #000",
    padding: "6px 8px",
    fontSize: 11,
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
          paddingBottom: 8,
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 10, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 20, fontWeight: 800, marginTop: 2 }}>
          {company.name || "Your Company"}
        </div>
        {company.address && <div style={{ fontSize: 11 }}>{company.address}</div>}
        <div style={{ fontSize: 11 }}>
          {company.phone && <>Phone: {company.phone}</>}
          {company.phone && company.email && " · "}
          {company.email && <>Email: {company.email}</>}
        </div>
        {gstOn && company.gstin && (
          <div style={{ fontSize: 11, fontWeight: 600 }}>GSTIN: {company.gstin}</div>
        )}
      </div>

      {/* Party + note meta */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 8 }}>
        <tbody>
          <tr>
            <td style={{ ...cellStyle, width: "60%", verticalAlign: "top" }}>
              <div style={{ fontSize: 10, color: "#555", fontWeight: 600, marginBottom: 3 }}>
                {isSaleReturn ? "RETURN FROM (CUSTOMER)" : "RETURN TO (SUPPLIER)"}
              </div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{ret.partyName || "—"}</div>
              {ret.partyPhone && <div>Phone: {ret.partyPhone}</div>}
            </td>
            <td style={{ ...cellStyle, verticalAlign: "top" }}>
              <table style={{ width: "100%", fontSize: 11 }}>
                <tbody>
                  <tr>
                    <td style={{ fontWeight: 600, paddingRight: 6 }}>
                      {isSaleReturn ? "Credit Note #:" : "Debit Note #:"}
                    </td>
                    <td>{ret.number}</td>
                  </tr>
                  <tr>
                    <td style={{ fontWeight: 600 }}>Date:</td>
                    <td>{fmtDate(ret.date)}</td>
                  </tr>
                  {ret.originalRef && (
                    <tr>
                      <td style={{ fontWeight: 600 }}>Against:</td>
                      <td>{ret.originalRef}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Line items */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...th, width: 28, textAlign: "center" }}>#</th>
            <th style={th}>Item</th>
            <th style={{ ...th, textAlign: "right", width: 55 }}>Qty</th>
            <th style={{ ...th, width: 45 }}>Unit</th>
            <th style={{ ...th, textAlign: "right", width: 75 }}>Price</th>
            <th style={{ ...th, textAlign: "right", width: 55 }}>Disc%</th>
            {gstOn && <th style={{ ...th, textAlign: "right", width: 55 }}>GST%</th>}
            {gstOn && <th style={{ ...th, textAlign: "right", width: 75 }}>GST Amt</th>}
            <th style={{ ...th, textAlign: "right", width: 90 }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {ret.lineItems.map((l, i) => {
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
                <td style={{ ...cellStyle, textAlign: "right" }}>{l.discountPct}%</td>
                {gstOn && <td style={{ ...cellStyle, textAlign: "right" }}>{l.gstRate}%</td>}
                {gstOn && <td style={{ ...cellStyle, textAlign: "right" }}>{fmtMoney(gstAmt)}</td>}
                <td style={{ ...cellStyle, textAlign: "right", fontWeight: 600 }}>
                  {fmtMoney(taxable + gstAmt)}
                </td>
              </tr>
            );
          })}
          {/* filler */}
          {ret.lineItems.length < 6 &&
            Array.from({ length: 6 - ret.lineItems.length }).map((_, i) => (
              <tr key={"e" + i}>
                <td style={{ ...cellStyle, height: 20 }}>&nbsp;</td>
                <td style={cellStyle}></td>
                <td style={cellStyle}></td>
                <td style={cellStyle}></td>
                <td style={cellStyle}></td>
                <td style={cellStyle}></td>
                {gstOn && <td style={cellStyle}></td>}
                {gstOn && <td style={cellStyle}></td>}
                <td style={cellStyle}></td>
              </tr>
            ))}
          <tr>
            <td style={{ ...cellStyle, fontWeight: 700 }} colSpan={2}>
              Item Total
            </td>
            <td style={{ ...cellStyle, textAlign: "right", fontWeight: 700 }}>{totalQty}</td>
            {/* Spans Unit + Price + Disc% (+ GST% when shown). The old
                fixed "2" left Disc% uncovered on a non-GST note, so the
                total row came up one cell short of the header. */}
            <td style={cellStyle} colSpan={gstOn ? 4 : 3}></td>
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

      {/* Tax summary + totals */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
        <tbody>
          <tr>
            <td style={{ ...cellStyle, width: "58%", verticalAlign: "top" }}>
              {gstOn && Object.keys(gstBuckets).length > 0 && (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 4 }}>Tax Summary</div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
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
              {ret.notes && (
                <>
                  <div style={{ fontSize: 10, fontWeight: 700, marginTop: 8, marginBottom: 3 }}>
                    Notes / Reason
                  </div>
                  <div style={{ fontSize: 11 }}>{ret.notes}</div>
                </>
              )}
            </td>
            <td style={{ ...cellStyle, verticalAlign: "top", padding: 0 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <tbody>
                  <tr>
                    <td style={{ padding: "5px 8px" }}>Subtotal</td>
                    <td style={{ padding: "5px 8px", textAlign: "right" }}>
                      {fmtMoney(taxableTotal)}
                    </td>
                  </tr>
                  {gstOn && (
                    <tr>
                      <td style={{ padding: "5px 8px" }}>Total GST</td>
                      <td style={{ padding: "5px 8px", textAlign: "right" }}>
                        {fmtMoney(ret.taxAmount)}
                      </td>
                    </tr>
                  )}
                  <tr style={{ background: "#f0f0f0", fontWeight: 800, fontSize: 14 }}>
                    <td style={{ padding: "8px", borderTop: "2px solid #000" }}>{title} Total</td>
                    <td style={{ padding: "8px", textAlign: "right", borderTop: "2px solid #000" }}>
                      {fmtMoney(ret.total)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Footer */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 20 }}>
        <tbody>
          <tr>
            <td style={{ width: "50%", fontSize: 10, verticalAlign: "bottom" }}>
              This is a computer-generated {isSaleReturn ? "credit" : "debit"} note.
            </td>
            <td
              style={{ width: "50%", textAlign: "right", verticalAlign: "bottom", paddingTop: 40 }}
            >
              <div
                style={{
                  borderTop: "1px solid #000",
                  display: "inline-block",
                  paddingTop: 4,
                  minWidth: 200,
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                For {company.name || "Company"}
                <br />
                <span style={{ fontWeight: 400, fontSize: 10 }}>Authorised Signatory</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

import { Fragment } from "react";
import { fmtMoney, fmtDate } from "@/lib/format";
import { buildSimpleLedgerRows, type PartyStatementRow } from "@/lib/ledger";
import type { Company, Party } from "@/types";

/**
 * A single party's statement, laid out for paper.
 *
 * Used by the bulk ledger export, which renders one of these per selected
 * party off-screen and turns each into its own PDF. It takes rows straight
 * from `buildPartyStatement` — the same function the on-screen statement
 * page uses — so the two can never disagree about the numbers, even though
 * the page has its own richer on-screen layout.
 */
export function PrintablePartyStatement({
  party,
  rows,
  company,
  periodLabel,
  format = "full",
}: {
  party: Party;
  rows: PartyStatementRow[];
  company: Company;
  periodLabel: string;
  /** Same two layouts the statement page offers, so a bulk download and a
   * single download produce the same document. */
  format?: "full" | "simple";
}) {
  const closing = rows.length ? rows[rows.length - 1].balance : 0;

  // Simple Ledger — one line per transaction, the layout people hand to a
  // customer or an accountant. Rows come from the shared builder, so this
  // and the statement page can't drift.
  if (format === "simple") {
    const simple = buildSimpleLedgerRows(rows);
    const creditTotal = simple.reduce((s, r) => s + r.credit, 0);
    const debitTotal = simple.reduce((s, r) => s + r.debit, 0);
    const sTh: React.CSSProperties = {
      padding: "5px 8px",
      borderBottom: "2px solid #000",
      fontSize: 11.5,
      fontWeight: 600,
      whiteSpace: "nowrap",
    };
    const sTd: React.CSSProperties = {
      padding: "4px 8px",
      borderBottom: "1px solid #e5e7eb",
      fontSize: 11.5,
      whiteSpace: "nowrap",
    };
    const sNum: React.CSSProperties = {
      ...sTd,
      textAlign: "right",
      fontVariantNumeric: "tabular-nums",
    };
    return (
      <div
        style={{
          background: "#fff",
          color: "#111",
          padding: 24,
          width: 900,
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 17, fontWeight: 800, textTransform: "uppercase" }}>
            {company.name}
          </div>
          <div style={{ fontSize: 11, color: "#555" }}>
            Ledger Of {party.name} · {periodLabel}
          </div>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["Date", "Particulars", "Quantity", "Credit", "Debit", "Balance"].map((h, i) => (
                <th key={h} style={{ ...sTh, textAlign: i >= 2 ? "right" : "left" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {simple.map((r, i) => (
              <tr key={i}>
                <td style={sTd}>{r.date ? fmtDate(r.date) : ""}</td>
                <td style={{ ...sTd, fontWeight: i === 0 ? 600 : 400 }}>{r.particulars}</td>
                <td style={sNum}>{r.qty}</td>
                <td style={sNum}>{r.credit ? fmtMoney(r.credit) : ""}</td>
                <td style={sNum}>{r.debit ? fmtMoney(r.debit) : ""}</td>
                <td style={{ ...sNum, fontWeight: 600 }}>{fmtMoney(Math.abs(r.balance))}</td>
              </tr>
            ))}
            <tr>
              <td style={{ ...sTd, fontWeight: 600 }} colSpan={2}>
                Closing Balance
              </td>
              <td style={sTd} />
              <td style={{ ...sNum, fontWeight: 600 }}>{closing > 0 ? fmtMoney(closing) : ""}</td>
              <td style={{ ...sNum, fontWeight: 600 }}>{closing < 0 ? fmtMoney(-closing) : ""}</td>
              <td style={sTd} />
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td style={{ ...sTd, borderTop: "2px solid #000" }} colSpan={3} />
              <td style={{ ...sNum, borderTop: "2px solid #000", fontWeight: 700 }}>
                {fmtMoney(creditTotal)}
              </td>
              <td style={{ ...sNum, borderTop: "2px solid #000", fontWeight: 700 }}>
                {fmtMoney(debitTotal)}
              </td>
              <td style={{ ...sTd, borderTop: "2px solid #000" }} />
            </tr>
          </tfoot>
        </table>
      </div>
    );
  }

  /* ── Full statement ────────────────────────────────────────────────────
     Deliberately the SAME nine columns and the same per-transaction item
     breakdown the statement page shows, because "download the ledger" has to
     mean one document however you got to it. The bulk export used to render
     a cut-down six-column version with no items at all, so selecting a few
     parties and downloading gave a visibly poorer file than opening each
     party and downloading from there — which is exactly what the client
     reported. Landscape, for the same reason the page prints landscape:
     nine columns do not fit across a portrait page.                        */
  const totalBilled = rows.reduce((s, r) => s + (r.total || 0), 0);
  const totalSettled = rows.reduce((s, r) => s + (r.receivedOrPaid || 0), 0);

  const th: React.CSSProperties = {
    padding: "6px 8px",
    borderBottom: "1.5px solid #111",
    fontSize: 10,
    fontWeight: 700,
    textAlign: "left",
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    color: "#6b7280",
    whiteSpace: "nowrap",
  };
  const thR: React.CSSProperties = { ...th, textAlign: "right" };
  const td: React.CSSProperties = {
    padding: "5px 8px",
    borderBottom: "1px solid #f0f1f3",
    fontSize: 11,
    whiteSpace: "nowrap",
  };
  const num: React.CSSProperties = {
    ...td,
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
  };
  // Sub-table styles for a transaction's item lines.
  const iTh: React.CSSProperties = {
    padding: "3px 7px",
    fontSize: 9,
    fontWeight: 700,
    textTransform: "uppercase",
    color: "#6b7280",
    background: "#f3f4f6",
    textAlign: "left",
    whiteSpace: "nowrap",
  };
  const iThR: React.CSSProperties = { ...iTh, textAlign: "right" };
  const iTd: React.CSSProperties = {
    padding: "3px 7px",
    fontSize: 10,
    borderTop: "1px solid #f0f1f3",
    whiteSpace: "nowrap",
  };
  const iNum: React.CSSProperties = {
    ...iTd,
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
  };

  return (
    <div
      style={{
        background: "#fff",
        color: "#111",
        padding: 24,
        width: 1240,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
        }}
      >
        <div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{company.name}</div>
          {company.address && <div style={{ fontSize: 11, color: "#555" }}>{company.address}</div>}
          {company.phone && <div style={{ fontSize: 11, color: "#555" }}>Ph: {company.phone}</div>}
          {company.gstin && (
            <div style={{ fontSize: 11, color: "#555" }}>GSTIN: {company.gstin}</div>
          )}
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>Party Statement</div>
          <div style={{ fontSize: 11, color: "#555" }}>{periodLabel}</div>
          <div style={{ fontSize: 11, color: "#555" }}>
            Generated {fmtDate(new Date().toISOString())}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14, padding: "8px 10px", background: "#f6f7f9", borderRadius: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{party.name}</div>
        <div style={{ fontSize: 11, color: "#555" }}>
          {party.phone ? `Ph: ${party.phone}` : "Ph: —"}
          {party.gstin ? ` · GSTIN: ${party.gstin}` : ""}
        </div>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
        <thead>
          <tr style={{ background: "#f9fafb" }}>
            <th style={{ ...th, width: 78 }}>Date</th>
            <th style={th}>Txn Type</th>
            <th style={th}>Ref No.</th>
            <th style={th}>Payment Status</th>
            <th style={{ ...thR, width: 96 }}>Total</th>
            <th style={{ ...thR, width: 108 }}>Received/Paid</th>
            <th style={{ ...thR, width: 100 }}>Txn Balance</th>
            <th style={{ ...thR, width: 118 }}>Receivable Balance</th>
            <th style={{ ...thR, width: 110 }}>Payable Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const itemSubtotal = r.items?.reduce((s, it) => s + it.amount, 0) ?? 0;
            const opening = r.type === "Beginning Balance" || r.type === "Balance b/f";
            return (
              <Fragment key={`${r.docId ?? r.type}-${i}`}>
                <tr
                  style={{
                    background: opening ? "#fafafa" : undefined,
                    fontWeight: opening ? 600 : undefined,
                    breakInside: "avoid",
                    breakAfter: r.items?.length ? "avoid" : undefined,
                  }}
                >
                  <td style={{ ...td, color: "#4b5563" }}>{r.date ? fmtDate(r.date) : ""}</td>
                  <td style={{ ...td, fontWeight: 500 }}>{r.type}</td>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace", color: "#1d4ed8" }}>
                    {r.ref}
                  </td>
                  <td style={td}>{r.status ?? ""}</td>
                  <td style={num}>{r.total ? fmtMoney(r.total) : "—"}</td>
                  <td style={{ ...num, color: "#047857" }}>
                    {r.receivedOrPaid ? fmtMoney(r.receivedOrPaid) : "—"}
                  </td>
                  <td style={{ ...num, color: "#be123c" }}>
                    {r.txnBalance ? fmtMoney(r.txnBalance) : "—"}
                  </td>
                  <td style={{ ...num, fontWeight: 600, color: "#be123c" }}>
                    {r.balance > 0 ? fmtMoney(r.balance) : "—"}
                  </td>
                  <td style={{ ...num, fontWeight: 600, color: "#b45309" }}>
                    {r.balance < 0 ? fmtMoney(-r.balance) : "—"}
                  </td>
                </tr>
                {!!r.items?.length && (
                  <tr style={{ background: "#fbfbfc", breakInside: "avoid", breakBefore: "avoid" }}>
                    <td colSpan={9} style={{ padding: "2px 10px 10px" }}>
                      <table
                        style={{
                          width: "100%",
                          borderCollapse: "collapse",
                          background: "#fff",
                          border: "1px solid #e5e7eb",
                          borderRadius: 4,
                        }}
                      >
                        <thead>
                          <tr>
                            <th style={{ ...iTh, width: 26 }}>#</th>
                            <th style={iTh}>Item name</th>
                            <th style={{ ...iThR, width: 70 }}>Quantity</th>
                            <th style={{ ...iThR, width: 90 }}>Price/Unit</th>
                            <th style={{ ...iThR, width: 90 }}>Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.items.map((it, j) => (
                            <tr key={j}>
                              <td style={{ ...iTd, color: "#9ca3af" }}>{j + 1}</td>
                              <td style={iTd}>{it.name}</td>
                              <td style={iNum}>{it.qty}</td>
                              <td style={iNum}>{fmtMoney(it.price)}</td>
                              <td style={iNum}>{fmtMoney(it.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr style={{ background: "#f9fafb", fontWeight: 600 }}>
                            <td
                              colSpan={4}
                              style={{
                                ...iTd,
                                textAlign: "right",
                                textTransform: "uppercase",
                                fontSize: 9,
                                color: "#6b7280",
                              }}
                            >
                              Sub Total
                            </td>
                            <td style={iNum}>{fmtMoney(itemSubtotal)}</td>
                          </tr>
                          {(r.charges ?? []).map((c, j) => (
                            <tr key={j} style={{ color: "#6b7280" }}>
                              <td
                                colSpan={4}
                                style={{
                                  ...iTd,
                                  textAlign: "right",
                                  textTransform: "uppercase",
                                  fontSize: 9,
                                }}
                              >
                                {c.label}
                              </td>
                              <td style={iNum}>
                                {c.amount < 0 ? `−${fmtMoney(-c.amount)}` : fmtMoney(c.amount)}
                              </td>
                            </tr>
                          ))}
                        </tfoot>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td style={{ ...td, textAlign: "center", color: "#777" }} colSpan={9}>
                No transactions in this period
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr style={{ background: "#f9fafb", fontWeight: 700 }}>
            <td style={{ ...td, borderTop: "1.5px solid #111" }} colSpan={4}>
              Total
            </td>
            <td style={{ ...num, borderTop: "1.5px solid #111" }}>{fmtMoney(totalBilled)}</td>
            <td style={{ ...num, borderTop: "1.5px solid #111" }}>{fmtMoney(totalSettled)}</td>
            <td style={{ ...td, borderTop: "1.5px solid #111" }} />
            <td style={{ ...num, borderTop: "1.5px solid #111", color: "#be123c" }}>
              {closing > 0 ? fmtMoney(closing) : "—"}
            </td>
            <td style={{ ...num, borderTop: "1.5px solid #111", color: "#b45309" }}>
              {closing < 0 ? fmtMoney(-closing) : "—"}
            </td>
          </tr>
        </tfoot>
      </table>

      <div style={{ marginTop: 14, fontSize: 12, fontWeight: 700 }}>
        Closing balance: {fmtMoney(Math.abs(closing))}{" "}
        <span style={{ fontWeight: 500, color: "#555" }}>
          {closing > 0.01 ? "(receivable)" : closing < -0.01 ? "(payable)" : "(settled)"}
        </span>
      </div>
    </div>
  );
}

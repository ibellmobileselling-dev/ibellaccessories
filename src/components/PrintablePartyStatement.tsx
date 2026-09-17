import { Fragment } from "react";
import { fmtMoney, fmtDate } from "@/lib/format";
import { buildSimpleLedgerRows, ledgerColumns, type PartyStatementRow } from "@/lib/ledger";
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
  /* Figures without the rupee sign. The headless browser that draws these
     PDFs carries no font with it, so every "₹" printed as a blank — a
     column headed "You Gave (₹)" came out as "You Gave ( )". The unit is
     said once in the heading instead. */
  const money = (n: number) => fmtMoney(n).replace("₹", "");

  const totalBilled = rows.reduce((s, r) => s + (r.total || 0), 0);
  const totalSettled = rows.reduce((s, r) => s + (r.receivedOrPaid || 0), 0);

  /* The two column totals, taken from the same movement the columns are.
     Adding up "sales" and "payments" by name instead would drift the moment
     a return or a write-off appeared, and a summary that disagrees with the
     rows beneath it is worse than no summary. */
  /* The balance this party started on. Without it the summary does not add
     up: a party whose whole balance is an opening figure showed Total Billed
     0, You Gave 0, You Got 0 — and then a closing balance of 5,100, with
     nothing on the page saying where it came from. */
  const opening =
    rows.length && (rows[0].type === "Beginning Balance" || rows[0].type === "Balance b/f")
      ? rows[0].balance
      : 0;

  let sumGave = 0;
  let sumGot = 0;
  rows.forEach((r, i) => {
    if (r.type === "Beginning Balance" || r.type === "Balance b/f") return;
    const d = r.balance - (i === 0 ? 0 : rows[i - 1].balance);
    if (d > 0.01) sumGave += d;
    else if (d < -0.01) sumGot += -d;
  });

  const th: React.CSSProperties = {
    padding: "9px 10px",
    background: "#f3f4f6",
    borderTop: "1px solid #d8dbdf",
    borderBottom: "1px solid #d8dbdf",
    fontSize: 9.5,
    fontWeight: 700,
    textAlign: "left",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "#4b5563",
    whiteSpace: "nowrap",
  };
  const thR: React.CSSProperties = { ...th, textAlign: "right" };
  const td: React.CSSProperties = {
    padding: "8px 10px",
    borderBottom: "1px solid #eceef1",
    fontSize: 11,
    lineHeight: 1.45,
    whiteSpace: "nowrap",
    verticalAlign: "top",
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
    padding: "2px 0",
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
        padding: 32,
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
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.01em" }}>
            {company.name}
          </div>
          {company.address && <div style={{ fontSize: 11, color: "#555" }}>{company.address}</div>}
          {company.phone && <div style={{ fontSize: 11, color: "#555" }}>Ph: {company.phone}</div>}
          {company.gstin && (
            <div style={{ fontSize: 11, color: "#555" }}>GSTIN: {company.gstin}</div>
          )}
        </div>
        <div style={{ textAlign: "right" }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 800,
              textTransform: "uppercase",
              letterSpacing: "0.14em",
              color: "#6b7280",
            }}
          >
            Party Statement
          </div>
          <div style={{ fontSize: 11, color: "#555" }}>{periodLabel}</div>
          <div style={{ fontSize: 11, color: "#555" }}>
            Generated {fmtDate(new Date().toISOString())}
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: 14,
          paddingTop: 14,
          borderTop: "2px solid #111",
        }}
      />

      <div style={{ marginTop: 0, padding: "10px 12px", background: "#f6f7f9", borderRadius: 6 }}>
        <div style={{ fontSize: 16, fontWeight: 800 }}>{party.name}</div>
        <div style={{ fontSize: 11, color: "#555" }}>
          {party.phone ? `Ph: ${party.phone}` : "Ph: —"}
          {party.gstin ? ` · GSTIN: ${party.gstin}` : ""}
        </div>
      </div>

      {/* What a shop wants before it reads a single row: how much went out,
          how much came back, and what is left. The statement page shows the
          same three figures as cards above its table; this is that, for
          paper. */}
      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        {[
          {
            label: "Opening Balance",
            value: money(Math.abs(opening)),
            color: "#374151",
            note: opening > 0.01 ? "they owed" : opening < -0.01 ? "you owed" : "nil",
          },
          { label: "You Gave", value: money(sumGave), color: "#e11d48", note: "billed to them" },
          { label: "You Got", value: money(sumGot), color: "#059669", note: "received back" },
          {
            label: "Closing Balance",
            value: money(Math.abs(closing)),
            color: closing < -0.01 ? "#b45309" : closing > 0.01 ? "#e11d48" : "#374151",
            note: closing > 0.01 ? "they owe you" : closing < -0.01 ? "you owe them" : "settled",
          },
        ].map((b) => (
          <div
            key={b.label}
            style={{
              flex: 1,
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              padding: "12px 14px",
              background: "#fcfcfd",
            }}
          >
            <div
              style={{
                fontSize: 8.5,
                fontWeight: 700,
                letterSpacing: "0.09em",
                textTransform: "uppercase",
                color: "#6b7280",
              }}
            >
              {b.label}
            </div>
            <div
              style={{
                marginTop: 5,
                fontSize: 19,
                fontWeight: 800,
                color: b.color,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {b.value}
            </div>
            {b.note && <div style={{ fontSize: 9, color: "#6b7280" }}>{b.note}</div>}
          </div>
        ))}
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
        <thead>
          <tr style={{ background: "#f9fafb" }}>
            <th style={{ ...th, width: 90 }}>Date</th>
            <th style={th}>Particulars</th>
            <th style={{ ...thR, width: 120 }}>You Gave</th>
            <th style={{ ...thR, width: 120 }}>You Got</th>
            <th style={{ ...thR, width: 130 }}>Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const prevBal = i === 0 ? 0 : rows[i - 1].balance;
            const delta = r.balance - prevBal;
            const opening = r.type === "Beginning Balance" || r.type === "Balance b/f";
            const items = r.items ?? [];
            const charges = r.charges ?? [];
            const one = items.length === 1 ? items[0] : null;
            const detail = opening
              ? ""
              : one
                ? `${one.name} · ${one.qty} × ${money(one.price)}`
                : items.length > 1
                  ? `${items.length} items`
                  : "";
            /* Which side the balance sits on, said only when it changes —
               the same rule the screen follows, so the two documents read
               identically. */
            const side = r.balance > 0.01 ? "they owe" : r.balance < -0.01 ? "you owe" : "settled";
            const prevSide =
              i === 0 ? "" : prevBal > 0.01 ? "they owe" : prevBal < -0.01 ? "you owe" : "settled";
            const showSide = i === 0 || side !== prevSide;
            /* A bill that already prints its item on the row needs no
               breakdown underneath; repeating it word for word is what the
               shop objected to, and on paper there is no fold to hide it. */
            const showBreakdown = items.length > 1 || charges.length > 0;
            const cols = opening ? { gave: 0, got: 0 } : ledgerColumns(r, delta);

            return (
              <Fragment key={i}>
                {showBreakdown && (
                  <tr style={{ pageBreakInside: "avoid", breakInside: "avoid" }}>
                    <td />
                    <td
                      colSpan={4}
                      style={{
                        ...td,
                        // The rule under this block would cut the items off
                        // from the total they add up to. The total row draws
                        // its own, and that one closes the whole entry.
                        borderBottom: "none",
                        padding: "7px 10px 2px 10px",
                        whiteSpace: "normal",
                        background: "#fbfcfd",
                      }}
                    >
                      <table
                        style={{
                          width: "100%",
                          borderCollapse: "collapse",
                          borderLeft: "2px solid #e5e7eb",
                        }}
                      >
                        <tbody>
                          {items.map((it, j) => (
                            <tr key={j}>
                              <td style={{ ...iTd, paddingLeft: 10, color: "#374151" }}>
                                {it.name}
                                <span style={{ marginLeft: 8, color: "#9ca3af" }}>
                                  {it.qty} × {money(it.price)}
                                </span>
                              </td>
                              <td style={{ ...iNum, width: 130, color: "#374151" }}>
                                {money(it.amount)}
                              </td>
                            </tr>
                          ))}
                          {charges.map((c, j) => (
                            <tr key={"c" + j}>
                              <td style={{ ...iTd, paddingLeft: 10, color: "#6b7280" }}>
                                {c.label}
                              </td>
                              <td style={{ ...iNum, width: 130, color: "#6b7280" }}>
                                {c.amount < 0 ? `−${money(-c.amount)}` : money(c.amount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}

                <tr
                  style={{
                    pageBreakInside: "avoid",
                    breakInside: "avoid",
                    ...(showBreakdown ? { pageBreakBefore: "avoid", breakBefore: "avoid" } : null),
                  }}
                >
                  <td style={{ ...td, color: "#6b7280" }}>{opening ? "" : fmtDate(r.date)}</td>
                  <td style={{ ...td, whiteSpace: "normal" }}>
                    {opening ? (
                      <span style={{ fontWeight: 700 }}>Opening Balance</span>
                    ) : (
                      <>
                        <span style={{ fontWeight: 700 }}>{r.type}</span>
                        {r.ref && r.ref !== "—" && (
                          <span style={{ marginLeft: 6, color: "#1d4ed8", fontSize: 10 }}>
                            {r.ref}
                          </span>
                        )}
                        {detail && (
                          <span style={{ marginLeft: 6, color: "#6b7280", fontSize: 10 }}>
                            · {detail}
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td style={{ ...num, color: "#e11d48", fontWeight: 600 }}>
                    {cols.gave > 0.01 ? money(cols.gave) : ""}
                  </td>
                  <td style={{ ...num, color: "#059669", fontWeight: 600 }}>
                    {cols.got > 0.01 ? money(cols.got) : ""}
                  </td>
                  <td style={{ ...num, fontWeight: 700 }}>
                    {money(Math.abs(r.balance))}
                    {showSide && (
                      <span
                        style={{ marginLeft: 5, fontSize: 9, fontWeight: 500, color: "#6b7280" }}
                      >
                        {side}
                      </span>
                    )}
                  </td>
                </tr>
              </Fragment>
            );
          })}

          {/* Never alone on a fresh page: a browser reprints the column
              headings whenever a table breaks, so a closing balance pushed
              over by itself arrives under a full set of headings with nothing
              above it. Refusing a break before it drags the last transaction
              across too. */}
          <tr
            style={{
              background: "#f9fafb",
              borderTop: "2px solid #d1d5db",
              pageBreakBefore: "avoid",
              breakBefore: "avoid",
              pageBreakInside: "avoid",
              breakInside: "avoid",
            }}
          >
            <td
              colSpan={3}
              style={{
                ...td,
                padding: "12px 10px",
                fontWeight: 800,
                fontSize: 11.5,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Closing Balance
              <span style={{ marginLeft: 6, fontWeight: 500, color: "#6b7280" }}>
                ·{" "}
                {closing > 0.01
                  ? "Total amount they owe you"
                  : closing < -0.01
                    ? "Total amount you owe them"
                    : "Nothing outstanding — fully settled"}
              </span>
            </td>
            <td colSpan={2} style={{ ...num, padding: "12px 10px", fontWeight: 800, fontSize: 15 }}>
              {money(Math.abs(closing))}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

import type { Company } from "@/types";
import type { PartyStatementRow } from "@/lib/ledger";
import type { XlsxSheet } from "@/lib/xlsx";
import { fmtDate } from "@/lib/format";
import { buildSimpleLedgerRows } from "@/lib/ledger";

const num = (n: number) => Math.round(n * 100) / 100;

/**
 * One party's statement as an Excel sheet — used both by the Party Ledger
 * report (one sheet per party) and the single-party Statement page download,
 * so the two always produce the identical format.
 *
 * Amounts go in as real NUMBERS (not "₹1,234" strings) so Excel right-aligns
 * them, sums them, and never shows them cut off as text.
 */
/**
 * Excel counterpart of the Simple Ledger — one line per transaction, the
 * same six columns as the printed version. Rows come from the shared
 * buildSimpleLedgerRows, so the spreadsheet and the PDF always agree.
 */
export function partySimpleLedgerSheet(
  party: { name: string; phone?: string; gstin?: string },
  rows: PartyStatementRow[],
  company: Company,
  periodLabel: string,
): XlsxSheet {
  const simple = buildSimpleLedgerRows(rows);
  const closing = rows.length ? rows[rows.length - 1].balance : 0;
  const num = (n: number) => Math.round(n * 100) / 100;

  const out: (string | number)[][] = [
    [company.name],
    [`Ledger Of ${party.name}`],
    [`Phone: ${party.phone || "—"}`],
    [`Period: ${periodLabel}`],
    [`Generated: ${fmtDate(new Date().toISOString())}`],
    [],
    ["Date", "Particulars", "Quantity", "Credit", "Debit", "Balance"],
  ];
  for (const r of simple) {
    out.push([
      r.date ? fmtDate(r.date) : "",
      r.particulars,
      r.qty,
      r.credit ? num(r.credit) : "",
      r.debit ? num(r.debit) : "",
      num(Math.abs(r.balance)),
    ]);
  }
  out.push([
    "",
    "Closing Balance",
    "",
    closing > 0 ? num(closing) : "",
    closing < 0 ? num(-closing) : "",
    "",
  ]);
  out.push([
    "",
    "Total",
    "",
    num(simple.reduce((s, r) => s + r.credit, 0)),
    num(simple.reduce((s, r) => s + r.debit, 0)),
    "",
  ]);
  return { name: party.name, rows: out };
}

export function partyStatementSheet(
  party: { name: string; phone?: string; gstin?: string },
  rows: PartyStatementRow[],
  company: Company,
  periodLabel: string,
): XlsxSheet {
  const closing = rows.length ? rows[rows.length - 1].balance : 0;

  const meta: (string | number)[][] = [
    ["Party Statement"],
    [`Company: ${company.name}`],
    [`Party: ${party.name}`],
    [`Phone: ${party.phone || "—"}`],
    [`GSTIN: ${party.gstin || "—"}`],
    [`Period: ${periodLabel}`],
    [`Generated: ${fmtDate(new Date().toISOString())}`],
    [],
  ];
  const header = [
    "Date",
    "Txn Type",
    "Ref No.",
    "Payment Status",
    "Total",
    "Received/Paid",
    "Txn Balance",
    "Receivable Balance",
    "Payable Balance",
  ];
  const body: (string | number)[][] = [];
  for (const r of rows) {
    body.push([
      r.date ? fmtDate(r.date) : "",
      r.type,
      r.ref,
      r.status || "",
      r.total ? num(r.total) : "",
      r.receivedOrPaid ? num(r.receivedOrPaid) : "",
      r.txnBalance ? num(r.txnBalance) : "",
      r.balance > 0 ? num(r.balance) : "",
      r.balance < 0 ? num(-r.balance) : "",
    ]);
    if (r.items?.length) {
      body.push(["", "#", "Item name", "", "Quantity", "Price/Unit", "Amount", "", ""]);
      r.items.forEach((it, i) => {
        body.push(["", i + 1, it.name, "", num(it.qty), num(it.price), num(it.amount), "", ""]);
      });
      const itemSubtotal = r.items.reduce((s, it) => s + it.amount, 0);
      body.push(["", "", "", "", "", "Sub Total", num(itemSubtotal), "", ""]);
      for (const c of r.charges ?? []) {
        body.push(["", "", "", "", "", c.label, num(c.amount), "", ""]);
      }
    }
  }
  const closingRow: (string | number)[] = [
    "",
    "",
    "Closing Balance",
    "",
    "",
    "",
    "",
    closing > 0 ? num(closing) : "",
    closing < 0 ? num(-closing) : "",
  ];
  return { name: party.name, rows: [...meta, header, ...body, [], closingRow] };
}

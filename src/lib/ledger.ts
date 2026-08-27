import type {
  Invoice,
  Payment,
  Return,
  Item,
  Expense,
  PaymentMode,
  CashAdjustment,
  BankTxn,
} from "@/types";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Sum of a payment's per-invoice allocations. Legacy payments (saved before
 * allocations existed) stored the linked invoice numbers in `ref` — if every
 * comma-separated token matches a known invoice number, the whole amount
 * was applied to invoices. */
export function allocatedAmount(p: Payment, invoiceNumbers?: Set<string>): number {
  if (p.allocations && p.allocations.length) {
    // Cash only — a settlement discount is not part of the money received,
    // so it must not reduce the advance calculation below.
    return r2(p.allocations.reduce((s, a) => s + a.amount, 0));
  }
  if (p.ref && invoiceNumbers) {
    const tokens = p.ref
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length && tokens.every((t) => invoiceNumbers.has(t))) return p.amount;
  }
  return 0;
}

/** Portion of a payment NOT applied to any invoice (an advance). */
export function advanceAmount(p: Payment, invoiceNumbers?: Set<string>): number {
  return Math.max(0, r2(p.amount - allocatedAmount(p, invoiceNumbers)));
}

/**
 * invoiceId → how much of that invoice was SETTLED through Payment records.
 *
 * Settled, not received: a settlement discount closes the remaining balance
 * without cash changing hands, so it counts here (the invoice really is
 * paid off) even though it never reaches a cash or bank position. Keeping
 * the two ideas in step is what stops `modeFlows`' direct-portion formula
 * (paid − applied) from inventing phantom cash on a discounted bill.
 */
export function paidViaPayments(payments: Payment[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const p of payments) {
    for (const a of p.allocations ?? []) {
      map.set(a.invoiceId, r2((map.get(a.invoiceId) ?? 0) + a.amount + (a.discount ?? 0)));
    }
  }
  return map;
}

/** Total written off across a set of payments — "Discount Allowed" on money
 * coming in, "Discount Received" on money going out. Real profit impact:
 * the sale was booked at full value, so the waived part has to come back off
 * the bottom line. */
export function totalSettlementDiscount(payments: Payment[]): number {
  return r2(
    payments.reduce(
      (s, p) => s + (p.allocations ?? []).reduce((x, a) => x + (a.discount ?? 0), 0),
      0,
    ),
  );
}

export interface PartyBalance {
  partyId: string;
  name: string;
  invoiced: number;
  returned: number;
  /** invoice.paid totals (initial paid + amounts applied via payments) */
  settled: number;
  /** payment amounts not applied to any invoice */
  advances: number;
  /** invoiced − returned − settled − advances (positive = they owe / we owe) */
  balance: number;
}

/** Per-party outstanding balances. Pass sales + sale returns + type "in"
 * payments for customers, or purchases + purchase returns + type "out"
 * payments for suppliers. Applied payments are already inside invoice.paid,
 * so only the advance portion of each payment is subtracted separately —
 * this is what keeps the dashboard and ledger reports in agreement.
 *
 * Pass the relevant parties so a party's openingBalance is folded into the
 * result — without this, a migrated party with a non-zero opening balance
 * but no transactions yet would be invisible here even though their own
 * statement page (parties_.$id.tsx) correctly shows what they owe.
 *
 * `side` prevents double counting: parties are type "both", so one opening
 * balance must not appear in BOTH the receivable and payable totals. Sign
 * convention: positive opening = the party owes us (counts on the customer
 * side only), negative = we owe them (counts on the supplier side only).
 * Omit `side` (statement page) to use the signed value as-is. */
/**
 * Spread one payment across open bills, oldest first.
 *
 * This is what "₹20,000 off the account" has to mean: the money clears the
 * bills that have been waiting longest, and only what is left over becomes an
 * advance. Anything else — newest first, or spread evenly — leaves old bills
 * open forever and makes an ageing report meaningless.
 *
 * Cash goes on a bill first, then the discount closes whatever that bill is
 * still short. Doing it per bill in the same pass is what makes the
 * shopkeeper's usual case work in one step: a 20,500 bill, 20,000 taken and
 * 500 written off closes exactly, with no arithmetic done by hand.
 *
 * `dues` MUST already be in oldest-first order — the caller owns that, since
 * only it knows the bill dates.
 */
export function spreadFifo(
  dues: number[],
  cash: number,
  discount: number,
): { apply: number; discount: number }[] {
  let cashLeft = Math.max(0, r2(cash));
  let discLeft = Math.max(0, r2(discount));
  return dues.map((rawDue) => {
    const due = Math.max(0, r2(rawDue));
    const apply = Math.min(cashLeft, due);
    cashLeft = r2(cashLeft - apply);
    const disc = Math.min(discLeft, r2(due - apply));
    discLeft = r2(discLeft - disc);
    return { apply: r2(apply), discount: r2(disc) };
  });
}

export function partyBalances(
  invoices: Invoice[],
  returns: Return[],
  payments: Payment[],
  parties: { id: string; name: string; openingBalance?: number }[] = [],
  side?: "customer" | "supplier",
): PartyBalance[] {
  const numbers = new Set(invoices.map((i) => i.number));
  const map = new Map<string, PartyBalance>();
  const entry = (id: string, name: string): PartyBalance => {
    let e = map.get(id);
    if (!e) {
      e = { partyId: id, name, invoiced: 0, returned: 0, settled: 0, advances: 0, balance: 0 };
      map.set(id, e);
    }
    return e;
  };
  for (const p of parties) {
    entry(p.id, p.name);
  }
  for (const inv of invoices) {
    const e = entry(inv.partyId, inv.partyName);
    e.invoiced = r2(e.invoiced + (inv.total || 0));
    e.settled = r2(e.settled + (inv.paid || 0));
  }
  for (const ret of returns) {
    const e = entry(ret.partyId, ret.partyName);
    e.returned = r2(e.returned + (ret.total || 0));
  }
  for (const p of payments) {
    const e = entry(p.partyId, p.partyName);
    e.advances = r2(e.advances + advanceAmount(p, numbers));
  }
  const openingById = new Map(parties.map((p) => [p.id, p.openingBalance ?? 0]));
  for (const e of map.values()) {
    const raw = openingById.get(e.partyId) ?? 0;
    const opening =
      side === "customer" ? Math.max(0, raw) : side === "supplier" ? Math.max(0, -raw) : raw;
    e.balance = r2(opening + e.invoiced - e.returned - e.settled - e.advances);
  }
  return Array.from(map.values());
}

export interface PartyNetPosition {
  partyId: string;
  name: string;
  /** Signed. Positive = they owe you (receivable). Negative = you owe them
   * (payable). Zero = square. */
  net: number;
}

/**
 * ONE net position per party — the single source of truth for Receivable and
 * Payable.
 *
 * Why this exists: `partyBalances(..., side)` computes the customer and
 * supplier sides as two INDEPENDENT sums, assigning the opening balance to
 * whichever side its sign implies. That is fine while a party only ever
 * trades one way, but it cannot NET. A party carrying a 9,850 payable
 * opening who is then sold 11,000 of goods came out as 9,850 payable AND
 * 11,000 receivable — the same party counted twice, on both sides of the
 * dashboard, when their real position is 1,150 receivable. The party's own
 * statement always showed 1,150, because it works from one signed running
 * balance; the dashboard disagreed with it.
 *
 * So: fold everything into one signed number per party, exactly as the
 * statement does, and only then decide which side it lands on. A party can
 * now appear in Receivable or Payable, never both.
 *
 * Sign convention matches Party.openingBalance and buildPartyStatement:
 * sales and purchase returns increase what they owe you; purchases, sale
 * returns and money you've received reduce it.
 */
export function netPartyPositions(
  parties: { id: string; name: string; openingBalance?: number }[],
  data: {
    sales: Invoice[];
    purchases: Invoice[];
    saleReturns: Return[];
    purchaseReturns: Return[];
    payments: Payment[];
  },
): PartyNetPosition[] {
  const map = new Map<string, PartyNetPosition>();
  const entry = (id: string, name: string) => {
    let e = map.get(id);
    if (!e) {
      e = { partyId: id, name, net: 0 };
      map.set(id, e);
    }
    return e;
  };
  for (const p of parties) entry(p.id, p.name).net = p.openingBalance ?? 0;

  const saleNumbers = new Set(data.sales.map((i) => i.number));
  const purchaseNumbers = new Set(data.purchases.map((i) => i.number));

  // They owe you more.
  for (const s of data.sales) entry(s.partyId, s.partyName).net += s.total || 0;
  for (const r of data.purchaseReturns) entry(r.partyId, r.partyName).net += r.total || 0;
  // They owe you less.
  for (const p of data.purchases) entry(p.partyId, p.partyName).net -= p.total || 0;
  for (const r of data.saleReturns) entry(r.partyId, r.partyName).net -= r.total || 0;

  // Money already settled ON a bill is inside invoice.paid; only the
  // unallocated (advance) part of a payment moves the balance separately —
  // the same rule partyBalances uses, so the two can't drift.
  for (const s of data.sales) entry(s.partyId, s.partyName).net -= s.paid || 0;
  for (const p of data.purchases) entry(p.partyId, p.partyName).net += p.paid || 0;
  for (const pay of data.payments) {
    const numbers = pay.type === "in" ? saleNumbers : purchaseNumbers;
    const advance = advanceAmount(pay, numbers);
    if (!advance) continue;
    entry(pay.partyId, pay.partyName).net += pay.type === "in" ? -advance : advance;
  }

  for (const e of map.values()) e.net = r2(e.net);
  return Array.from(map.values());
}

export interface FlowEntry {
  date: string;
  type: string;
  ref: string;
  in: number;
  out: number;
  /** The record behind this row.
   *
   * Cash in hand is DERIVED — a bill paid in cash, an expense, a payment, a
   * manual adjustment. Without knowing which, the Cash page can only show
   * numbers: it cannot open the bill a row came from, and it certainly
   * cannot let anyone edit a row, because "editing the cash" of a sale means
   * editing the sale. This says which record owns the row so each one can be
   * offered the action that is actually safe for it. */
  source?: { kind: "sale" | "purchase" | "expense" | "payment" | "adjustment"; id: string };
  /** For a manual cash entry: why it moved. See lib/cashPurpose.ts. */
  purpose?: string;
  /**
   * Cancelled, and shown only because the Cash page was asked to show
   * cancelled entries. Every total on that page skips these — a voided row
   * that still added to cash in hand would be worse than not showing it.
   */
  voided?: boolean;
}

/** Money movement for one payment mode (cash, bank, …). Amounts settled
 * later via Payment records count under the payment's own mode, not the
 * invoice's, so nothing is counted twice. */
export function modeFlows(
  mode: PaymentMode,
  sales: Invoice[],
  purchases: Invoice[],
  expenses: Expense[],
  payments: Payment[],
): FlowEntry[] {
  const applied = paidViaPayments(payments);
  const list: FlowEntry[] = [];
  for (const s of sales) {
    if (s.paymentMode !== mode) continue;
    // Already moved directly onto that specific bank account's balance (see
    // InvoiceForm.tsx) — counting it again here would double it on the Bank page.
    if (s.bankId) continue;
    const direct = Math.max(0, r2((s.paid || 0) - (applied.get(s.id) ?? 0)));
    if (direct > 0)
      list.push({
        date: s.date,
        type: "Sale",
        ref: `${s.number} — ${s.partyName}`,
        in: direct,
        out: 0,
        source: { kind: "sale", id: s.id },
      });
  }
  for (const s of purchases) {
    if (s.paymentMode !== mode) continue;
    if (s.bankId) continue;
    const direct = Math.max(0, r2((s.paid || 0) - (applied.get(s.id) ?? 0)));
    if (direct > 0)
      list.push({
        date: s.date,
        type: "Purchase",
        ref: `${s.number} — ${s.partyName}`,
        in: 0,
        out: direct,
        source: { kind: "purchase", id: s.id },
      });
  }
  for (const e of expenses) {
    if (e.paymentMode !== mode) continue;
    // Already moved directly onto that specific bank account's stored balance
    // (see expenses.tsx) — counting it again here would double-subtract it
    // from the Bank page / dashboard total, which add these flows on top of
    // the stored balances. Mirrors the sales/purchase/payment guards above.
    // A cash expense (no bankId) is NOT on any stored balance, so it stays.
    if (e.bankId) continue;
    list.push({
      date: e.date,
      type: "Expense",
      ref: e.category,
      in: 0,
      out: e.amount,
      source: { kind: "expense", id: e.id },
    });
  }
  for (const p of payments) {
    if (p.mode !== mode) continue;
    // A payment tied to a specific bank account already moved money on that
    // account's own `balance` field directly (see payments.tsx) — counting
    // it again here would double its effect on the Bank page's total.
    if (p.bankId) continue;
    list.push({
      date: p.date,
      type: p.type === "in" ? "Payment In" : "Payment Out",
      ref: p.partyName,
      in: p.type === "in" ? p.amount : 0,
      out: p.type === "out" ? p.amount : 0,
      source: { kind: "payment", id: p.id },
    });
  }
  list.sort((a, b) => b.date.localeCompare(a.date));
  return list;
}

export const netFlow = (entries: FlowEntry[]) => r2(entries.reduce((s, e) => s + e.in - e.out, 0));

/** Cash-mode flows plus manual cash adjustments (counter corrections, drawings). */
export function cashFlows(
  sales: Invoice[],
  purchases: Invoice[],
  expenses: Expense[],
  payments: Payment[],
  adjustments: CashAdjustment[],
): FlowEntry[] {
  const list = modeFlows("cash", sales, purchases, expenses, payments);
  for (const a of adjustments) {
    list.push({
      date: a.date,
      type: a.type === "add" ? "Cash Added" : "Cash Reduced",
      ref: a.reason || "Manual adjustment",
      in: a.type === "add" ? a.amount : 0,
      out: a.type === "reduce" ? a.amount : 0,
      source: { kind: "adjustment", id: a.id },
      purpose: a.purpose,
      voided: !!a.voidedAt,
    });
  }
  list.sort((a, b) => b.date.localeCompare(a.date));
  return list;
}

/** UPI and cheques settle into the bank — group them with bank-mode flows. */
export function bankFlows(
  sales: Invoice[],
  purchases: Invoice[],
  expenses: Expense[],
  payments: Payment[],
): FlowEntry[] {
  const modes: PaymentMode[] = ["bank", "upi", "cheque"];
  const list = modes.flatMap((m) => modeFlows(m, sales, purchases, expenses, payments));
  list.sort((a, b) => b.date.localeCompare(a.date));
  return list;
}

export interface PartyLedgerRow {
  date: string;
  created: string;
  type: string;
  ref: string;
  /** party owes more (sales, purchase returns, payments made to them) */
  debit: number;
  /** party owes less (payments received, sale returns, purchases from them) */
  credit: number;
  balance: number;
  /** underlying document id — makes the row clickable to open the bill */
  docId?: string;
  docKind?: "sale" | "purchase" | "sale-return" | "purchase-return";
}

/**
 * Full chronological ledger for one party — every sale, purchase, return and
 * payment that touches them, with a running balance (positive = party owes
 * us / receivable, negative = we owe them / payable). Pass the FULL,
 * unfiltered `payments` array (not just this party's) so `paidViaPayments`
 * can resolve invoice-linked allocations correctly.
 *
 * Shared by the per-party Statement page and the all-parties Ledger report
 * so both always agree on the numbers.
 */
export function buildPartyLedger(
  party: { id: string; openingBalance?: number },
  data: {
    sales: Invoice[];
    purchases: Invoice[];
    saleReturns: Return[];
    purchaseReturns: Return[];
    payments: Payment[];
  },
  dateFrom = "",
  dateTo = "",
): { rows: PartyLedgerRow[]; fullBalance: number; totalDebit: number; totalCredit: number } {
  const entries: Omit<PartyLedgerRow, "balance">[] = [];
  const applied = paidViaPayments(data.payments);

  for (const s of data.sales.filter((x) => x.partyId === party.id)) {
    entries.push({
      date: s.date,
      created: s.createdAt,
      type: "Sale",
      ref: s.number,
      debit: s.total,
      credit: 0,
      docId: s.id,
      docKind: "sale",
    });
    const atBilling = r2((s.paid || 0) - (applied.get(s.id) ?? 0));
    if (atBilling > 0) {
      entries.push({
        date: s.date,
        created: s.createdAt,
        type: "Received with bill",
        ref: s.number,
        debit: 0,
        credit: atBilling,
        docId: s.id,
        docKind: "sale",
      });
    }
  }
  for (const ret of data.saleReturns.filter((x) => x.partyId === party.id)) {
    entries.push({
      date: ret.date,
      created: ret.createdAt,
      type: "Sale Return",
      ref: ret.number,
      debit: 0,
      credit: ret.total,
      docId: ret.id,
      docKind: "sale-return",
    });
  }
  for (const p of data.purchases.filter((x) => x.partyId === party.id)) {
    entries.push({
      date: p.date,
      created: p.createdAt,
      type: "Purchase",
      ref: p.number,
      debit: 0,
      credit: p.total,
      docId: p.id,
      docKind: "purchase",
    });
    const atBilling = r2((p.paid || 0) - (applied.get(p.id) ?? 0));
    if (atBilling > 0) {
      entries.push({
        date: p.date,
        created: p.createdAt,
        type: "Paid with bill",
        ref: p.number,
        debit: atBilling,
        credit: 0,
        docId: p.id,
        docKind: "purchase",
      });
    }
  }
  for (const ret of data.purchaseReturns.filter((x) => x.partyId === party.id)) {
    entries.push({
      date: ret.date,
      created: ret.createdAt,
      type: "Purchase Return",
      ref: ret.number,
      debit: ret.total,
      credit: 0,
      docId: ret.id,
      docKind: "purchase-return",
    });
  }
  for (const pay of data.payments.filter((x) => x.partyId === party.id)) {
    const linked = pay.allocations?.map((a) => a.number).join(", ") ?? pay.ref ?? "";
    if (pay.type === "in") {
      entries.push({
        date: pay.date,
        created: pay.createdAt,
        type: "Payment Received",
        ref: linked || "—",
        debit: 0,
        credit: pay.amount,
      });
    } else {
      entries.push({
        date: pay.date,
        created: pay.createdAt,
        type: "Payment Made",
        ref: linked || "—",
        debit: pay.amount,
        credit: 0,
      });
    }
  }

  entries.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.created ?? "").localeCompare(b.created ?? ""),
  );

  // Current all-time balance, independent of any date filter
  const fullBalance = r2(
    entries.reduce((s, e) => s + e.debit - e.credit, party.openingBalance || 0),
  );

  let running = party.openingBalance || 0;
  const out: PartyLedgerRow[] = [];

  // Date window: transactions before "From" collapse into one
  // "Balance b/f" (brought forward) line, like a proper ledger
  const before = dateFrom ? entries.filter((e) => e.date < dateFrom) : [];
  const window = entries.filter(
    (e) => (!dateFrom || e.date >= dateFrom) && (!dateTo || e.date <= dateTo),
  );
  for (const e of before) {
    running = r2(running + e.debit - e.credit);
  }

  if (dateFrom) {
    out.push({
      date: "",
      created: "",
      type: "Balance b/f",
      ref: "—",
      debit: 0,
      credit: 0,
      balance: running,
    });
  } else if (party.openingBalance) {
    out.push({
      date: "",
      created: "",
      type: "Opening Balance",
      ref: "—",
      debit: party.openingBalance > 0 ? party.openingBalance : 0,
      credit: party.openingBalance < 0 ? -party.openingBalance : 0,
      balance: running,
    });
  }
  for (const e of window) {
    running = r2(running + e.debit - e.credit);
    out.push({ ...e, balance: running });
  }
  const totalDebit = r2(out.reduce((s, e) => s + e.debit, 0));
  const totalCredit = r2(out.reduce((s, e) => s + e.credit, 0));
  return { rows: out, fullBalance, totalDebit, totalCredit };
}

export interface StatementItem {
  name: string;
  qty: number;
  price: number;
  amount: number;
}

export interface StatementCharge {
  label: string;
  amount: number;
}

export interface PartyStatementRow {
  date: string;
  created: string;
  type: string;
  ref: string;
  status?: "Paid" | "Partial" | "Unpaid";
  /** Invoice/return total, or the advance amount for a standalone payment row */
  total: number;
  /** Amount collected/paid against this specific transaction (all-time, folds in later payments) */
  receivedOrPaid: number;
  /** total − receivedOrPaid — what's still outstanding on this one transaction */
  txnBalance: number;
  items?: StatementItem[];
  charges?: StatementCharge[];
  /** Running party balance after this row — positive = receivable, negative = payable */
  balance: number;
  docId?: string;
  docKind?: "sale" | "purchase" | "sale-return" | "purchase-return";
}

/**
 * Vyapar-style party statement — one row per transaction (not per debit/
 * credit event like buildPartyLedger), with the invoice's own line items and
 * a running Receivable/Payable balance. Built for the printed/exported
 * Party Statement, which needs to show "what was in this bill" alongside
 * the ledger, not just a flat debit/credit trail.
 *
 * A later Payment allocated to an invoice is folded into that invoice's own
 * `receivedOrPaid` (via invoice.paid) rather than getting its own row — only
 * the unallocated advance portion of a payment becomes a standalone row, so
 * nothing is ever counted twice.
 */
export function buildPartyStatement(
  party: { id: string; openingBalance?: number },
  data: {
    sales: Invoice[];
    purchases: Invoice[];
    saleReturns: Return[];
    purchaseReturns: Return[];
    payments: Payment[];
  },
  dateFrom = "",
  dateTo = "",
): { rows: PartyStatementRow[]; fullBalance: number } {
  type Entry = Omit<PartyStatementRow, "balance">;
  const entries: Entry[] = [];

  /* Money that reached a bill through a PAYMENT record, as opposed to cash
   * handed over at the counter when the bill was written.
   *
   * The two have to be told apart because they happen on different DAYS. A
   * bill's `paid` holds both, so crediting all of it against the bill's own
   * date put a payment taken three weeks later on the date of the sale — and
   * a payment that had been fully applied to bills produced no row of its own
   * at all, while one that happened to be an advance did. The same act of
   * taking money therefore appeared in two entirely different places in the
   * ledger depending on how it was applied, which is the "sometimes up,
   * sometimes at the bottom" the client reported.
   *
   * Splitting it costs nothing in accuracy: the bill keeps only what it took
   * on the day, each payment appears on the day it happened, and the closing
   * balance is identical either way — which the audit suite pins. */
  const viaPayments = paidViaPayments(data.payments);
  const directlyPaid = (inv: Invoice) =>
    Math.max(0, r2((inv.paid || 0) - (viaPayments.get(inv.id) ?? 0)));

  const itemsOf = (lineItems: { name: string; qty: number; price: number; amount: number }[]) =>
    lineItems.map((l) => ({ name: l.name, qty: l.qty, price: l.price, amount: l.amount }));

  const statusOf = (total: number, paid: number): "Paid" | "Partial" | "Unpaid" => {
    if (paid <= 0.001) return "Unpaid";
    return r2(total - paid) <= 0.01 ? "Paid" : "Partial";
  };

  for (const s of data.sales.filter((x) => x.partyId === party.id)) {
    const paid = directlyPaid(s);
    const charges: StatementCharge[] = [];
    if (s.shippingCharge) charges.push({ label: "Shipping Charge", amount: s.shippingCharge });
    if (s.discount) charges.push({ label: "Discount", amount: -s.discount });
    entries.push({
      date: s.date,
      created: s.createdAt,
      type: "Sale",
      ref: s.number,
      status: statusOf(s.total, paid),
      total: s.total,
      receivedOrPaid: paid,
      txnBalance: r2(s.total - paid),
      items: itemsOf(s.lineItems),
      charges,
      docId: s.id,
      docKind: "sale",
    });
  }
  for (const ret of data.saleReturns.filter((x) => x.partyId === party.id)) {
    entries.push({
      date: ret.date,
      created: ret.createdAt,
      type: "Sale Return",
      ref: ret.number,
      total: ret.total,
      receivedOrPaid: ret.total,
      txnBalance: 0,
      items: itemsOf(ret.lineItems),
      docId: ret.id,
      docKind: "sale-return",
    });
  }
  for (const p of data.purchases.filter((x) => x.partyId === party.id)) {
    const paid = directlyPaid(p);
    const charges: StatementCharge[] = [];
    if (p.discount) charges.push({ label: "Discount", amount: -p.discount });
    entries.push({
      date: p.date,
      created: p.createdAt,
      type: "Purchase",
      ref: p.number,
      status: statusOf(p.total, paid),
      total: p.total,
      receivedOrPaid: paid,
      txnBalance: r2(p.total - paid),
      items: itemsOf(p.lineItems),
      charges,
      docId: p.id,
      docKind: "purchase",
    });
  }
  for (const ret of data.purchaseReturns.filter((x) => x.partyId === party.id)) {
    entries.push({
      date: ret.date,
      created: ret.createdAt,
      type: "Purchase Return",
      ref: ret.number,
      total: ret.total,
      receivedOrPaid: ret.total,
      txnBalance: 0,
      items: itemsOf(ret.lineItems),
      docId: ret.id,
      docKind: "purchase-return",
    });
  }
  for (const pay of data.payments.filter((x) => x.partyId === party.id)) {
    const against = pay.allocations?.map((a) => a.number).join(", ") || pay.ref || "Advance";
    if (pay.amount > 0.001) {
      entries.push({
        date: pay.date,
        created: pay.createdAt,
        type: pay.type === "in" ? "Payment Received" : "Payment Made",
        ref: against,
        total: pay.amount,
        receivedOrPaid: pay.amount,
        txnBalance: 0,
      });
    }
    // A settlement discount closes a bill without the money ever arriving, so
    // it is its own line — folding it into the payment would report cash that
    // was never taken, and leaving it out would leave the bill looking open.
    const written = r2((pay.allocations ?? []).reduce((t, a) => t + (a.discount ?? 0), 0));
    if (written > 0.001) {
      entries.push({
        date: pay.date,
        created: pay.createdAt,
        type: pay.type === "in" ? "Discount Given" : "Discount Received",
        ref: against,
        total: written,
        receivedOrPaid: written,
        txnBalance: 0,
      });
    }
  }

  entries.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.created ?? "").localeCompare(b.created ?? ""),
  );

  // Net ledger effect of each row: sales/purchase-returns increase what the
  // party owes us; purchases/sale-returns/payments reduce it (or increase
  // what we owe them). `receivedOrPaid` on a sale/purchase already nets
  // against that same row's `total`, so nothing here is counted twice.
  const netOf = (e: Entry) => {
    if (e.docKind === "sale") return e.total - e.receivedOrPaid;
    if (e.docKind === "purchase") return -(e.total - e.receivedOrPaid);
    if (e.docKind === "sale-return") return -e.total;
    if (e.docKind === "purchase-return") return e.total;
    // Every payment and write-off is now its own dated row (see above), so
    // this arm carries all of them, not just a standalone advance.
    return e.type === "Payment Received" || e.type === "Discount Given" ? -e.total : e.total;
  };

  const fullBalance = r2(entries.reduce((s, e) => s + netOf(e), party.openingBalance || 0));

  let running = party.openingBalance || 0;
  const out: PartyStatementRow[] = [];

  const before = dateFrom ? entries.filter((e) => e.date < dateFrom) : [];
  const window = entries.filter(
    (e) => (!dateFrom || e.date >= dateFrom) && (!dateTo || e.date <= dateTo),
  );
  for (const e of before) running = r2(running + netOf(e));

  out.push({
    date: "",
    created: "",
    type: dateFrom ? "Balance b/f" : "Beginning Balance",
    ref: "—",
    total: 0,
    receivedOrPaid: 0,
    txnBalance: 0,
    balance: running,
  });
  for (const e of window) {
    running = r2(running + netOf(e));
    out.push({ ...e, balance: running });
  }
  return { rows: out, fullBalance };
}

export interface BankLedgerRow {
  date: string;
  created: string;
  type: string;
  ref: string;
  /** money leaving the account (payment out, purchase, withdrawal) */
  debit: number;
  /** money entering the account (payment in, sale, deposit) */
  credit: number;
  balance: number;
  docId?: string;
  docKind?: "sale" | "purchase";
}

/**
 * Full passbook-style ledger for one bank account — every sale/purchase
 * settled directly into it, every Payments-page in/out tied to it, every
 * bank-mode expense paid from it, and every manual deposit/withdrawal, with
 * a running balance. Standard passbook sign convention: Credit = money in,
 * Debit = money out (opposite of the party ledger's convention, where Debit
 * means the party owes more).
 */
export function buildBankLedger(
  bank: { id: string; openingBalance?: number },
  data: {
    sales: Invoice[];
    purchases: Invoice[];
    payments: Payment[];
    bankTxns: BankTxn[];
    expenses?: Expense[];
  },
  dateFrom = "",
  dateTo = "",
): { rows: BankLedgerRow[]; fullBalance: number; totalDebit: number; totalCredit: number } {
  const entries: Omit<BankLedgerRow, "balance">[] = [];

  for (const s of data.sales.filter((x) => x.bankId === bank.id && (x.bankPaidAmount ?? 0) > 0)) {
    entries.push({
      date: s.date,
      created: s.createdAt,
      type: "Sale Receipt",
      ref: `${s.number} — ${s.partyName}`,
      debit: 0,
      credit: s.bankPaidAmount!,
      docId: s.id,
      docKind: "sale",
    });
  }
  for (const p of data.purchases.filter(
    (x) => x.bankId === bank.id && (x.bankPaidAmount ?? 0) > 0,
  )) {
    entries.push({
      date: p.date,
      created: p.createdAt,
      type: "Purchase Payment",
      ref: `${p.number} — ${p.partyName}`,
      debit: p.bankPaidAmount!,
      credit: 0,
      docId: p.id,
      docKind: "purchase",
    });
  }
  for (const pay of data.payments.filter((x) => x.bankId === bank.id)) {
    if (pay.type === "in") {
      entries.push({
        date: pay.date,
        created: pay.createdAt,
        type: "Payment Received",
        ref: pay.partyName,
        debit: 0,
        credit: pay.amount,
      });
    } else {
      entries.push({
        date: pay.date,
        created: pay.createdAt,
        type: "Payment Made",
        ref: pay.partyName,
        debit: pay.amount,
        credit: 0,
      });
    }
  }
  for (const t of data.bankTxns.filter((x) => x.bankId === bank.id)) {
    if (t.type === "deposit") {
      entries.push({
        date: t.date,
        created: t.createdAt,
        type: "Deposit",
        ref: t.notes || "—",
        debit: 0,
        credit: t.amount,
      });
    } else if (t.type === "withdraw") {
      entries.push({
        date: t.date,
        created: t.createdAt,
        type: "Withdrawal",
        ref: t.notes || "—",
        debit: t.amount,
        credit: 0,
      });
    }
  }
  for (const ex of (data.expenses ?? []).filter((x) => x.bankId === bank.id)) {
    entries.push({
      date: ex.date,
      created: ex.createdAt,
      type: "Expense",
      ref: ex.category + (ex.notes ? ` — ${ex.notes}` : ""),
      debit: ex.amount,
      credit: 0,
    });
  }

  entries.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.created ?? "").localeCompare(b.created ?? ""),
  );

  const fullBalance = r2(
    entries.reduce((s, e) => s + e.credit - e.debit, bank.openingBalance || 0),
  );

  let running = bank.openingBalance || 0;
  const out: BankLedgerRow[] = [];
  const before = dateFrom ? entries.filter((e) => e.date < dateFrom) : [];
  const window = entries.filter(
    (e) => (!dateFrom || e.date >= dateFrom) && (!dateTo || e.date <= dateTo),
  );
  for (const e of before) {
    running = r2(running + e.credit - e.debit);
  }

  if (dateFrom) {
    out.push({
      date: "",
      created: "",
      type: "Balance b/f",
      ref: "—",
      debit: 0,
      credit: 0,
      balance: running,
    });
  } else if (bank.openingBalance) {
    out.push({
      date: "",
      created: "",
      type: "Opening Balance",
      ref: "—",
      debit: bank.openingBalance < 0 ? -bank.openingBalance : 0,
      credit: bank.openingBalance > 0 ? bank.openingBalance : 0,
      balance: running,
    });
  }
  for (const e of window) {
    running = r2(running + e.credit - e.debit);
    out.push({ ...e, balance: running });
  }
  const totalDebit = r2(out.reduce((s, e) => s + e.debit, 0));
  const totalCredit = r2(out.reduce((s, e) => s + e.credit, 0));
  return { rows: out, fullBalance, totalDebit, totalCredit };
}

export interface SimpleLedgerRow {
  date: string;
  particulars: string;
  qty: string;
  credit: number;
  debit: number;
  balance: number;
}

/**
 * Collapse a party statement into the plain one-line-per-transaction ledger
 * — Date / Particulars / Quantity / Credit / Debit / Balance — that people
 * expect to hand to a customer or an accountant.
 *
 * Credit and debit are derived from the MOVEMENT in the running balance
 * rather than re-deriving each document's sign, so this can never disagree
 * with the statement it came from.
 *
 * Lives here, not in the statement page, because the page and the bulk
 * ledger export both render it and must produce identical rows.
 */
export function buildSimpleLedgerRows(rows: PartyStatementRow[]): SimpleLedgerRow[] {
  const particularsOf = (r: PartyStatementRow) => {
    if (r.docKind === "sale") return `Sal. Bill No.: ${r.ref}`;
    if (r.docKind === "purchase") return `Pur. Bill No.: ${r.ref}`;
    if (r.docKind === "sale-return") return `Sale Return No.: ${r.ref}`;
    if (r.docKind === "purchase-return") return `Purchase Return No.: ${r.ref}`;
    return r.type; // Payment Received / Made / Beginning Balance / Balance b/f
  };
  let prevBalance = 0;
  return rows.map((r, i) => {
    if (i === 0) {
      prevBalance = r.balance;
      return {
        date: "",
        particulars: r.type === "Balance b/f" ? "Balance B/F" : "Opening Balance",
        qty: "",
        credit: 0,
        debit: 0,
        balance: r.balance,
      };
    }
    const delta = r2(r.balance - prevBalance);
    prevBalance = r.balance;
    const qty = r.items?.length ? r.items.reduce((s, it) => s + it.qty, 0) : null;
    return {
      date: r.date,
      particulars: particularsOf(r),
      qty: qty != null ? String(qty) : "",
      credit: delta < 0 ? -delta : 0,
      debit: delta > 0 ? delta : 0,
      balance: r.balance,
    };
  });
}

/**
 * Net-of-GST value of a set of bills or returns — `total` minus the output
 * tax inside it.
 *
 * Profit must never be computed off `invoice.total`: that figure includes
 * the GST collected from the customer, which is money held on behalf of the
 * tax authority, not earnings. Cost of goods sold, by contrast, is a
 * tax-exclusive line price (see computeCogs), so mixing the two overstated
 * every profit figure in the app by exactly the output GST on the period's
 * sales. Bill-level discount, shipping and round-off all stay in, since
 * those really are part of what the shop earned.
 */
export function valueExTax(
  docs: { total?: number; taxAmount?: number; gstEnabled?: boolean }[],
): number {
  return r2(
    docs.reduce(
      // A non-GST bill carries no tax to strip — guarded explicitly rather
      // than trusting taxAmount to be 0 on legacy/imported documents.
      (s, d) => s + (d.total || 0) - (d.gstEnabled === false ? 0 : d.taxAmount || 0),
      0,
    ),
  );
}

/** Cost of goods sold from per-line cost snapshots, falling back to the
 * item's current purchase price for lines saved before costPrice existed. */
export function computeCogs(sales: Invoice[], saleReturns: Return[], items: Item[]): number {
  const cost = new Map(items.map((i) => [i.id, i.purchasePrice] as const));
  const lineCost = (l: { itemId: string; qty: number; costPrice?: number }) =>
    (l.costPrice ?? cost.get(l.itemId) ?? 0) * l.qty;
  const sold = sales.reduce((s, inv) => s + inv.lineItems.reduce((a, l) => a + lineCost(l), 0), 0);
  const returned = saleReturns.reduce(
    (s, ret) => s + ret.lineItems.reduce((a, l) => a + lineCost(l), 0),
    0,
  );
  return r2(sold - returned);
}

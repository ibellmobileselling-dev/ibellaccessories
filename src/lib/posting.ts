/**
 * The posting ledger: one balanced journal entry per document.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS IS DERIVED AND NOT WRITTEN
 * ───────────────────────────────────────────────────────────────────────────
 * docs/ERP-PLAN.md §1 said every write path should write ledger lines on its
 * own batch, because that is how an ERP does it. Building it that way here
 * would have been worse, for three reasons that only became clear with the
 * shop's actual data in front of me:
 *
 * 1. **The ledger would be empty for all of history.** Every bill, payment
 *    and expense already on the books predates the change, so a written
 *    ledger starts at zero and a trial balance read off it is wrong until
 *    thousands of documents are backfilled — a mass write to a live shop's
 *    Firestore, which is the single riskiest thing in this plan and buys
 *    nothing.
 * 2. **Dual writing can drift.** Two records of the same fact, written on
 *    every path, is exactly the shape of the bug this phase exists to kill:
 *    the dashboard double-count happened because two places answered the
 *    same question separately. A derived ledger cannot disagree with the
 *    documents, because it *is* the documents.
 * 3. **Nothing needs it stored yet.** Storage buys immutability, and
 *    immutability matters for things no document implies — a manual journal
 *    voucher, a year-end closing entry, an append-only reversal. Those come
 *    with Phases 3 and 4, and `JournalEntry` below is already the shape they
 *    will be stored in, so they add rows to this list rather than replacing
 *    it.
 *
 * So: the posting RULES are real, complete, and the same ones a written
 * ledger would use. What changes is that they are applied on read. The
 * reconciliation in lib/trialBalance.ts is unaffected — that compares this
 * ledger against the app's four independent derivations, which is the check
 * §1 asked for and the reason to trust any of it.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE ONE RULE
 * ───────────────────────────────────────────────────────────────────────────
 * Every entry's debits equal its credits, to the paisa. Every figure below is
 * therefore derived by SUBTRACTION from the document's own total rather than
 * recomputed from its parts — recomputing invites a rounding difference, and
 * a journal that is out by a paisa is not a journal.
 */

import type {
  BankAccount,
  BankTxn,
  CashAdjustment,
  Expense,
  Invoice,
  Item,
  JournalEntryDoc,
  LineItem,
  Party,
  Payment,
  PaymentMode,
  Return,
  StockAdjustment,
} from "@/types";
import { bankAccountId, expenseAccountId } from "@/lib/accounts";
import { paidViaPayments } from "@/lib/ledger";
import { transferLegsFor } from "@/lib/transferLegs";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface PostingLine {
  accountId: string;
  debit: number;
  credit: number;
  /** Set on receivable/payable lines so a party's ledger can be read straight
   *  off the journal instead of being derived a second way. */
  partyId?: string;
}

export interface JournalEntry {
  id: string;
  date: string;
  /** What kind of voucher this is, in the words a book-keeper uses. */
  voucherType: string;
  voucherNo?: string;
  /** Back-pointer, so every figure drills through to the document that
   *  caused it. */
  docKind: string;
  docId: string;
  narration: string;
  /** YYYY-MM, for period filters and the year close. */
  periodKey: string;
  lines: PostingLine[];
}

/** The book, as the repositories hold it. */
export interface Book {
  parties: Party[];
  items: Item[];
  banks: BankAccount[];
  sales: Invoice[];
  purchases: Invoice[];
  saleReturns: Return[];
  purchaseReturns: Return[];
  payments: Payment[];
  expenses: Expense[];
  cashAdjustments: CashAdjustment[];
  bankTxns: BankTxn[];
  stockAdjustments: StockAdjustment[];
  /**
   * Entries that were written rather than derived — year-end closings.
   *
   * Optional so every existing caller and every test that predates them keeps
   * working with none: a book with no closed years is the normal state, and
   * the absent field must not read as "no ledger".
   */
  journalEntries?: JournalEntryDoc[];
}

/* ── Building blocks ──────────────────────────────────────────────────── */

/**
 * A debit, or the credit it really is.
 *
 * Round-off is −0.37 as often as +0.45, and a discount can be entered
 * negative. "Debit minus three rupees" is not a thing a ledger can print, so
 * a negative amount flips to the other side instead of being stored signed.
 * Zero amounts are dropped — an entry listing accounts it did not move is
 * noise on every screen that reads it.
 */
function dr(accountId: string, amount: number, partyId?: string): PostingLine[] {
  const n = r2(amount);
  if (!n) return [];
  return n > 0
    ? [{ accountId, debit: n, credit: 0, ...(partyId ? { partyId } : {}) }]
    : [{ accountId, debit: 0, credit: -n, ...(partyId ? { partyId } : {}) }];
}

function cr(accountId: string, amount: number, partyId?: string): PostingLine[] {
  const n = r2(amount);
  if (!n) return [];
  return n > 0
    ? [{ accountId, debit: 0, credit: n, ...(partyId ? { partyId } : {}) }]
    : // −n, not n. Storing the negative as-is left a debit of −0.40 sitting on
      // the entry, which balanced against nothing and put every bill with a
      // downward round-off out by twice its paise.
      [{ accountId, debit: -n, credit: 0, ...(partyId ? { partyId } : {}) }];
}

export const entryDebits = (e: JournalEntry) => r2(e.lines.reduce((s, l) => s + l.debit, 0));
export const entryCredits = (e: JournalEntry) => r2(e.lines.reduce((s, l) => s + l.credit, 0));
/** The paisa an entry is out by. Zero, always, or there is a posting bug. */
export const entryDrift = (e: JournalEntry) => r2(entryDebits(e) - entryCredits(e));
export const isBalanced = (e: JournalEntry) => Math.abs(entryDrift(e)) < 0.005;

const periodOf = (date: string) => (date || "").slice(0, 7);

/**
 * Where the money for a document actually moved.
 *
 * `bankId` wins over the payment mode, because when it is set the app has
 * already moved that specific account's stored balance — that is where the
 * money is, whatever the mode field says. Bank, UPI and cheque with no
 * account named land in the catch-all, and "credit" means the bill records
 * money as paid without naming what paid it, which is Suspense's whole job.
 */
function settlementAccount(mode: PaymentMode | undefined, bankId?: string): string {
  if (bankId) return bankAccountId(bankId);
  switch (mode) {
    case "cash":
      return "cash";
    case "bank":
    case "upi":
    case "cheque":
      return "bank-unattributed";
    default:
      return "suspense";
  }
}

/** The tax on a document, by the same rule `valueExTax` uses — a non-GST bill
 *  carries none, whatever its taxAmount field happens to hold. */
const taxOf = (d: { taxAmount?: number; gstEnabled?: boolean }) =>
  d.gstEnabled === false ? 0 : r2(d.taxAmount || 0);

/** What a line's goods cost, from the snapshot taken when it was billed —
 *  the same basis `computeCogs` uses, so COGS in the ledger and COGS in the
 *  P&L cannot be two different numbers. */
function lineCost(l: LineItem, costs: Map<string, number>): number {
  return r2((l.costPrice ?? costs.get(l.itemId) ?? 0) * (l.qty || 0));
}

const goodsCost = (lines: LineItem[], costs: Map<string, number>) =>
  r2(lines.reduce((s, l) => s + lineCost(l, costs), 0));

/** The reason account behind a manual cash movement. Purpose keys are mapped
 *  here rather than in lib/cashPurpose.ts so the chart of accounts stays the
 *  only place account ids are spelled. */
function cashPurposeAccount(purpose: string | undefined): string {
  switch (purpose) {
    case "opening":
      return "opening-equity";
    case "owner-in":
      return "capital";
    case "owner-out":
      return "drawings";
    default:
      // "short-over", "other", and every entry made before the app asked.
      return "cash-short-over";
  }
}

/* ── The rules, document by document ──────────────────────────────────── */

/**
 * A sale.
 *
 * Three things happen at once and a real voucher records them together: the
 * customer owes the total, the shop earned the taxable part and owes the GST,
 * and if money changed hands at the counter it did so against that same
 * receivable. The goods leaving stock is the fourth line pair.
 *
 * `direct` is what the bill itself collected, as distinct from what later
 * payments settled against it — the same subtraction `modeFlows` makes, so
 * cash cannot be counted twice.
 */
function postSale(inv: Invoice, direct: number, costs: Map<string, number>): JournalEntry {
  const tax = taxOf(inv);
  const shipping = r2(inv.shippingCharge || 0);
  const roundOff = r2(inv.roundOff || 0);
  const total = r2(inv.total || 0);
  // By subtraction, not by re-adding the lines: the bill's own total is the
  // fact, and everything else has to fit inside it exactly.
  const taxable = r2(total - tax - shipping - roundOff);
  const cogs = goodsCost(inv.lineItems ?? [], costs);

  return {
    id: `je-sale-${inv.id}`,
    date: inv.date,
    voucherType: "Sales Invoice",
    voucherNo: inv.number,
    docKind: "sale",
    docId: inv.id,
    narration: `Sale ${inv.number} — ${inv.partyName}`,
    periodKey: periodOf(inv.date),
    lines: [
      ...dr("ar", total, inv.partyId),
      ...cr("sales", taxable),
      ...cr("output-gst", tax),
      ...cr("freight-income", shipping),
      ...cr("round-off", roundOff),
      // Money taken at the counter, against the receivable just created.
      ...dr(settlementAccount(inv.paymentMode, inv.bankId), direct),
      ...cr("ar", direct, inv.partyId),
      // The goods themselves leave stock at cost.
      ...dr("cogs", cogs),
      ...cr("inventory", cogs),
    ],
  };
}

/**
 * A purchase. The mirror of a sale, with one deliberate difference: freight
 * and round-off go into Inventory rather than to income accounts, because
 * what a shop pays to get goods onto its shelf is part of what those goods
 * cost. The app already treats it that way for international bills
 * (`carryCostPerUnit` is baked into the line price), so this keeps the two
 * consistent.
 */
function postPurchase(inv: Invoice, direct: number): JournalEntry {
  const tax = taxOf(inv);
  const total = r2(inv.total || 0);
  const goods = r2(total - tax);

  return {
    id: `je-purchase-${inv.id}`,
    date: inv.date,
    voucherType: "Purchase Bill",
    voucherNo: inv.number,
    docKind: "purchase",
    docId: inv.id,
    narration: `Purchase ${inv.number} — ${inv.partyName}`,
    periodKey: periodOf(inv.date),
    lines: [
      ...dr("inventory", goods),
      ...dr("input-gst", tax),
      ...cr("ap", total, inv.partyId),
      // Paid at the counter, against the payable just created.
      ...dr("ap", direct, inv.partyId),
      ...cr(settlementAccount(inv.paymentMode, inv.bankId), direct),
    ],
  };
}

/** A sale return: the sale undone, and the goods back on the shelf at cost. */
function postSaleReturn(ret: Return, costs: Map<string, number>): JournalEntry {
  const tax = taxOf(ret);
  const total = r2(ret.total || 0);
  const taxable = r2(total - tax);
  const cogs = goodsCost(ret.lineItems ?? [], costs);

  return {
    id: `je-sale-return-${ret.id}`,
    date: ret.date,
    voucherType: "Credit Note",
    voucherNo: ret.number,
    docKind: "sale-return",
    docId: ret.id,
    narration: `Sale return ${ret.number} — ${ret.partyName}`,
    periodKey: periodOf(ret.date),
    lines: [
      ...dr("sales", taxable),
      ...dr("output-gst", tax),
      ...cr("ar", total, ret.partyId),
      ...dr("inventory", cogs),
      ...cr("cogs", cogs),
    ],
  };
}

/** A purchase return: goods going back, and the supplier owed less. */
function postPurchaseReturn(ret: Return): JournalEntry {
  const tax = taxOf(ret);
  const total = r2(ret.total || 0);
  const goods = r2(total - tax);

  return {
    id: `je-purchase-return-${ret.id}`,
    date: ret.date,
    voucherType: "Debit Note",
    voucherNo: ret.number,
    docKind: "purchase-return",
    docId: ret.id,
    narration: `Purchase return ${ret.number} — ${ret.partyName}`,
    periodKey: periodOf(ret.date),
    lines: [...dr("ap", total, ret.partyId), ...cr("inventory", goods), ...cr("input-gst", tax)],
  };
}

/**
 * A payment.
 *
 * The whole amount moves against the party, whether it was applied to bills
 * or left sitting as an advance — an advance is still money received, and the
 * receivable going negative is exactly what "we owe them goods" looks like in
 * a ledger.
 *
 * A settlement discount is the second half: it closes a bill without cash, so
 * it reduces the receivable and lands as a cost, never as money.
 */
function postPayment(p: Payment): JournalEntry {
  const amount = r2(p.amount || 0);
  const discount = r2((p.allocations ?? []).reduce((s, a) => s + (a.discount ?? 0), 0));
  const account = settlementAccount(p.mode, p.bankId);
  const isIn = p.type === "in";

  return {
    id: `je-payment-${p.id}`,
    date: p.date,
    voucherType: isIn ? "Receipt" : "Payment",
    voucherNo: p.ref,
    docKind: "payment",
    docId: p.id,
    narration: `${isIn ? "Received from" : "Paid to"} ${p.partyName}`,
    periodKey: periodOf(p.date),
    lines: isIn
      ? [
          ...dr(account, amount),
          ...cr("ar", amount, p.partyId),
          ...dr("discount-allowed", discount),
          ...cr("ar", discount, p.partyId),
        ]
      : [
          ...cr(account, amount),
          ...dr("ap", amount, p.partyId),
          ...dr("ap", discount, p.partyId),
          ...cr("discount-received", discount),
        ],
  };
}

function postExpense(e: Expense): JournalEntry {
  const amount = r2(e.amount || 0);
  return {
    id: `je-expense-${e.id}`,
    date: e.date,
    voucherType: "Expense",
    docKind: "expense",
    docId: e.id,
    narration: `${e.category}${e.payeeName ? ` — ${e.payeeName}` : ""}`,
    periodKey: periodOf(e.date),
    lines: [
      ...dr(expenseAccountId(e.category), amount),
      ...cr(settlementAccount(e.paymentMode, e.bankId), amount),
    ],
  };
}

/**
 * A manual cash movement, against the account its stated reason implies.
 *
 * This is Phase 1's whole point arriving: "CASH ADD TILL TODAY FROM VYAPAR
 * ₹29,000" now credits Opening Balance Equity instead of quietly inflating
 * profit. An entry with no stated reason lands in Cash Short/Over, where the
 * trial balance shows exactly how much of the shop's cash nobody has
 * explained.
 */
function postCashAdjustment(a: CashAdjustment): JournalEntry {
  const amount = r2(a.amount || 0);
  const other = cashPurposeAccount(a.purpose);
  const isIn = a.type === "add";
  return {
    id: `je-cash-${a.id}`,
    date: a.date,
    voucherType: "Cash Voucher",
    voucherNo: a.voucherNo,
    docKind: "cash-adjustment",
    docId: a.id,
    narration: a.reason || (isIn ? "Cash added" : "Cash reduced"),
    periodKey: periodOf(a.date),
    lines: isIn
      ? [...dr("cash", amount), ...cr(other, amount)]
      : [...dr(other, amount), ...cr("cash", amount)],
  };
}

/**
 * A deposit or withdrawal on a bank account that is not part of a transfer.
 *
 * The other side is genuinely unknown: the Bank screen's deposit and withdraw
 * actions record that an account moved without recording what moved it. So it
 * goes to Suspense, which is the honest answer and puts a number on how much
 * of it there is. Anything that IS a transfer never reaches here.
 */
function postBankTxn(t: BankTxn, bankName: string): JournalEntry {
  const amount = r2(t.amount || 0);
  const acc = bankAccountId(t.bankId);
  const isIn = t.type === "deposit";
  return {
    id: `je-bank-${t.id}`,
    date: t.date,
    voucherType: isIn ? "Bank Deposit" : "Bank Withdrawal",
    voucherNo: t.voucherNo,
    docKind: "bank-txn",
    docId: t.id,
    narration: t.notes || `${isIn ? "Deposit into" : "Withdrawal from"} ${bankName}`,
    periodKey: periodOf(t.date),
    lines: isIn
      ? [...dr(acc, amount), ...cr("suspense", amount)]
      : [...dr("suspense", amount), ...cr(acc, amount)],
  };
}

/**
 * A transfer: one voucher, two accounts, nothing else.
 *
 * This is the only place two documents collapse into one entry. A transfer is
 * stored as a pair — a cash leg and a bank leg, or two bank legs — and
 * posting each leg on its own would credit the source without ever debiting
 * the destination, which is precisely the half-moved money the pairing exists
 * to prevent.
 */
function postTransfer(
  id: string,
  date: string,
  amount: number,
  fromAccount: string,
  toAccount: string,
  narration: string,
  voucherNo?: string,
): JournalEntry {
  const n = r2(amount);
  return {
    id: `je-transfer-${id}`,
    date,
    voucherType: "Transfer",
    voucherNo,
    docKind: "transfer",
    docId: id,
    narration,
    periodKey: periodOf(date),
    lines: [...dr(toAccount, n), ...cr(fromAccount, n)],
  };
}

/** Stock found or lost outside any bill — damage, samples, a recount. */
function postStockAdjustment(a: StockAdjustment, costs: Map<string, number>): JournalEntry {
  const value = r2((costs.get(a.itemId) ?? 0) * (a.qty || 0));
  const isIn = a.type === "add";
  return {
    id: `je-stock-${a.id}`,
    date: a.date,
    voucherType: "Stock Adjustment",
    docKind: "stock-adjustment",
    docId: a.id,
    narration: `${a.itemName}${a.reason ? ` — ${a.reason}` : ""}`,
    periodKey: periodOf(a.date),
    lines: isIn
      ? [...dr("inventory", value), ...cr("stock-written-off", value)]
      : [...dr("stock-written-off", value), ...cr("inventory", value)],
  };
}

/**
 * Everything the shop was already carrying on the day it started using the
 * app: what parties owed, what was in the bank, what was on the shelf.
 *
 * All of it lands against Opening Balance Equity, because an opening figure
 * has no transaction behind it and equity is where "this was already true"
 * goes. Without these the ledger would disagree with every screen by exactly
 * the opening balances — which is the first thing a trial balance would have
 * shown, and the reason they are here.
 */
function postOpenings(book: Book, costs: Map<string, number>): JournalEntry[] {
  const out: JournalEntry[] = [];
  const dateOf = (createdAt?: string) => (createdAt || "2000-01-01").slice(0, 10);

  for (const p of book.parties) {
    const bal = r2(p.openingBalance || 0);
    if (!bal) continue;
    // Positive means they owed the shop; negative means the shop owed them.
    // Kept on the matching side rather than netted into one account, so
    // Receivable and Payable can be read off the ledger the way the shop
    // reads them.
    out.push({
      id: `je-open-party-${p.id}`,
      date: dateOf(p.createdAt),
      voucherType: "Opening Balance",
      docKind: "party-opening",
      docId: p.id,
      narration: `Opening balance — ${p.name}`,
      periodKey: periodOf(dateOf(p.createdAt)),
      lines:
        bal > 0
          ? [...dr("ar", bal, p.id), ...cr("opening-equity", bal)]
          : [...dr("opening-equity", -bal), ...cr("ap", -bal, p.id)],
    });
  }

  for (const b of book.banks) {
    const bal = r2(b.openingBalance || 0);
    if (!bal) continue;
    out.push({
      id: `je-open-bank-${b.id}`,
      date: dateOf(b.createdAt),
      voucherType: "Opening Balance",
      docKind: "bank-opening",
      docId: b.id,
      narration: `Opening balance — ${b.name}`,
      periodKey: periodOf(dateOf(b.createdAt)),
      lines: [...dr(bankAccountId(b.id), bal), ...cr("opening-equity", bal)],
    });
  }

  for (const i of book.items) {
    const value = r2((i.openingStock || 0) * (costs.get(i.id) ?? 0));
    if (!value) continue;
    out.push({
      id: `je-open-item-${i.id}`,
      date: dateOf(i.createdAt),
      voucherType: "Opening Balance",
      docKind: "item-opening",
      docId: i.id,
      narration: `Opening stock — ${i.name}`,
      periodKey: periodOf(dateOf(i.createdAt)),
      lines: [...dr("inventory", value), ...cr("opening-equity", value)],
    });
  }

  return out;
}

/* ── The journal ──────────────────────────────────────────────────────── */

/**
 * Every document in the book, as balanced journal entries.
 *
 * Pure and synchronous: it takes the arrays the repositories already hold in
 * memory and returns entries. Nothing is written, so this is safe to call
 * from any screen, and it covers all of history from the first call — there
 * is nothing to backfill and nothing that can fall out of step with the
 * documents.
 */
export function buildJournal(book: Book): JournalEntry[] {
  const costs = new Map(book.items.map((i) => [i.id, i.purchasePrice ?? 0] as const));
  const applied = paidViaPayments(book.payments);
  /** What a bill collected itself, as opposed to what payments settled on it. */
  const directOf = (inv: Invoice) => Math.max(0, r2((inv.paid || 0) - (applied.get(inv.id) ?? 0)));

  /** docId → the day it was cancelled, for everything posted below. */
  const voidedOn = new Map<string, string>();
  const noteVoid = (docId: string, rec: { voidedAt?: string }) => {
    if (rec.voidedAt) voidedOn.set(docId, rec.voidedAt.slice(0, 10));
  };

  const entries: JournalEntry[] = [...postOpenings(book, costs)];

  for (const s of book.sales) {
    entries.push(postSale(s, directOf(s), costs));
    noteVoid(s.id, s);
  }
  for (const p of book.purchases) {
    entries.push(postPurchase(p, directOf(p)));
    noteVoid(p.id, p);
  }
  for (const r of book.saleReturns) {
    entries.push(postSaleReturn(r, costs));
    noteVoid(r.id, r);
  }
  for (const r of book.purchaseReturns) {
    entries.push(postPurchaseReturn(r));
    noteVoid(r.id, r);
  }
  for (const p of book.payments) {
    entries.push(postPayment(p));
    noteVoid(p.id, p);
  }
  for (const e of book.expenses) {
    entries.push(postExpense(e));
    noteVoid(e.id, e);
  }
  for (const a of book.stockAdjustments) entries.push(postStockAdjustment(a, costs));
  // Stock adjustments are not voidable — they are corrections in their own
  // right, so cancelling one means making another.

  /* Transfers first, so neither leg is also posted on its own. A leg is
     recognised through the same helper the Cash screen's own pencil uses,
     which catches the pairs written before either side carried a transferId
     — those are real transfers in the shop's books and posting them twice
     would move the money twice. */
  const bankName = new Map(book.banks.map((b) => [b.id, b.name] as const));
  const usedCash = new Set<string>();
  const usedBank = new Set<string>();

  for (const adj of book.cashAdjustments) {
    const legs = transferLegsFor(adj, book.bankTxns);
    if (!legs.length) continue;
    const leg = legs[0];
    usedCash.add(adj.id);
    legs.forEach((l) => usedBank.add(l.id));
    const bank = bankAccountId(leg.bankId);
    const cashOut = adj.type === "reduce";
    // A transfer is one voucher keyed by its transferId, so the void is
    // recorded against that rather than against either leg's own id. Either
    // side being cancelled cancels the whole movement — half a reversed
    // transfer is money left in neither account.
    const transferKey = adj.transferId || adj.id;
    noteVoid(transferKey, adj);
    if (leg.voidedAt) noteVoid(transferKey, leg);
    entries.push(
      postTransfer(
        transferKey,
        adj.date,
        adj.amount || 0,
        cashOut ? "cash" : bank,
        cashOut ? bank : "cash",
        adj.reason || `Transfer — ${bankName.get(leg.bankId) ?? "bank"}`,
        adj.voucherNo ?? leg.voucherNo,
      ),
    );
  }

  // Bank-to-bank: two bank legs sharing a transferId, no cash involved.
  const byTransfer = new Map<string, BankTxn[]>();
  for (const t of book.bankTxns) {
    if (usedBank.has(t.id) || !t.transferId) continue;
    const list = byTransfer.get(t.transferId) ?? [];
    list.push(t);
    byTransfer.set(t.transferId, list);
  }
  for (const [transferId, legs] of byTransfer) {
    const from = legs.find((l) => l.type === "withdraw");
    const to = legs.find((l) => l.type === "deposit");
    if (!from || !to) continue; // a half-recorded pair; posted singly below
    usedBank.add(from.id);
    usedBank.add(to.id);
    noteVoid(transferId, from);
    noteVoid(transferId, to);
    entries.push(
      postTransfer(
        transferId,
        to.date,
        to.amount || 0,
        bankAccountId(from.bankId),
        bankAccountId(to.bankId),
        to.notes ||
          `Transfer — ${bankName.get(from.bankId) ?? "bank"} to ${bankName.get(to.bankId) ?? "bank"}`,
        to.voucherNo,
      ),
    );
  }

  for (const a of book.cashAdjustments) {
    if (usedCash.has(a.id)) continue;
    entries.push(postCashAdjustment(a));
    noteVoid(a.id, a);
  }
  for (const t of book.bankTxns) {
    if (usedBank.has(t.id)) continue;
    entries.push(postBankTxn(t, bankName.get(t.bankId) ?? "bank"));
    noteVoid(t.id, t);
  }

  /* The written entries, last. A closing entry is dated the last day of a
     year and must sit after everything else on that day — the accounts it
     empties have to be full when it lands. The sort below keys the same date
     by id, and "je-close-…" is not reliably last alphabetically, so the flag
     is what the statements branch on rather than position. */
  for (const doc of book.journalEntries ?? []) {
    // Cancelled the same way a bill is: the entry stands and a reversal
    // follows it, rather than the record being destroyed. A reopened year
    // therefore shows both, which is the honest account of a year that was
    // closed and then wasn't.
    noteVoid(doc.id, doc);
    entries.push({
      id: `je-doc-${doc.id}`,
      date: doc.date,
      voucherType: doc.voucherType,
      voucherNo: doc.voucherNo,
      docKind: doc.docKind,
      docId: doc.id,
      narration: doc.narration,
      periodKey: periodOf(doc.date),
      lines: doc.lines ?? [],
    });
  }

  /* Cancelled documents: the original stands, and a reversal follows it on
     the day it was voided. Applied here, once, over everything posted above —
     rather than inside each posting rule, where eight document types would be
     eight chances to get a sign backwards. It runs LAST because the stored
     entries are added above it, and a closing entry can be cancelled too. */
  for (const e of [...entries]) {
    const on = voidedOn.get(e.docId);
    if (!on) continue;
    /* On the day it was cancelled — except for a year close, which is
       reversed on its own date.

       A bill is an event: it happened in its month, and undoing it is a
       second event that happens in another. A closing entry is not an event
       at all. It is a boundary — a decision that a year is finished — and it
       exists only at the year end. Reversing it three months later would
       leave the year still closed as at 31 March and open afterwards, which
       is not a state a year can be in; the books would show a year that
       could never be closed again, because nothing would be left in the
       accounts to close.
 
       It stays append-only either way: the entry survives, the reversal is
       posted, and voidedAt/voidedBy/voidReason record when and who. Only the
       posting date differs, because only this document is a boundary rather
       than an event. */
    entries.push(reversalEntry(e, e.docKind === "year-close" ? e.date : on));
  }

  entries.sort((a, b) =>
    a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date),
  );
  return entries;
}

/**
 * The same entry, backwards, on the day it was cancelled.
 *
 * This is what append-only means in practice: the original stays where it is,
 * in the month it belonged to, and the cancellation lands on the day it was
 * decided. A trial balance as at a date between the two shows the movement;
 * one drawn after the void shows both and nets to nothing — which is the
 * honest account of what happened, as opposed to a bill that was simply never
 * there.
 *
 * One rule for every document type, because a per-type reversal is a per-type
 * chance to get a sign wrong.
 */
export function reversalEntry(e: JournalEntry, date: string): JournalEntry {
  return {
    id: `${e.id}-void`,
    date,
    voucherType: `${e.voucherType} (voided)`,
    voucherNo: e.voucherNo,
    docKind: `${e.docKind}-void`,
    docId: e.docId,
    narration: `Voided: ${e.narration}`,
    periodKey: periodOf(date),
    lines: e.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
  };
}

/**
 * The same book with the cancelled documents taken out.
 *
 * The ledger needs a voided document — it reverses one rather than forgetting
 * it. Everything else in the app has already stopped seeing it, because
 * Repository.all() filters it out. So a comparison between the two has to
 * feed each side what it actually reads: the ledger the whole book, and the
 * app's own calculations the live one. Handing both the same array made a
 * voided entry count once on one side and net to nothing on the other, and
 * the reconciliation reported a gap that was purely an artefact of the
 * comparison.
 */
export function liveOnly(book: Book): Book {
  const live = <R extends { voidedAt?: string }>(list: R[]) => list.filter((r) => !r.voidedAt);
  return {
    ...book,
    sales: live(book.sales),
    purchases: live(book.purchases),
    saleReturns: live(book.saleReturns),
    purchaseReturns: live(book.purchaseReturns),
    payments: live(book.payments),
    expenses: live(book.expenses),
    cashAdjustments: live(book.cashAdjustments),
    bankTxns: live(book.bankTxns),
  };
}

/** Entries that do not balance. Empty, or there is a posting bug — and this
 *  is what the reconciliation screen puts on the top row. */
export const unbalancedEntries = (entries: JournalEntry[]) => entries.filter((e) => !isBalanced(e));

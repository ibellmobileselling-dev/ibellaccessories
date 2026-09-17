/**
 * IBELL MOBILE production audit harness.
 * Imports the REAL calculation library (src/lib/ledger.ts) and hammers it
 * with randomized business scenarios ("monkey testing"), asserting the
 * accounting invariants that must never break.
 */
import {
  partyBalances,
  modeFlows,
  cashFlows,
  bankFlows,
  netFlow,
  computeCogs,
  allocatedAmount,
  advanceAmount,
  paidViaPayments,
  valueExTax,
  buildBankLedger,
  totalSettlementDiscount,
  netPartyPositions,
  buildPartyStatement,
  spreadFifo,
} from "@/lib/ledger";
import type {
  PaymentSplit,
  StockAdjustment,
  BankTxn,
  CashAdjustment,
  Serial,
  Invoice,
  Payment,
  Return,
  Item,
  Expense,
  LineItem,
  PaymentMode,
  BankAccount,
} from "@/types";
import { Repository } from "@/repositories/base";
import { correctBankPaidAmount, planBankRepair } from "@/lib/bankRepair";
import { planStockRepair } from "@/lib/dataRepair";
import { checkSerialIntegrity } from "@/lib/serialAudit";
import { serialCostIndex, lineCostBasis } from "@/lib/serialCost";
import {
  isSerialised,
  inStockCounts,
  stockOf,
  serialsOf,
  findSerial,
  warrantyEnd,
  warrantyDaysLeft,
  serialShortfalls,
  lookupSerials,
  warrantyState,
  vendorClaimState,
  SERIAL_MATCH_LIMIT,
} from "@/lib/serials";
import {
  planPurchaseSerials,
  planSaleReturnSerials,
  planPurchaseReturnSerials,
  planSaleSerials,
  soldSerialsOf,
  undoSerialsOf,
} from "@/lib/serialMoves";
import { transferLegsFor } from "@/lib/transferLegs";
import { AuditLogRepo, nextVoucherNo } from "@/repositories";
import { isLocked, blockedDate, lockMessage } from "@/lib/periodLock";
import { buildJournal, isBalanced, entryDrift, liveOnly, type Book } from "@/lib/posting";
import {
  canDeleteOutright,
  canEditInPlace,
  editRefusalMessage,
  isVoided,
  removalWord,
} from "@/lib/voiding";
import {
  financialYear,
  profitAndLoss,
  balanceSheet,
  planYearClose,
  closingEntry,
  closingEntryBalances,
} from "@/lib/financials";
import { accountsFor } from "@/lib/accounts";
import {
  reconcile,
  trialBalance,
  balanceOf,
  partyPositionsFromLedger,
  accountLedger,
} from "@/lib/trialBalance";
import {
  CASH_PURPOSES,
  CHOOSABLE_PURPOSES,
  purposeSpec,
  purposeLabel,
  totalsByPurpose,
} from "@/lib/cashPurpose";
import {
  splitsOf,
  cashPart,
  bankParts,
  unassignedPart,
  splitProblems,
  describePayment,
  largestSplitMode,
} from "@/lib/paymentSplit";
import { readFileSync } from "node:fs";
import { ledgerColumns } from "@/lib/ledger";
import {
  classifySendFailure,
  isDue,
  needsAttention,
  retryDelayMs,
  queuedMessage,
  MAX_ATTEMPTS,
  CLAIM_STALE_MS,
  type OutboxItem,
} from "@/lib/outbox";
import { popupRect } from "@/lib/popupRect";
import {
  deriveLinkState,
  linkSeverity,
  needsScan,
  linkHeadline,
  linkAdvice,
  sinceLabel,
  LINK_GRACE_MS,
} from "@/lib/whatsappLink";

let passed = 0,
  failed = 0;
const fails: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  /* One DISTINCT message per failing assertion, rather than the first 20 of
     everything. A change that breaks a rule breaks it in hundreds of
     generated scenarios, so a flat cap filled up with the same sentence
     repeated and truncated away the other rules it also broke — which is
     exactly the information needed to tell one broken rule from five. */
  if (!fails.includes(msg) && fails.length < 60) fails.push(msg);
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const approx = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps;

// Seeded RNG for reproducible runs
let seed = 20260702;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const ri = (max: number) => Math.floor(rnd() * max);
const pick = <T>(a: T[]) => a[ri(a.length)];
let idCounter = 0;
const nid = () => `id${++idCounter}`;

/* ═══════ TEST 1: Invoice totals formula — 5000 random bills ═══════ */
// Replicates InvoiceForm.recalc exactly and asserts the printed columns
// (taxable subtotal + GST − extra discount + round off) reconcile to Total.
for (let t = 0; t < 5000; t++) {
  const nLines = 1 + ri(8);
  const lines = Array.from({ length: nLines }, () => ({
    qty: r2(0.5 + rnd() * 20),
    price: r2(rnd() * 5000),
    discountPct: ri(4) === 0 ? ri(30) : 0,
    gstRate: pick([0, 5, 12, 18, 28]),
  }));
  const discount = ri(3) === 0 ? r2(rnd() * 50) : 0;
  const roundEnabled = ri(4) !== 0;
  // exact copy of recalc math
  const afterLineDisc = r2(
    lines.reduce((s, l) => s + r2(l.qty * l.price * (1 - l.discountPct / 100)), 0),
  );
  const taxAmount = r2(
    lines.reduce(
      (s, l) => s + r2(r2(l.qty * l.price * (1 - l.discountPct / 100)) * (l.gstRate / 100)),
      0,
    ),
  );
  const rawTotal = Math.max(0, r2(afterLineDisc + taxAmount - discount));
  const total = roundEnabled ? Math.round(rawTotal) : rawTotal;
  const roundOff = r2(total - rawTotal);

  assert(!roundEnabled || Number.isInteger(total), `T1: rounded total not whole rupee: ${total}`);
  assert(Math.abs(roundOff) <= 0.5 + 1e-9, `T1: roundOff out of range: ${roundOff}`);
  // What the printed bill shows must add up:
  const printed = r2(afterLineDisc + taxAmount - discount + roundOff);
  assert(approx(printed, total), `T1: printed columns ${printed} != total ${total}`);
}

/* ═══════ TEST 2: Party balances — 300 random books ═══════ */
for (let t = 0; t < 300; t++) {
  const partyIds = Array.from({ length: 1 + ri(5) }, () => nid());
  const invoices: Invoice[] = [];
  const returns: Return[] = [];
  const payments: Payment[] = [];

  for (let i = 0; i < 2 + ri(20); i++) {
    const pid = pick(partyIds);
    const total = r2(100 + rnd() * 9000);
    const initialPaid = ri(3) === 0 ? r2(rnd() * total) : 0;
    invoices.push({
      id: nid(),
      number: `INV-${i}`,
      date: "2026-07-01",
      partyId: pid,
      partyName: pid,
      lineItems: [],
      subtotal: total,
      discount: 0,
      taxAmount: 0,
      total,
      paid: initialPaid,
      paymentMode: "cash",
      createdAt: "",
    });
  }
  for (const inv of invoices) {
    if (ri(3) === 0) {
      // a payment applied against this invoice
      const due = r2(inv.total - inv.paid);
      if (due > 1) {
        const applyAmt = r2(due * (0.3 + rnd() * 0.7));
        inv.paid = r2(inv.paid + applyAmt); // what the app does on apply
        payments.push({
          id: nid(),
          date: "2026-07-02",
          partyId: inv.partyId,
          partyName: inv.partyName,
          type: "in",
          amount: applyAmt,
          mode: pick(["cash", "bank", "upi"] as PaymentMode[]),
          allocations: [{ invoiceId: inv.id, number: inv.number, amount: applyAmt }],
          createdAt: "",
        });
      }
    }
    if (ri(5) === 0) {
      returns.push({
        id: nid(),
        number: `CR-${inv.number}`,
        date: "2026-07-03",
        partyId: inv.partyId,
        partyName: inv.partyName,
        lineItems: [],
        subtotal: 0,
        taxAmount: 0,
        total: r2(inv.total * 0.2),
        createdAt: "",
      });
    }
  }
  // pure advances
  for (let i = 0; i < ri(4); i++) {
    const pid = pick(partyIds);
    payments.push({
      id: nid(),
      date: "2026-07-02",
      partyId: pid,
      partyName: pid,
      type: "in",
      amount: r2(50 + rnd() * 500),
      mode: "cash",
      createdAt: "",
    });
  }

  const balances = partyBalances(invoices, returns, payments);
  for (const b of balances) {
    // independent naive recomputation
    const inv = invoices.filter((x) => x.partyId === b.partyId);
    const ret = returns.filter((x) => x.partyId === b.partyId);
    const pay = payments.filter((x) => x.partyId === b.partyId);
    const invoiced = r2(inv.reduce((s, x) => s + x.total, 0));
    const settled = r2(inv.reduce((s, x) => s + x.paid, 0));
    const returned = r2(ret.reduce((s, x) => s + x.total, 0));
    const advances = r2(
      pay.reduce(
        (s, p) => s + (p.amount - (p.allocations ?? []).reduce((a, x) => a + x.amount, 0)),
        0,
      ),
    );
    const expect = r2(invoiced - returned - settled - advances);
    assert(approx(b.balance, expect), `T2: balance ${b.balance} != naive ${expect}`);
    // every allocated rupee is inside invoice.paid — money counted exactly once
    for (const p of pay) {
      assert(allocatedAmount(p) <= p.amount + 0.001, `T2: allocated > amount`);
      assert(approx(advanceAmount(p), p.amount - allocatedAmount(p)), `T2: advance mismatch`);
    }
  }
}

/* ═══════ TEST 3: Cash/bank flows never double-count applied payments ═══════ */
for (let t = 0; t < 300; t++) {
  // one cash invoice: paid 200 at billing, then 300 applied via a UPI payment
  const inv: Invoice = {
    id: nid(),
    number: "INV-X",
    date: "2026-07-01",
    partyId: "p",
    partyName: "p",
    lineItems: [],
    subtotal: 1000,
    discount: 0,
    taxAmount: 0,
    total: 1000,
    paid: 500,
    paymentMode: "cash",
    createdAt: "",
  };
  const pay: Payment = {
    id: nid(),
    date: "2026-07-02",
    partyId: "p",
    partyName: "p",
    type: "in",
    amount: 300,
    mode: "upi",
    allocations: [{ invoiceId: inv.id, number: inv.number, amount: 300 }],
    createdAt: "",
  };
  const cash = netFlow(cashFlows([inv], [], [], [pay], []));
  const bank = netFlow(bankFlows([inv], [], [], [pay]));
  assert(approx(cash, 200), `T3: cash ${cash} != 200 (initial cash only)`);
  assert(approx(bank, 300), `T3: bank ${bank} != 300 (UPI payment only)`);
  assert(approx(cash + bank, inv.paid), `T3: cash+bank != invoice.paid`);
}

/* ═══════ TEST 4: COGS ═══════ */
{
  const items: Item[] = [
    {
      id: "i1",
      name: "A",
      unit: "pcs",
      gstRate: 0,
      purchasePrice: 80,
      salePrice: 100,
      stock: 0,
      openingStock: 0,
      createdAt: "",
    },
  ];
  const line = (qty: number, costPrice?: number): LineItem => ({
    id: nid(),
    itemId: "i1",
    name: "A",
    qty,
    unit: "pcs",
    price: 100,
    discountPct: 0,
    gstRate: 0,
    amount: qty * 100,
    costPrice,
  });
  const sales: Invoice[] = [
    {
      id: nid(),
      number: "S1",
      date: "2026-07-01",
      partyId: "p",
      partyName: "p",
      lineItems: [line(2, 70), line(3)],
      subtotal: 500,
      discount: 0,
      taxAmount: 0,
      total: 500,
      paid: 0,
      paymentMode: "cash",
      createdAt: "",
    },
  ];
  const rets: Return[] = [
    {
      id: nid(),
      number: "CR1",
      date: "2026-07-02",
      partyId: "p",
      partyName: "p",
      lineItems: [line(1, 70)],
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      createdAt: "",
    },
  ];
  // 2×70 (snapshot) + 3×80 (fallback) − 1×70 (returned) = 310
  assert(approx(computeCogs(sales, rets, items), 310), `T4: COGS != 310`);
}

/* ═══════ TEST 5: MONKEY — 20,000 random stock operations ═══════ */
// Simulates the exact mutation sequences the app performs and checks
// stock always equals opening + everything-in − everything-out.
{
  type Doc = { qty: number; itemId: string };
  const item = { opening: 100, stock: 100 };
  const salesDocs = new Map<string, Doc>();
  const purchaseDocs = new Map<string, Doc>();
  const sRetDocs = new Map<string, Doc>();
  const pRetDocs = new Map<string, Doc>();
  let adjNet = 0;
  let openingEdits = 0;

  const expectStock = () => {
    let s = item.opening;
    for (const d of purchaseDocs.values()) s += d.qty;
    for (const d of salesDocs.values()) s -= d.qty;
    for (const d of sRetDocs.values()) s += d.qty;
    for (const d of pRetDocs.values()) s -= d.qty;
    return r2(s + adjNet);
  };
  const adj = (delta: number) => {
    item.stock = r2(item.stock + delta);
  };

  for (let op = 0; op < 20000; op++) {
    const kind = ri(10);
    const qty = r2(0.5 + rnd() * 10);
    if (kind === 0) {
      // new sale (app: stock −qty)
      const id = nid();
      salesDocs.set(id, { qty, itemId: "i" });
      adj(-qty);
    } else if (kind === 1) {
      // new purchase (+qty)
      const id = nid();
      purchaseDocs.set(id, { qty, itemId: "i" });
      adj(qty);
    } else if (kind === 2 && salesDocs.size) {
      // edit sale (reverse old, apply new)
      const id = pick([...salesDocs.keys()]);
      const old = salesDocs.get(id)!;
      adj(old.qty); // reversal
      old.qty = qty;
      adj(-qty); // re-apply
    } else if (kind === 3 && salesDocs.size) {
      // delete sale (+qty back)
      const id = pick([...salesDocs.keys()]);
      adj(salesDocs.get(id)!.qty);
      salesDocs.delete(id);
    } else if (kind === 4 && purchaseDocs.size) {
      // delete purchase (−qty)
      const id = pick([...purchaseDocs.keys()]);
      adj(-purchaseDocs.get(id)!.qty);
      purchaseDocs.delete(id);
    } else if (kind === 5) {
      // sale return (+qty)
      const id = nid();
      sRetDocs.set(id, { qty, itemId: "i" });
      adj(qty);
    } else if (kind === 6) {
      // purchase return (−qty)
      const id = nid();
      pRetDocs.set(id, { qty, itemId: "i" });
      adj(-qty);
    } else if (kind === 7 && sRetDocs.size) {
      // delete sale return (−qty)
      const id = pick([...sRetDocs.keys()]);
      adj(-sRetDocs.get(id)!.qty);
      sRetDocs.delete(id);
    } else if (kind === 8) {
      // manual stock adjustment
      const delta = (ri(2) ? 1 : -1) * qty;
      adjNet = r2(adjNet + delta);
      adj(delta);
    } else if (kind === 9) {
      // edit opening stock (delta shifts current)
      const newOpening = r2(rnd() * 200);
      const delta = r2(newOpening - item.opening);
      item.opening = newOpening;
      adj(delta);
      openingEdits++;
    }
    if (op % 100 === 0 || op === 19999) {
      assert(
        approx(item.stock, expectStock(), 0.5),
        `T5 op${op}: stock ${item.stock} != expected ${expectStock()}`,
      );
    }
  }
  assert(approx(item.stock, expectStock(), 0.5), `T5 final: stock drifted`);
}

/* ═══════ TEST 6: MONKEY — payment lifecycle (create/edit/delete) ═══════ */
{
  const invoices: Invoice[] = Array.from({ length: 12 }, (_, i) => ({
    id: nid(),
    number: `INV-${i}`,
    date: "2026-07-01",
    partyId: "p1",
    partyName: "p1",
    lineItems: [],
    subtotal: 1000,
    discount: 0,
    taxAmount: 0,
    total: 1000,
    paid: 0,
    paymentMode: "credit",
    createdAt: "",
  }));
  const initialPaid = new Map(invoices.map((i) => [i.id, 0]));
  const payments: Payment[] = [];

  const applyPayment = (): Payment | null => {
    const open = invoices.filter((i) => r2(i.total - i.paid) > 1);
    if (!open.length) return null;
    const allocs = open
      .slice(0, 1 + ri(3))
      .map((inv) => {
        const amt = r2(Math.min(r2(inv.total - inv.paid), 50 + rnd() * 400));
        inv.paid = r2(inv.paid + amt); // app behaviour
        return { invoiceId: inv.id, number: inv.number, amount: amt };
      })
      .filter((a) => a.amount > 0);
    if (!allocs.length) return null;
    const p: Payment = {
      id: nid(),
      date: "2026-07-02",
      partyId: "p1",
      partyName: "p1",
      type: "in",
      amount: r2(allocs.reduce((s, a) => s + a.amount, 0)),
      mode: "cash",
      allocations: allocs,
      createdAt: "",
    };
    payments.push(p);
    return p;
  };
  const reverse = (p: Payment) => {
    for (const a of p.allocations ?? []) {
      const inv = invoices.find((i) => i.id === a.invoiceId)!;
      inv.paid = r2(inv.paid - a.amount);
    }
  };

  for (let op = 0; op < 3000; op++) {
    const k = ri(3);
    if (k === 0) applyPayment();
    else if (k === 1 && payments.length) {
      // delete (app: reverse allocations, remove record)
      const idx = ri(payments.length);
      reverse(payments[idx]);
      payments.splice(idx, 1);
    } else if (k === 2 && payments.length) {
      // edit (app: reverse, re-apply fresh)
      const idx = ri(payments.length);
      reverse(payments[idx]);
      payments.splice(idx, 1);
      applyPayment();
    }
    // INVARIANT: invoice.paid == initialPaid + sum of surviving allocations
    const byInv = paidViaPayments(payments);
    for (const inv of invoices) {
      const expected = r2((initialPaid.get(inv.id) ?? 0) + (byInv.get(inv.id) ?? 0));
      assert(
        approx(inv.paid, expected),
        `T6 op${op}: ${inv.number} paid ${inv.paid} != ${expected}`,
      );
      assert(
        inv.paid >= -0.01 && inv.paid <= inv.total + 0.01,
        `T6 op${op}: paid out of range ${inv.paid}`,
      );
    }
  }
  // Party balance must equal total dues (no advances in this scenario)
  const bal = partyBalances(invoices, [], payments)[0];
  const dues = r2(invoices.reduce((s, i) => s + (i.total - i.paid), 0));
  assert(approx(bal.balance, dues), `T6: party balance ${bal.balance} != open dues ${dues}`);
}

/* ═══════ TEST 7: expenses & adjustments in cash ═══════ */
{
  const exp: Expense[] = [
    {
      id: nid(),
      date: "2026-07-01",
      category: "Tea",
      amount: 50,
      paymentMode: "cash",
      createdAt: "",
    },
  ];
  const adj: CashAdjustment[] = [
    { id: nid(), date: "2026-07-01", type: "add", amount: 500, createdAt: "" },
    { id: nid(), date: "2026-07-01", type: "reduce", amount: 120, createdAt: "" },
  ];
  const cash = netFlow(cashFlows([], [], exp, [], adj));
  assert(approx(cash, 500 - 120 - 50), `T7: cash ${cash} != 330`);
}

/* ═══ TEST 10: a bank-mode expense is NOT double-counted in bankFlows ═══
   A bank expense already moved the account's stored balance at save time;
   the Bank page / dashboard add bankFlows ON TOP of stored balances, so
   bankFlows must exclude anything carrying a bankId. A cash expense (no
   bankId) must still be counted in cashFlows. Regression guard for A1. */
{
  const bankExp: Expense[] = [
    {
      id: nid(),
      date: "2026-07-01",
      category: "Rent",
      amount: 5000,
      paymentMode: "bank",
      bankId: "bk1",
      createdAt: "",
    },
  ];
  const bankOut = netFlow(bankFlows([], [], bankExp, []));
  assert(bankOut === 0, `T10: bank expense must not appear in bankFlows (got ${bankOut})`);

  const cashExp: Expense[] = [
    {
      id: nid(),
      date: "2026-07-01",
      category: "Tea",
      amount: 50,
      paymentMode: "cash",
      createdAt: "",
    },
  ];
  const cashOut = netFlow(cashFlows([], [], cashExp, [], []));
  assert(cashOut === -50, `T10: cash expense must still count in cashFlows (got ${cashOut})`);
}

console.log(`\n══════════════════════════════════════`);

/* ═══ TEST 9: opening balance sign convention — never double counted ═══ */
{
  const partiesOB = [
    { id: "pA", name: "A", openingBalance: 5000 }, // they owe us
    { id: "pB", name: "B", openingBalance: -3000 }, // we owe them
  ];
  const cust = partyBalances([], [], [], partiesOB, "customer");
  const supp = partyBalances([], [], [], partiesOB, "supplier");
  const get = (list: ReturnType<typeof partyBalances>, id: string) =>
    list.find((b) => b.partyId === id)!.balance;
  assert(get(cust, "pA") === 5000, "T9: +opening must be receivable");
  assert(get(supp, "pA") === 0, "T9: +opening must NOT be payable");
  assert(get(cust, "pB") === 0, "T9: -opening must NOT be receivable");
  assert(get(supp, "pB") === 3000, "T9: -opening must be payable");
  const stmt = partyBalances([], [], [], partiesOB); // statement: signed as-is
  assert(get(stmt, "pA") === 5000 && get(stmt, "pB") === -3000, "T9: statement uses signed value");
}

/* ═══ TEST 8: Repository — empty-string draft IDs must be replaced ═══ */
{
  const repo = new Repository<{ id: string; total: number }>("test-collection");
  const a = repo.add({ id: "", total: 100 } as never);
  const b = repo.add({ id: "", total: 200 } as never);
  const c = repo.add({ total: 300 } as never);
  assert(a.id.length > 0, "T8: empty-string id not replaced");
  assert(b.id.length > 0 && b.id !== a.id, "T8: ids must be unique");
  assert(c.id.length > 0, "T8: missing id not generated");
  assert(repo.all().length === 3, "T8: cache count");
  repo.adjustField(a.id, "total", -30);
  assert(repo.get(a.id)!.total === 70, "T8: adjustField cache math");
  repo.remove(b.id);
  assert(repo.all().length === 2, "T8: remove");
}

/* ═══ TEST 11: a bill's bank snapshot excludes Payment-record money ═══
   Regression for the highest-severity bug found in the Aug-2026 review:
   InvoiceForm stored the WHOLE of invoice.paid as bankPaidAmount. Once a
   Payment record was allocated to the bill, invoice.paid included money that
   had arrived by another route (often cash) and had already moved on its own
   mode — so merely re-saving the bill credited the bank account with it a
   second time, inventing money that existed nowhere. The correct snapshot is
   the "direct portion": paid minus whatever Payment records supplied — the
   same formula modeFlows() uses for the cash side. */
{
  // The REAL function InvoiceForm.finalizeSave calls — not a copy of it, so
  // this test can't pass while production drifts.
  const bankSnapshot = (inv: Invoice, paid: number, payments: Payment[]) =>
    correctBankPaidAmount({ ...inv, paid } as Invoice, payments);

  const bank: BankAccount = {
    id: "B1",
    name: "HDFC",
    openingBalance: 0,
    balance: 0,
    createdAt: "",
  } as BankAccount;

  let sale = {
    id: "S1",
    number: "INV-9001",
    date: "2026-08-01",
    partyId: "P1",
    partyName: "Ramesh",
    gstEnabled: false,
    lineItems: [],
    subtotal: 1000,
    discount: 0,
    taxAmount: 0,
    total: 1000,
    paid: 400,
    paymentMode: "bank",
    bankId: "B1",
    bankPaidAmount: 400,
    createdAt: "2026-08-01T10:00:00Z",
  } as unknown as Invoice;
  bank.balance = 400; // moved at billing

  // A later CASH payment settles the rest and pushes invoice.paid to 1000.
  const pay = {
    id: "PY1",
    type: "in",
    date: "2026-08-05",
    partyId: "P1",
    partyName: "Ramesh",
    amount: 600,
    mode: "cash",
    allocations: [{ invoiceId: "S1", number: "INV-9001", amount: 600 }],
    createdAt: "2026-08-05T10:00:00Z",
  } as unknown as Payment;
  sale = { ...sale, paid: 1000 };

  const totalMoney = () =>
    r2(
      netFlow(cashFlows([sale], [], [], [pay], [])) +
        bank.balance +
        netFlow(bankFlows([sale], [], [], [pay])),
    );

  assert(totalMoney() === 1000, "T11: baseline — 400 bank + 600 cash");

  // Re-save the bill three times over. Each save reverses the stored snapshot
  // and applies the freshly computed one, exactly as finalizeSave does.
  for (let i = 0; i < 3; i++) {
    const next = bankSnapshot(sale, sale.paid, [pay]);
    bank.balance = r2(bank.balance - (sale.bankPaidAmount ?? 0) + (next ?? 0));
    sale = { ...sale, bankPaidAmount: next };
    assert(totalMoney() === 1000, `T11: re-save #${i + 1} must not create money`);
    assert(sale.bankPaidAmount === 400, `T11: re-save #${i + 1} keeps the direct portion`);
  }

  // The passbook derives from bankPaidAmount, so it must agree too.
  const passbook = buildBankLedger(bank, {
    sales: [sale],
    purchases: [],
    payments: [pay],
    bankTxns: [],
  }).fullBalance;
  assert(passbook === bank.balance, "T11: passbook must match the stored balance");

  // Reducing the bill to 800 leaves 600 payment-backed, so the bank keeps 200.
  const reduced = bankSnapshot(sale, 800, [pay]);
  bank.balance = r2(bank.balance - (sale.bankPaidAmount ?? 0) + (reduced ?? 0));
  sale = { ...sale, total: 800, paid: 800, bankPaidAmount: reduced };
  assert(reduced === 200, "T11: reduced bill keeps only its own direct portion");
  assert(totalMoney() === 800, "T11: reduced bill totals 800");

  // A non-bank bill must never carry a bank snapshot at all.
  const cashBill = { ...sale, paymentMode: "cash" } as Invoice;
  assert(
    bankSnapshot(cashBill, cashBill.paid, [pay]) === undefined,
    "T11: non-bank bill has no bank snapshot",
  );
}

/* ═══ TEST 12: profit excludes output GST ═══
   invoice.total is tax-INCLUSIVE while COGS is a tax-exclusive line cost, so
   the P&L and the dashboard were reporting the GST collected as earnings. */
{
  const gstBill = {
    id: "G1",
    total: 1180,
    taxAmount: 180,
    gstEnabled: true,
  } as unknown as Invoice;
  const plainBill = {
    id: "G2",
    total: 500,
    taxAmount: 0,
    gstEnabled: false,
  } as unknown as Invoice;
  // A legacy/imported doc marked non-GST but carrying a stale taxAmount must
  // NOT have that phantom tax stripped out of revenue.
  const legacyBill = {
    id: "G3",
    total: 300,
    taxAmount: 45,
    gstEnabled: false,
  } as unknown as Invoice;

  assert(valueExTax([gstBill]) === 1000, "T12: strips output GST");
  assert(valueExTax([plainBill]) === 500, "T12: non-GST bill untouched");
  assert(valueExTax([legacyBill]) === 300, "T12: gstEnabled:false ignores stale taxAmount");
  assert(valueExTax([gstBill, plainBill]) === 1500, "T12: sums correctly");
  assert(valueExTax([]) === 0, "T12: empty set");
  assert(
    valueExTax([{ total: 1180, taxAmount: 180 } as unknown as Invoice]) === 1000,
    "T12: undefined gstEnabled treated as GST bill",
  );
  // The invariant that actually matters: gross profit on a GST bill must equal
  // the ex-tax margin, never the tax-inflated one.
  const cogs = 700;
  assert(valueExTax([gstBill]) - cogs === 300, "T12: gross profit is ex-GST margin");
}

/* ═══ TEST 13: the bank reconciliation repair ═══
   Builds a book that HAS the historical corruption in it and checks the
   planner both spots it and lands the account on the derived truth. */
{
  const bank = {
    id: "BR1",
    name: "ICICI",
    openingBalance: 5000,
    balance: 99999, // deliberately wrong, as production is
    createdAt: "",
  } as unknown as BankAccount;

  const sale = {
    id: "RS1",
    number: "INV-7001",
    date: "2026-05-02",
    partyId: "P9",
    partyName: "Suresh",
    gstEnabled: false,
    lineItems: [],
    subtotal: 2000,
    discount: 0,
    taxAmount: 0,
    total: 2000,
    paid: 2000,
    paymentMode: "bank",
    bankId: "BR1",
    bankPaidAmount: 2000, // corrupted: 1500 of this came via a cash payment
    createdAt: "2026-05-02T09:00:00Z",
  } as unknown as Invoice;

  const pay = {
    id: "RP1",
    type: "in",
    date: "2026-05-09",
    partyId: "P9",
    partyName: "Suresh",
    amount: 1500,
    mode: "cash",
    allocations: [{ invoiceId: "RS1", number: "INV-7001", amount: 1500 }],
    createdAt: "2026-05-09T09:00:00Z",
  } as unknown as Payment;

  const plan = planBankRepair({
    sales: [sale],
    purchases: [],
    payments: [pay],
    banks: [bank],
    bankTxns: [],
    expenses: [],
  });

  assert(plan.hasWork, "T13: corruption must be detected");
  assert(plan.bills.length === 1, "T13: exactly one bill needs correcting");
  assert(plan.bills[0].stored === 2000, "T13: reports the stored snapshot");
  assert(plan.bills[0].correct === 500, "T13: only the direct portion is genuinely bank money");
  assert(plan.accounts.length === 1, "T13: the account balance is off");
  // opening 5000 + the bill's real 500 = 5500
  assert(plan.accounts[0].correct === 5500, "T13: balance re-derived from documents");
  assert(plan.accounts[0].delta === r2(5500 - 99999), "T13: delta is correct - stored");

  // Applying the plan and re-planning must find nothing left to do.
  const repairedSale = { ...sale, bankPaidAmount: plan.bills[0].correct } as Invoice;
  const repairedBank = { ...bank, balance: plan.accounts[0].correct } as BankAccount;
  const after = planBankRepair({
    sales: [repairedSale],
    purchases: [],
    payments: [pay],
    banks: [repairedBank],
    bankTxns: [],
    expenses: [],
  });
  assert(!after.hasWork, "T13: repair must be idempotent — nothing left on a second pass");

  // A healthy book must never be flagged (no spurious "corrections").
  const clean = planBankRepair({
    sales: [],
    purchases: [],
    payments: [],
    banks: [{ ...bank, balance: 5000 } as BankAccount],
    bankTxns: [],
    expenses: [],
  });
  assert(!clean.hasWork, "T13: a healthy book reports no work");

  // Cash-mode bills must be ignored entirely by the planner.
  const cashOnly = planBankRepair({
    sales: [{ ...sale, paymentMode: "cash", bankId: undefined } as Invoice],
    purchases: [],
    payments: [pay],
    banks: [{ ...bank, balance: 5000 } as BankAccount],
    bankTxns: [],
    expenses: [],
  });
  assert(cashOnly.bills.length === 0, "T13: non-bank bills are not touched");
}

/* ═══ TEST 14: settlement discount ═══
   The client's case: a 20,500 bill, 20,000 collected, the last 500 waived so
   the bill can be closed. The bill must read as fully settled and the party
   must owe nothing, while ONLY the 20,000 may ever appear as cash — the
   waived 500 is a cost, not money that arrived. */
{
  const inv = {
    id: "D1",
    number: "INV-5001",
    date: "2026-06-01",
    partyId: "PD",
    partyName: "Discount Co",
    gstEnabled: false,
    lineItems: [],
    subtotal: 20500,
    discount: 0,
    taxAmount: 0,
    total: 20500,
    paid: 20500, // 20000 cash + 500 written off
    paymentMode: "credit",
    createdAt: "2026-06-01T09:00:00Z",
  } as unknown as Invoice;

  const pay = {
    id: "DP1",
    type: "in",
    date: "2026-06-10",
    partyId: "PD",
    partyName: "Discount Co",
    amount: 20000, // cash only — the discount is NOT part of this
    mode: "cash",
    allocations: [{ invoiceId: "D1", number: "INV-5001", amount: 20000, discount: 500 }],
    createdAt: "2026-06-10T09:00:00Z",
  } as unknown as Payment;

  // The bill is settled in full: cash + write-off.
  assert(paidViaPayments([pay]).get("D1") === 20500, "T14: bill counted as fully settled");

  // The party owes nothing afterwards.
  const bal = partyBalances([inv], [], [pay], [{ id: "PD", name: "Discount Co" }], "customer");
  assert(bal[0].balance === 0, "T14: party balance clears to zero");

  // Only real cash reaches the cash position — never the written-off 500.
  const cash = netFlow(cashFlows([inv], [], [], [pay], []));
  assert(cash === 20000, `T14: cash must be 20000, got ${cash}`);

  // And the direct-portion formula must not invent a phantom receipt: the
  // invoice is "credit" mode, so nothing of it belongs in any mode's flows.
  const bankish = netFlow(bankFlows([inv], [], [], [pay]));
  assert(bankish === 0, "T14: no phantom bank movement");

  assert(totalSettlementDiscount([pay]) === 500, "T14: the write-off is reported for the P&L");
  assert(totalSettlementDiscount([]) === 0, "T14: no payments, no discount");

  // An advance must still be computed off CASH only, not cash + write-off.
  assert(advanceAmount(pay) === 0, "T14: fully applied, so no advance");
  const partial = {
    ...pay,
    amount: 20300,
    allocations: [{ invoiceId: "D1", number: "INV-5001", amount: 20000, discount: 500 }],
  } as unknown as Payment;
  assert(advanceAmount(partial) === 300, "T14: surplus cash is an advance; the write-off is not");
}

/* ═══ TEST 15: stock recomputed from its movements ═══
   Item.stock is a stored running total, so it CAN drift (a half-committed
   bill, a reversal that never landed). The repair rebuilds it from
   opening + purchases + sale returns − sales − purchase returns ± adjustments. */
{
  const item = {
    id: "SR_I1",
    name: "Widget",
    unit: "pcs",
    gstRate: 0,
    purchasePrice: 10,
    salePrice: 20,
    openingStock: 100,
    stock: 999, // deliberately wrong
    createdAt: "",
  } as unknown as Item;

  const line = (qty: number) => ({
    id: "l",
    itemId: "SR_I1",
    name: "Widget",
    unit: "pcs",
    qty,
    price: 10,
    discountPct: 0,
    gstRate: 0,
    amount: qty * 10,
  });
  const sale = { id: "s", lineItems: [line(30)] } as unknown as Invoice;
  const purchase = { id: "p", lineItems: [line(50)] } as unknown as Invoice;
  const saleRet = { id: "sr", lineItems: [line(5)] } as unknown as Return;
  const purRet = { id: "pr", lineItems: [line(2)] } as unknown as Return;
  const adjAdd = { id: "a1", itemId: "SR_I1", type: "add", qty: 7 } as never;
  const adjCut = { id: "a2", itemId: "SR_I1", type: "reduce", qty: 4 } as never;

  // 100 + 50 purchased + 5 returned in − 30 sold − 2 returned out + 7 − 4 = 126
  const plan = planStockRepair({
    items: [item],
    sales: [sale],
    purchases: [purchase],
    saleReturns: [saleRet],
    purchaseReturns: [purRet],
    stockAdjustments: [adjAdd, adjCut],
  });
  assert(plan.length === 1, "T15: drift detected");
  assert(plan[0].correct === 126, `T15: rebuilt stock should be 126, got ${plan[0]?.correct}`);
  assert(plan[0].stored === 999, "T15: reports what was stored");
  assert(plan[0].delta === 126 - 999, "T15: delta is correct − stored");

  // Applying it and re-planning must find nothing left.
  const fixed = { ...item, stock: plan[0].correct } as Item;
  const after = planStockRepair({
    items: [fixed],
    sales: [sale],
    purchases: [purchase],
    saleReturns: [saleRet],
    purchaseReturns: [purRet],
    stockAdjustments: [adjAdd, adjCut],
  });
  assert(after.length === 0, "T15: repair is idempotent");

  // A correct book must never be flagged.
  const clean = planStockRepair({
    items: [{ ...item, stock: 100 } as Item],
    sales: [],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    stockAdjustments: [],
  });
  assert(clean.length === 0, "T15: an untouched item reports no drift");
}

/* ═══ TEST 16: a party is never on BOTH sides at once ═══
   The real case from production: JAY MOBILE DABHOLI carried a 9,850 payable
   opening, then bought 11,000 of goods. Their statement said 1,150
   receivable; the dashboard said 9,850 payable AND 11,000 receivable,
   because the two sides were summed independently and never netted. */
{
  const party = { id: "JAY", name: "JAY MOBILE DABHOLI", openingBalance: -9850 };
  const sale = {
    id: "S",
    number: "0002",
    date: "2026-08-15",
    partyId: "JAY",
    partyName: "JAY MOBILE DABHOLI",
    gstEnabled: false,
    lineItems: [],
    subtotal: 11000,
    discount: 0,
    taxAmount: 0,
    total: 11000,
    paid: 0,
    paymentMode: "credit",
    createdAt: "2026-08-15T09:00:00Z",
  } as unknown as Invoice;

  const [pos] = netPartyPositions([party], {
    sales: [sale],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  assert(pos.net === 1150, `T16: net must be 1150 receivable, got ${pos.net}`);

  const receivable = Math.max(0, pos.net);
  const payable = Math.max(0, -pos.net);
  assert(receivable === 1150, "T16: appears in receivable");
  assert(payable === 0, "T16: and NOT in payable — never both");

  // A pure supplier still lands wholly on the payable side.
  const supplier = { id: "SUP", name: "Supplier", openingBalance: -9850 };
  const purchase = {
    id: "P",
    number: "PUR-1",
    date: "2026-08-15",
    partyId: "SUP",
    partyName: "Supplier",
    gstEnabled: false,
    lineItems: [],
    subtotal: 450,
    discount: 0,
    taxAmount: 0,
    total: 450,
    paid: 0,
    paymentMode: "credit",
    createdAt: "2026-08-15T09:00:00Z",
  } as unknown as Invoice;
  const [sp] = netPartyPositions([supplier], {
    sales: [],
    purchases: [purchase],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  assert(sp.net === -10300, `T16: supplier nets to -10300, got ${sp.net}`);

  // And the net must agree with what the party's own statement closes at —
  // the two disagreeing is exactly what the client reported.
  const stmt = buildPartyStatement(party, {
    sales: [sale],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  assert(
    Math.abs(stmt.fullBalance - pos.net) < 0.01,
    `T16: dashboard net (${pos.net}) must equal the statement's closing balance (${stmt.fullBalance})`,
  );

  // Paying a bill off moves the net, and an advance counts once.
  const paidSale = { ...sale, paid: 11000 } as Invoice;
  const [paidPos] = netPartyPositions([party], {
    sales: [paidSale],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  assert(paidPos.net === -9850, "T16: settling the bill leaves just the opening");
}

/* ═══ TEST 17: a stored figure that is not actually a number ═══════════
   Firestore is schemaless: TypeScript says Item.stock is a number, but a
   document can hold the STRING "5" — from an older import, a hand edit, a
   migration. Every screen renders it fine, so it stays invisible until an
   atomic adjustment touches it, and then the local cache and the cloud
   disagree PERMANENTLY:

     local  "5" + 15   → "515"  (JavaScript concatenates)
     cloud  increment  → 15     (Firestore treats a non-number as 0)

   which is how a bulk stock correction can look applied on one screen and
   wrong on the next. Subtraction is worse: "12" - 4 is NaN, stored as null.
   These pin the coercion in Repository.adjustBase. */
{
  const repo = new Repository<{ id: string; stock: number; balance?: number }>("test-adjust");
  const seed = (id: string, stock: unknown) =>
    repo.add({ id, stock } as unknown as { id: string; stock: number });

  seed("A", "5");
  assert(
    repo.adjustField("A", "stock", 15)?.stock === 20,
    "T17: string base adds (not concatenates)",
  );

  seed("B", "12");
  assert(repo.adjustField("B", "stock", -4)?.stock === 8, "T17: string base subtracts (not NaN)");

  seed("C", 5);
  assert(repo.adjustField("C", "stock", 15)?.stock === 20, "T17: a real number is unaffected");

  // A MISSING field keeps working the way Firestore's increment does: base 0.
  seed("D", undefined);
  assert(repo.adjustField("D", "stock", 7)?.stock === 7, "T17: a missing field bases at zero");

  // Junk that cannot be a number at all must not poison the record with NaN.
  seed("E", "abc");
  assert(repo.adjustField("E", "stock", 3)?.stock === 3, "T17: unparseable text bases at zero");

  // Rounding still applies through the coercion.
  seed("F", "2.005");
  assert(
    repo.adjustField("F", "stock", 0)?.stock === 2.01,
    "T17: coerced values still round to 2dp",
  );

  // Repeated adjustments must stay stable once healed.
  seed("G", "10");
  repo.adjustField("G", "stock", 5);
  assert(repo.adjustField("G", "stock", 5)?.stock === 20, "T17: the healed field keeps adding");
}

/* ═══ TEST 18: the repair planner must SEE a malformed stock ══════════
   A string "5" that happens to equal the correct figure produced a delta of
   zero, so Fix Calculations skipped it and the field stayed a string —
   waiting to corrupt itself on the next adjustment. It has to be reported so
   the repair rewrites it as a real number. */
{
  const mkItem = (id: string, stock: unknown, openingStock: unknown): Item =>
    ({
      id,
      name: `Item ${id}`,
      unit: "pcs",
      gstRate: 0,
      purchasePrice: 0,
      salePrice: 0,
      stock,
      openingStock,
      createdAt: "",
    }) as unknown as Item;
  const empty = {
    sales: [],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    stockAdjustments: [],
  };

  const rightValueWrongType = planStockRepair({ ...empty, items: [mkItem("X", "5", 5)] });
  assert(
    rightValueWrongType.length === 1 && rightValueWrongType[0].correct === 5,
    "T18: a string stock is reported even when it reads as the right number",
  );

  const genuinelyFine = planStockRepair({ ...empty, items: [mkItem("Y", 5, 5)] });
  assert(genuinelyFine.length === 0, "T18: a correct numeric stock is still left alone");

  // And the planner's own arithmetic must not concatenate string quantities.
  const withStringQty = planStockRepair({
    ...empty,
    items: [mkItem("Z", 10, 10)],
    stockAdjustments: [
      {
        id: "a1",
        itemId: "Z",
        itemName: "Item Z",
        date: "2026-01-01",
        type: "add",
        qty: "5",
        reason: "",
        createdAt: "",
      } as unknown as StockAdjustment,
    ],
  });
  assert(
    withStringQty.length === 1 && withStringQty[0].correct === 15,
    `T18: a string qty adds as 5, not "105" — got ${withStringQty[0]?.correct}`,
  );
}

/* ═══ TEST 20: one amount, spread oldest bill first ═══════════════════
   The counter takes a round figure off a customer's whole account; they do
   not think in invoices. spreadFifo turns that into allocations, and the
   rules it has to hold to are: oldest first (so an ageing report means
   something), cash before discount ON THE SAME BILL (so the everyday
   "20,000 and knock off the 500" closes it in one step), never settle more
   than a bill owes, and leave the remainder for the caller to record as an
   advance rather than losing it. */
{
  const sum = (a: { apply: number; discount: number }[], k: "apply" | "discount") =>
    Math.round(a.reduce((s, x) => s + x[k], 0) * 100) / 100;

  // The client's own example, as a single bill.
  const one = spreadFifo([20500], 20000, 500);
  assert(
    one[0].apply === 20000 && one[0].discount === 500,
    "T20: 20,000 + 500 off closes a 20,500 bill",
  );

  // Oldest first: the first bill closes before the second sees a rupee.
  const two = spreadFifo([10000, 10500], 15000, 0);
  assert(
    two[0].apply === 10000 && two[1].apply === 5000,
    `T20: the oldest bill is settled first — got ${JSON.stringify(two)}`,
  );

  // The discount follows the cash onto the bill the cash left short.
  const withDisc = spreadFifo([10000, 10500], 20000, 500);
  assert(
    withDisc[0].apply === 10000 &&
      withDisc[0].discount === 0 &&
      withDisc[1].apply === 10000 &&
      withDisc[1].discount === 500,
    `T20: the write-off closes the bill the cash fell short on — got ${JSON.stringify(withDisc)}`,
  );

  // Never over-settle: paying more than is owed leaves the surplus behind
  // for the caller to record as an advance.
  const over = spreadFifo([1000, 500], 5000, 0);
  assert(
    sum(over, "apply") === 1500,
    `T20: a bill is never over-settled — got ${sum(over, "apply")}`,
  );
  assert(
    over.every((r) => r.apply >= 0 && r.discount >= 0),
    "T20: no negative allocation",
  );

  // A discount bigger than the debt is not silently applied either.
  const bigDisc = spreadFifo([300], 0, 1000);
  assert(
    bigDisc[0].discount === 300,
    `T20: the write-off is capped at the due — got ${bigDisc[0].discount}`,
  );

  // Nothing to pay, nothing allocated.
  assert(
    spreadFifo([1000], 0, 0).every((r) => r.apply === 0 && r.discount === 0),
    "T20: zero pays nothing",
  );
  assert(spreadFifo([], 500, 0).length === 0, "T20: no bills, nothing to spread");

  // Negative or junk input must not create money.
  assert(spreadFifo([1000], -50, 0)[0].apply === 0, "T20: a negative amount pays nothing");
  assert(spreadFifo([-1000], 500, 0)[0].apply === 0, "T20: a negative due absorbs nothing");

  // Paise: three bills settled by a total that divides unevenly must still
  // add up to exactly what was handed over, with no drift.
  const paise = spreadFifo([33.33, 33.33, 33.34], 100, 0);
  assert(
    sum(paise, "apply") === 100,
    `T20: paise add back to the amount taken — got ${sum(paise, "apply")}`,
  );

  // Randomised: the invariants above must hold for any shape of account.
  let seed = 4242;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 2000; i++) {
    const dues = Array.from(
      { length: 1 + Math.floor(rnd() * 6) },
      () => Math.round(rnd() * 500000) / 100,
    );
    const cash = Math.round(rnd() * 600000) / 100;
    const disc = Math.round(rnd() * 20000) / 100;
    const out = spreadFifo(dues, cash, disc);
    const owed = Math.round(dues.reduce((s, d) => s + d, 0) * 100) / 100;
    assert(sum(out, "apply") <= cash + 0.005, "T20: never allocates more cash than was taken");
    assert(sum(out, "discount") <= disc + 0.005, "T20: never writes off more than allowed");
    assert(
      Math.round((sum(out, "apply") + sum(out, "discount")) * 100) / 100 <= owed + 0.005,
      "T20: never settles more than the account owes",
    );
    out.forEach((r, j) =>
      assert(
        Math.round((r.apply + r.discount) * 100) / 100 <= dues[j] + 0.005,
        "T20: never settles more than the bill owes",
      ),
    );
    // FIFO: a bill can only be partly settled if every bill before it is closed.
    for (let j = 1; j < out.length; j++) {
      const prevSettled = Math.round((out[j - 1].apply + out[j - 1].discount) * 100) / 100;
      if (out[j].apply + out[j].discount > 0.005) {
        assert(
          prevSettled >= dues[j - 1] - 0.005,
          "T20: no bill is skipped over an open older one",
        );
      }
    }
  }
}

/* ═══ TEST 21: a payment belongs on the day it happened ═══════════════
   The statement used to credit a bill's whole `paid` against the BILL's date,
   and then drop the payment row entirely whenever it had been fully applied.
   So money taken three weeks after a sale appeared on the sale's line, while
   an unapplied advance got a line of its own — the same act of taking money
   showing up in two different places depending on how it was allocated. That
   is the "sometimes up, sometimes at the bottom" the client reported.

   The split must be presentation only: the closing balance has to come out
   identical, which is what makes this safe to change on live books. */
{
  const party = { id: "LP", name: "Ledger Party", openingBalance: 0 };
  const bill = {
    id: "LB1",
    number: "INV-L1",
    date: "2026-03-01",
    partyId: "LP",
    partyName: "Ledger Party",
    lineItems: [],
    subtotal: 20500,
    discount: 0,
    shippingCharge: 0,
    taxAmount: 0,
    total: 20500,
    // 20,000 cash + a 500 write-off, both applied by the payment below.
    paid: 20500,
    paymentMode: "credit",
    createdAt: "2026-03-01T00:00:00Z",
  } as unknown as Invoice;
  const pay = {
    id: "LPAY",
    date: "2026-03-21",
    partyId: "LP",
    partyName: "Ledger Party",
    type: "in",
    amount: 20000,
    mode: "cash",
    allocations: [{ invoiceId: "LB1", number: "INV-L1", amount: 20000, discount: 500 }],
    createdAt: "2026-03-21T00:00:00Z",
  } as unknown as Payment;

  const { rows, fullBalance } = buildPartyStatement(party, {
    sales: [bill],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [pay],
  });

  const saleRow = rows.find((r) => r.ref === "INV-L1" && r.type === "Sale");
  assert(!!saleRow, "T21: the sale is on the statement");
  assert(
    saleRow?.receivedOrPaid === 0,
    `T21: the bill's own line shows only what was taken THAT DAY — got ${saleRow?.receivedOrPaid}`,
  );

  const payRow = rows.find((r) => r.type === "Payment Received");
  assert(!!payRow, "T21: a fully-applied payment still gets its own row");
  assert(
    payRow?.date === "2026-03-21" && payRow?.total === 20000,
    `T21: the payment sits on ITS date for the cash actually taken — got ${payRow?.date} / ${payRow?.total}`,
  );
  assert(
    payRow?.ref === "INV-L1",
    `T21: and says which bill it settled — got ${JSON.stringify(payRow?.ref)}`,
  );

  const discRow = rows.find((r) => r.type === "Discount Given");
  assert(!!discRow, "T21: the write-off is its own line, not silent");
  assert(
    discRow?.date === "2026-03-21" && discRow?.total === 500,
    `T21: the write-off is dated with the payment — got ${discRow?.date} / ${discRow?.total}`,
  );

  // The whole point: presentation changed, arithmetic did not.
  assert(fullBalance === 0, `T21: the bill is fully settled — closing ${fullBalance}`);
  const [netPos] = netPartyPositions([party], {
    sales: [bill],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [pay],
  });
  assert(
    Math.abs(netPos.net - fullBalance) < 0.01,
    `T21: the statement still agrees with the dashboard — ${netPos.net} vs ${fullBalance}`,
  );

  // Cash taken AT the counter still belongs on the bill's own date: it really
  // did happen then, and there is no payment record to carry it.
  const counterBill = { ...bill, id: "LB2", number: "INV-L2", paid: 400, total: 1000 } as Invoice;
  const counter = buildPartyStatement(party, {
    sales: [counterBill],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  const counterRow = counter.rows.find((r) => r.ref === "INV-L2");
  assert(
    counterRow?.receivedOrPaid === 400,
    `T21: money taken at billing stays on the bill's line — got ${counterRow?.receivedOrPaid}`,
  );
  assert(counter.fullBalance === 600, `T21: leaving 600 owed — got ${counter.fullBalance}`);

  // An advance that settles nothing keeps behaving as it always did.
  const advance = { ...pay, id: "LADV", amount: 300, allocations: undefined } as Payment;
  const withAdvance = buildPartyStatement(party, {
    sales: [],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [advance],
  });
  assert(
    withAdvance.fullBalance === -300,
    `T21: an unapplied advance still credits the party — got ${withAdvance.fullBalance}`,
  );
  assert(
    withAdvance.rows.filter((r) => r.type === "Payment Received").length === 1,
    "T21: and appears exactly once",
  );
}

/* ═══ TEST 22: recognising both legs of a transfer ════════════════════
   A transfer writes two records, one per account, and they have to be edited
   and deleted as one thing. Newer ones carry a shared id. OLDER ones do not,
   and they are the dangerous case: unrecognised, the Cash page treats the
   cash side as an ordinary manual entry and offers to EDIT it — which would
   move the cash and leave the bank account saying something else. The client
   was shown exactly that dialog. */
{
  const leg = (over: Partial<BankTxn>): BankTxn =>
    ({
      id: "bt" + Math.round((over.amount ?? 0) * 100),
      bankId: "B1",
      date: "2026-08-22",
      type: "deposit",
      amount: 2000,
      notes: "Transfer to K CASH — PIYUSH BHAI VALA",
      createdAt: "",
      ...over,
    }) as BankTxn;
  const cash = (over: Partial<CashAdjustment>): CashAdjustment =>
    ({
      id: "ca1",
      date: "2026-08-22",
      type: "reduce",
      amount: 2000,
      reason: "Transfer to K CASH — PIYUSH BHAI VALA",
      createdAt: "",
      ...over,
    }) as CashAdjustment;

  // The new way: a shared id, and nothing else needs to match.
  assert(
    transferLegsFor(cash({ transferId: "T1" }), [leg({ transferId: "T1", notes: "anything" })])
      .length === 1,
    "T22: a stamped pair is found by its id",
  );

  // The old way: same note, same date, same amount, opposite directions.
  assert(
    transferLegsFor(cash({}), [leg({})]).length === 1,
    "T22: an UNSTAMPED pair is still recognised by note + date + amount",
  );

  // Each of those four has to agree. Any one off and it is not a partner.
  assert(
    transferLegsFor(cash({}), [leg({ amount: 2001 })]).length === 0,
    "T22: a different amount is not the partner",
  );
  assert(
    transferLegsFor(cash({}), [leg({ date: "2026-08-23" })]).length === 0,
    "T22: a different date is not the partner",
  );
  assert(
    transferLegsFor(cash({}), [leg({ notes: "Transfer to somewhere else" })]).length === 0,
    "T22: a different note is not the partner",
  );
  // Direction: cash OUT pairs with money INTO a bank, never out of one.
  assert(
    transferLegsFor(cash({}), [leg({ type: "withdraw" })]).length === 0,
    "T22: both legs going the same way is not a transfer",
  );
  assert(
    transferLegsFor(cash({ type: "add" }), [leg({ type: "withdraw" })]).length === 1,
    "T22: cash IN pairs with money out of a bank",
  );

  // A manual entry that merely mentions a transfer stays editable — there is
  // no partner for it to fall out of step with.
  assert(
    transferLegsFor(cash({ reason: "Transfer to K CASH — PIYUSH BHAI VALA" }), []).length === 0,
    "T22: no partner found means it is an ordinary entry",
  );
  assert(
    transferLegsFor(cash({ reason: "Cash added, transferred from the shop till" }), [leg({})])
      .length === 0,
    "T22: a note that only mentions transferring is not a transfer leg",
  );
  assert(
    transferLegsFor(cash({ reason: undefined }), [leg({ notes: undefined })]).length === 0,
    "T22: an entry with no note is never paired by note",
  );
}

/* ═══ TEST 23: every write says who made it, and deletions survive ════
   Several staff have edit and delete rights. Before this, "what happened to
   invoice 0047" had no answer: the row was simply not there any more, and
   nothing recorded who changed an amount either. Stamped centrally in
   Repository rather than at each call site, because the call site that
   forgets is exactly the record you later need to account for. */
{
  interface Row {
    id: string;
    name: string;
    total: number;
    createdAt: string;
    createdBy?: string;
    updatedAt?: string;
    updatedBy?: string;
  }
  const repo = new Repository<Row>("test-audited");

  const made = repo.add({ name: "First", total: 100 } as Row);
  assert(
    made.createdBy === "test@shop.local",
    `T23: a new record records its author — ${made.createdBy}`,
  );
  assert(!!made.createdAt, "T23: and when it was made");
  assert(!made.updatedAt, "T23: an untouched record has no update stamp");

  const edited = repo.update(made.id, { total: 150 });
  assert(
    edited?.updatedBy === "test@shop.local",
    `T23: an edit records who made it — ${edited?.updatedBy}`,
  );
  assert(!!edited?.updatedAt, "T23: and when");
  assert(
    edited?.createdBy === "test@shop.local" && edited?.createdAt === made.createdAt,
    "T23: without disturbing who created it",
  );

  // An atomic field change is an edit too — this is the path every bill takes
  // when it moves an item's stock, and it was the one most likely to be missed.
  //
  // Measured on a FRESH record, so the ABSENCE of a stamp is what the
  // assertion turns on. Two earlier attempts were blind: checking that
  // updatedBy exists passed even unstamped, because the record already carried
  // one from the update() above and the merge spreads what is there; and
  // comparing the timestamp before and after does not work either, because
  // both writes land in the same millisecond.
  const untouched = repo.add({ name: "Adjust me", total: 10 } as Row);
  assert(!untouched.updatedAt, "T23: a fresh record has no edit stamp");
  const nudged = repo.adjustField(untouched.id, "total", 25);
  assert(nudged?.total === 35, `T23: the adjustment still applies — ${nudged?.total}`);
  assert(
    nudged?.updatedBy === "test@shop.local" && !!nudged?.updatedAt,
    `T23: an atomic adjust counts as an edit — by ${nudged?.updatedBy}, at ${nudged?.updatedAt}`,
  );

  // A BATCHED delete is the path every bill, payment and return actually
  // takes; only the direct remove() was covered, so the batched one could stop
  // recording anything and no test would notice.
  const batchedRow = repo.add({ name: "Batched", total: 40 } as Row);
  const beforeBatched = AuditLogRepo.all().length;
  repo.removeBatched(null, batchedRow.id);
  assert(!repo.get(batchedRow.id), "T23: a batched delete removes the record");
  assert(
    AuditLogRepo.all().length === beforeBatched + 1,
    `T23: and is written down like any other — ${AuditLogRepo.all().length - beforeBatched}`,
  );
  assert(
    AuditLogRepo.all().some((e) => e.recordId === batchedRow.id),
    "T23: findable by the id of the batched-deleted record",
  );

  // Deleting: the record goes, the account of it does not.
  const before = AuditLogRepo.all().length;
  repo.remove(made.id);
  assert(!repo.get(made.id), "T23: the record is gone");
  const log = AuditLogRepo.all();
  assert(
    log.length === before + 1,
    `T23: a deletion is written down — ${log.length - before} entries`,
  );
  const entry = log.find((e) => e.recordId === made.id);
  assert(!!entry, "T23: and can be found by the id of what was deleted");
  assert(
    entry?.collection === "test-audited",
    `T23: it names the collection — ${entry?.collection}`,
  );
  assert(
    (entry?.snapshot as Row | undefined)?.total === 150,
    `T23: it keeps WHAT was deleted, as it stood — ${JSON.stringify(entry?.snapshot)}`,
  );
  assert(
    (entry?.summary ?? "").includes("First"),
    `T23: with a line a person can read — ${entry?.summary}`,
  );

  // The log must never audit itself, or clearing one entry writes another.
  const auditCount = AuditLogRepo.all().length;
  const first = AuditLogRepo.all()[0];
  // Guarded: with the deletion log broken there are no entries at all, and
  // reading [0].id crashed the run instead of reporting the failure.
  assert(!!first, "T23: there is a log entry to clear");
  if (first) {
    AuditLogRepo.remove(first.id);
    assert(
      AuditLogRepo.all().length === auditCount - 1,
      "T23: removing a log entry does not write a log entry about it",
    );
  }
}

/* ═══ TEST 24: a closed period stays closed ═══════════════════════════
   Once GSTR-1 and 3B are filed for a month, that month is a statement made to
   the tax authority. A bill inside it that can still be edited — or deleted —
   means the books stop matching the filed return, and nobody finds out until
   a notice arrives. Dates are ISO, which sort lexically, so the comparison is
   a string compare; these pin the boundary and the both-dates rule. */
{
  const LOCK = "2026-07-31";

  assert(isLocked("2026-07-15", LOCK), "T24: a date inside the closed period is locked");
  assert(isLocked("2026-07-31", LOCK), "T24: the boundary day itself is INSIDE the lock");
  assert(!isLocked("2026-08-01", LOCK), "T24: the day after is open");
  assert(!isLocked("2026-07-15", undefined), "T24: with no lock set, nothing is locked");
  assert(!isLocked(undefined, LOCK), "T24: a record with no date cannot be judged, so it passes");

  // An EDIT has two dates that matter. Checking only the new one would let a
  // bill be dragged OUT of a closed month; checking only the old one would let
  // a new bill be posted INTO one. Both, always.
  assert(
    blockedDate(["2026-08-05", "2026-07-20"], LOCK) === "2026-07-20",
    "T24: moving a record OUT of a closed period is refused",
  );
  assert(
    blockedDate(["2026-07-20", "2026-08-05"], LOCK) === "2026-07-20",
    "T24: and posting INTO one is refused",
  );
  assert(
    blockedDate(["2026-08-05", "2026-08-09"], LOCK) === null,
    "T24: two open dates are allowed",
  );
  assert(
    blockedDate(["2026-08-05", undefined], LOCK) === null,
    "T24: a missing second date (a new record) is not a reason to refuse",
  );
  assert(
    blockedDate([], LOCK) === null && blockedDate(["2026-07-01"], undefined) === null,
    "T24: nothing to check, or nothing locked, means allowed",
  );
  assert(
    lockMessage("2026-07-20", LOCK).includes(LOCK),
    "T24: the refusal says what it is locked to",
  );
}

/* ═══ TEST 25: voucher references ═════════════════════════════════════
   Cash and bank entries had no reference at all — nothing to quote on a slip,
   nothing to search for, nothing to point at in a dispute. Same numbering
   rule as invoice numbers, and for the same reason: read the trailing digits
   rather than stripping the current prefix, so a number issued under an older
   prefix is still visible to the max() and cannot be reissued. */
{
  assert(nextVoucherNo("CV-", []) === "CV-0001", "T25: the first reference in a series");
  assert(
    nextVoucherNo("CV-", [{ voucherNo: "CV-0001" }, { voucherNo: "CV-0002" }]) === "CV-0003",
    "T25: then the next",
  );
  assert(
    nextVoucherNo("CV-", [{ voucherNo: "CV-0009" }, { voucherNo: "CV-0002" }]) === "CV-0010",
    "T25: the HIGHEST so far, not the count — a deleted entry must not be reissued",
  );
  assert(
    nextVoucherNo("CV-", [{ voucherNo: "OLD-0042" }]) === "CV-0043",
    "T25: a number under an older prefix is still counted",
  );
  assert(
    nextVoucherNo("CV-", [{}, { voucherNo: undefined }, { voucherNo: "CV-0004" }]) === "CV-0005",
    "T25: entries from before references existed are skipped, not treated as zero",
  );
  assert(nextVoucherNo("TR-", []) === "TR-0001", "T25: each series numbers independently");
}

/* ═══ TEST 26: cash that says why it moved ════════════════════════════
   "CASH ADD TILL TODAY FROM VYAPAR ₹29,000" is real money in the drawer with
   nothing saying whether the shop earned it, the owner put it in, or it was
   carried over from the old system — so the P&L absorbs it as profit and that
   month is wrong by ₹29,000 with nothing on screen to say so. Every
   accounting system answers this the same way: the movement has a second
   side, and the second side is an account. */
{
  // The choosable set must not offer the one the app writes for itself: a
  // transfer's other side is a real account, and claiming "transfer" from the
  // adjust screen would be a lie about where the money went.
  assert(
    CHOOSABLE_PURPOSES.every((p) => p.key !== "transfer"),
    "T26: 'transfer' is never offered as a reason to pick",
  );
  assert(CHOOSABLE_PURPOSES.length >= 4, "T26: there are real choices to make");
  assert(
    CASH_PURPOSES.every((p) => !!p.account),
    "T26: every reason names the account it will post to — the mapping cannot drift",
  );

  // Direction follows the reason where only one direction makes sense, so the
  // shopkeeper is not asked the same question twice.
  assert(
    purposeSpec("owner-out")?.direction === "reduce",
    "T26: the owner taking money out is cash OUT",
  );
  assert(
    purposeSpec("owner-in")?.direction === "add",
    "T26: the owner putting money in is cash IN",
  );
  assert(purposeSpec("opening")?.direction === "add", "T26: an opening balance is cash IN");
  assert(!purposeSpec("short-over")?.direction, "T26: a counting difference can go either way");
  assert(!purposeSpec("other")?.direction, "T26: and so can anything else");

  // An entry from before this was asked says so, rather than being guessed at.
  assert(purposeLabel(undefined) === "Uncategorised", "T26: an older entry reads as uncategorised");
  assert(purposeLabel("nonsense-key") === "Uncategorised", "T26: and so does an unknown value");
  assert(purposeLabel("owner-out") === "Owner took out", "T26: a known one reads in plain words");

  /* The summary: signed, so the figures read the way the drawer moved, and
     the uncategorised total is kept SEPARATE rather than folded into
     "something else" — how much is unaccounted for is the number that
     matters most on this screen. */
  const totals = totalsByPurpose([
    { purpose: "owner-in", type: "add", amount: 5000 },
    { purpose: "owner-out", type: "reduce", amount: 2000 },
    { purpose: "owner-out", type: "reduce", amount: 500 },
    { purpose: undefined, type: "add", amount: 29000 },
  ]);
  const by = (k: string) => totals.find((t) => t.key === k);
  assert(by("owner-in")?.net === 5000, `T26: money in is positive — ${by("owner-in")?.net}`);
  assert(
    by("owner-out")?.net === -2500,
    `T26: money out is negative and adds up — ${by("owner-out")?.net}`,
  );
  assert(by("owner-out")?.count === 2, "T26: and counts the entries behind it");
  assert(
    by("uncategorised")?.net === 29000,
    `T26: unexplained cash is its own line — ${by("uncategorised")?.net}`,
  );
  assert(
    !by("other"),
    "T26: unexplained cash is NOT quietly counted as 'something else' — that would hide it",
  );
  assert(totals[0].key === "uncategorised", "T26: and the biggest movement leads");
  assert(totalsByPurpose([]).length === 0, "T26: nothing in, nothing out");

  // Paise survive the summing.
  const paise = totalsByPurpose([
    { purpose: "short-over", type: "add", amount: 0.05 },
    { purpose: "short-over", type: "reduce", amount: 0.02 },
  ]);
  assert(paise[0].net === 0.03, `T26: paise add up exactly — ${paise[0].net}`);
}

/* ═══ TEST 27: the posting ledger, and proof it agrees with the app ═════
   The whole case for a ledger is that there is ONE answer to read. That is
   worth nothing unless the one answer matches the answers the shop has been
   running its business on — so every assertion below compares the posting
   rules against an independently written calculation: netPartyPositions,
   cashFlows, bankFlows, the stored bank balances, and the P&L the Reports
   screen prints. None of them share code with lib/posting.ts, so agreement
   is evidence rather than a tautology. */
{
  const emptyBook = (): Book => ({
    parties: [],
    items: [],
    banks: [],
    sales: [],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
    expenses: [],
    cashAdjustments: [],
    bankTxns: [],
    stockAdjustments: [],
  });

  /* ── The rules, one at a time, with numbers worked out by hand ────────
     A randomised sweep follows, but a sweep only proves self-consistency:
     if a rule is wrong in the same way everywhere, every invariant still
     holds. These are the individual postings, checked against arithmetic
     done outside the code. */

  // A GST sale, part paid in cash at the counter, with freight and a
  // round-off — every component of a bill total in one document.
  {
    const b = emptyBook();
    b.items.push({ id: "I1", name: "Item", purchasePrice: 100, openingStock: 0 } as never);
    b.parties.push({ id: "P1", name: "Cust", openingBalance: 0, createdAt: "" } as never);
    b.sales.push({
      id: "S1",
      number: "INV-1",
      date: "2026-04-01",
      partyId: "P1",
      partyName: "Cust",
      gstEnabled: true,
      lineItems: [{ itemId: "I1", qty: 2, price: 1000, costPrice: 100 }],
      subtotal: 2000,
      discount: 0,
      shippingCharge: 50,
      taxAmount: 360,
      roundOff: -0.4,
      total: 2409.6,
      paid: 409.6,
      paymentMode: "cash",
      createdAt: "",
    } as never);

    const [je] = buildJournal(b).filter((e) => e.docKind === "sale");
    const amt = (accountId: string, side: "debit" | "credit") =>
      r2(je.lines.filter((l) => l.accountId === accountId).reduce((s, l) => s + l[side], 0));
    assert(isBalanced(je), `T27: a sale entry balances — out by ${entryDrift(je)}`);
    assert(
      amt("ar", "debit") === 2409.6,
      `T27: the customer owes the bill total — ${amt("ar", "debit")}`,
    );
    assert(
      amt("sales", "credit") === 2000,
      `T27: revenue is the taxable value only — ${amt("sales", "credit")}`,
    );
    assert(
      amt("output-gst", "credit") === 360,
      `T27: GST collected is a liability, never revenue — ${amt("output-gst", "credit")}`,
    );
    assert(
      amt("freight-income", "credit") === 50,
      `T27: freight charged is its own income line — ${amt("freight-income", "credit")}`,
    );
    // −0.40 credit is not a thing a ledger prints; it is a 0.40 debit.
    assert(
      amt("round-off", "debit") === 0.4 && amt("round-off", "credit") === 0,
      `T27: a negative round-off posts as a debit — dr ${amt("round-off", "debit")} cr ${amt("round-off", "credit")}`,
    );
    assert(
      amt("cash", "debit") === 409.6 && amt("ar", "credit") === 409.6,
      "T27: cash taken at the counter clears that much of the receivable",
    );
    assert(
      amt("cogs", "debit") === 200 && amt("inventory", "credit") === 200,
      `T27: the goods leave stock at cost — ${amt("cogs", "debit")}`,
    );
  }

  /* A settlement discount. Collecting 20,000 against a 20,500 bill and
     waiving 500 closes the bill without inventing 500 of cash — the mistake
     that would show up as phantom money in the drawer. */
  {
    const b = emptyBook();
    b.parties.push({ id: "P1", name: "Cust", openingBalance: 0, createdAt: "" } as never);
    b.sales.push({
      id: "S1",
      number: "INV-1",
      date: "2026-04-01",
      partyId: "P1",
      partyName: "Cust",
      lineItems: [],
      subtotal: 20500,
      discount: 0,
      taxAmount: 0,
      total: 20500,
      paid: 20500,
      paymentMode: "credit",
      createdAt: "",
    } as never);
    b.payments.push({
      id: "PAY1",
      date: "2026-04-21",
      partyId: "P1",
      partyName: "Cust",
      type: "in",
      amount: 20000,
      mode: "cash",
      allocations: [{ invoiceId: "S1", number: "INV-1", amount: 20000, discount: 500 }],
      createdAt: "",
    } as never);

    const entries = buildJournal(b);
    assert(entries.every(isBalanced), "T27: a discounted settlement balances");
    assert(
      balanceOf(entries, "cash") === 20000,
      `T27: only the money actually taken reaches cash — ${balanceOf(entries, "cash")}`,
    );
    assert(
      balanceOf(entries, "discount-allowed") === 500,
      `T27: the waived 500 is a cost, not cash — ${balanceOf(entries, "discount-allowed")}`,
    );
    assert(
      balanceOf(entries, "ar") === 0,
      `T27: and the bill is closed — receivable ${balanceOf(entries, "ar")}`,
    );
    assert(
      balanceOf(entries, "suspense") === 0,
      "T27: the credit-mode bill's own 'paid' was all settled by the payment, so nothing is left unexplained",
    );
  }

  /* Money recorded as paid on a Credit bill with no payment behind it. The
     app reduces what the party owes but the money reaches no cash or bank
     position anywhere — so it must land somewhere visible instead of
     vanishing, or the ledger would not balance and nobody would know why. */
  {
    const b = emptyBook();
    b.parties.push({ id: "P1", name: "Cust", openingBalance: 0, createdAt: "" } as never);
    b.sales.push({
      id: "S1",
      number: "INV-1",
      date: "2026-04-01",
      partyId: "P1",
      partyName: "Cust",
      lineItems: [],
      subtotal: 1000,
      discount: 0,
      taxAmount: 0,
      total: 1000,
      paid: 400,
      paymentMode: "credit",
      createdAt: "",
    } as never);
    const entries = buildJournal(b);
    assert(entries.every(isBalanced), "T27: it still balances");
    /* A DEBIT of 400: the bill says money arrived, so something the shop owns
       went up — which thing is what is missing. That is what Suspense is, and
       it is why it sits with the assets rather than reading as a negative
       liability. */
    assert(
      balanceOf(entries, "suspense") === 400,
      `T27: money paid with no mode named sits in Suspense — ${balanceOf(entries, "suspense")}`,
    );
    assert(balanceOf(entries, "cash") === 0, "T27: and is NOT counted as cash the shop has");
  }

  /* Receivable and Payable are separate accounts, and must stay separate.
     Every check above works from ONE net figure per party, which is what the
     dashboard needs — and that number is identical whether a purchase posts
     to Payable or to Receivable, so none of them would notice the swap. A
     balance sheet would: it has to show what the shop is owed and what it
     owes side by side, gross, not one line that happens to net out. */
  {
    const b = emptyBook();
    b.parties.push({ id: "P1", name: "Supplier", openingBalance: 0, createdAt: "" } as never);
    b.purchases.push({
      id: "PB1",
      number: "PB-1",
      date: "2026-04-01",
      partyId: "P1",
      partyName: "Supplier",
      lineItems: [],
      subtotal: 8000,
      discount: 0,
      taxAmount: 0,
      total: 8000,
      paid: 3000,
      paymentMode: "cash",
      createdAt: "",
    } as never);
    const entries = buildJournal(b);
    assert(
      balanceOf(entries, "ar") === 0,
      `T27: a purchase never touches Receivable — ${balanceOf(entries, "ar")}`,
    );
    assert(
      balanceOf(entries, "ap") === -5000,
      `T27: it is a payable, and the 3,000 paid reduced it — ${balanceOf(entries, "ap")}`,
    );

    // The same party trading both ways: each side stays on its own account,
    // and the net the dashboard reads is the sum of the two.
    b.sales.push({
      id: "S1",
      number: "INV-1",
      date: "2026-04-02",
      partyId: "P1",
      partyName: "Supplier",
      lineItems: [],
      subtotal: 6000,
      discount: 0,
      taxAmount: 0,
      total: 6000,
      paid: 0,
      paymentMode: "credit",
      createdAt: "",
    } as never);
    const both = buildJournal(b);
    assert(
      balanceOf(both, "ar") === 6000 && balanceOf(both, "ap") === -5000,
      `T27: both sides shown gross — receivable ${balanceOf(both, "ar")}, payable ${balanceOf(both, "ap")}`,
    );
    assert(
      partyPositionsFromLedger(both).get("P1") === 1000,
      `T27: and the party's own position is the net of them — ${partyPositionsFromLedger(both).get("P1")}`,
    );
  }

  /* An imported bill that says it carries no GST but still has a tax figure
     sitting in the field — real, and what valueExTax's own guard exists for.
     If the posting rules trusted that field, revenue would be understated by a
     tax the shop never charged, and the P&L would disagree with the ledger by
     exactly that amount. */
  {
    const b = emptyBook();
    b.parties.push({ id: "P1", name: "Cust", openingBalance: 0, createdAt: "" } as never);
    b.sales.push({
      id: "S1",
      number: "INV-1",
      date: "2026-04-01",
      partyId: "P1",
      partyName: "Cust",
      gstEnabled: false,
      lineItems: [],
      subtotal: 5000,
      discount: 0,
      // Left behind by whatever exported it. The bill total does not include
      // it, so none of this is tax.
      taxAmount: 500,
      total: 5000,
      paid: 0,
      paymentMode: "credit",
      createdAt: "",
    } as never);
    const entries = buildJournal(b);
    assert(entries.every(isBalanced), "T27: a bill with a stale tax field still balances");
    assert(
      balanceOf(entries, "output-gst") === 0,
      `T27: a bill marked non-GST posts no GST, whatever its tax field holds — ${balanceOf(entries, "output-gst")}`,
    );
    assert(
      balanceOf(entries, "sales") === -5000,
      `T27: and the whole bill is revenue — ${balanceOf(entries, "sales")}`,
    );
  }

  /* A sale never touches Payable either — the mirror of the check above. */
  {
    const b = emptyBook();
    b.parties.push({ id: "P1", name: "Cust", openingBalance: 0, createdAt: "" } as never);
    b.sales.push({
      id: "S1",
      number: "INV-1",
      date: "2026-04-01",
      partyId: "P1",
      partyName: "Cust",
      lineItems: [],
      subtotal: 4000,
      discount: 0,
      taxAmount: 0,
      total: 4000,
      paid: 0,
      paymentMode: "credit",
      createdAt: "",
    } as never);
    const entries = buildJournal(b);
    assert(
      balanceOf(entries, "ap") === 0 && balanceOf(entries, "ar") === 4000,
      `T27: a sale is a receivable and nothing else — ar ${balanceOf(entries, "ar")}, ap ${balanceOf(entries, "ap")}`,
    );
  }

  /* An advance. Money received against no bill still moves the party, and the
     receivable going into credit is what "we owe them goods" looks like. */
  {
    const b = emptyBook();
    b.parties.push({ id: "P1", name: "Cust", openingBalance: 0, createdAt: "" } as never);
    b.payments.push({
      id: "PAY1",
      date: "2026-04-02",
      partyId: "P1",
      partyName: "Cust",
      type: "in",
      amount: 3000,
      mode: "cash",
      createdAt: "",
    } as never);
    const entries = buildJournal(b);
    assert(
      balanceOf(entries, "cash") === 3000 && balanceOf(entries, "ar") === -3000,
      `T27: an advance is cash in and receivable in credit — ${balanceOf(entries, "ar")}`,
    );
  }

  /* Opening balances. Without these the ledger disagrees with every screen by
     exactly the openings — the first thing a trial balance would show. */
  {
    const b = emptyBook();
    b.parties.push(
      {
        id: "P1",
        name: "Owes us",
        openingBalance: 5000,
        createdAt: "2026-01-01T00:00:00Z",
      } as never,
      {
        id: "P2",
        name: "We owe",
        openingBalance: -2000,
        createdAt: "2026-01-01T00:00:00Z",
      } as never,
    );
    b.banks.push({
      id: "B1",
      name: "Bank",
      openingBalance: 7000,
      balance: 7000,
      createdAt: "2026-01-01T00:00:00Z",
    } as never);
    b.items.push({
      id: "I1",
      name: "Item",
      purchasePrice: 40,
      openingStock: 10,
      createdAt: "2026-01-01T00:00:00Z",
    } as never);

    const entries = buildJournal(b);
    assert(entries.every(isBalanced), "T27: opening entries balance");
    assert(balanceOf(entries, "ar") === 5000, "T27: an opening receivable lands in Receivable");
    assert(balanceOf(entries, "ap") === -2000, "T27: an opening payable lands in Payable");
    assert(
      balanceOf(entries, "bank:B1") === 7000,
      "T27: a bank's opening balance is its own account",
    );
    assert(balanceOf(entries, "inventory") === 400, "T27: opening stock is valued at cost");
    // 5,000 + 7,000 + 400 carried in, less the 2,000 the shop already owed.
    assert(
      balanceOf(entries, "opening-equity") === -10400,
      `T27: and all of it against Opening Balance Equity — ${balanceOf(entries, "opening-equity")}`,
    );
  }

  /* A transfer is ONE voucher. Posting each stored leg on its own would move
     the money out of one account and never into the other — the exact failure
     the leg pairing exists to prevent, reappearing in the ledger. */
  {
    const b = emptyBook();
    b.banks.push({
      id: "B1",
      name: "Bank",
      openingBalance: 0,
      balance: 5000,
      createdAt: "",
    } as never);
    b.cashAdjustments.push({
      id: "CA1",
      date: "2026-04-05",
      type: "reduce",
      amount: 5000,
      reason: "Transfer Cash in Hand → Bank",
      transferId: "TR1",
      createdAt: "",
    } as never);
    b.bankTxns.push({
      id: "BT1",
      bankId: "B1",
      date: "2026-04-05",
      type: "deposit",
      amount: 5000,
      notes: "Transfer Cash in Hand → Bank",
      transferId: "TR1",
      createdAt: "",
    } as never);

    const entries = buildJournal(b);
    assert(
      entries.filter((e) => e.docKind === "transfer").length === 1,
      `T27: a transfer is one entry, not two — got ${entries.filter((e) => e.docKind === "transfer").length}`,
    );
    assert(
      entries.filter((e) => e.docKind === "cash-adjustment").length === 0 &&
        entries.filter((e) => e.docKind === "bank-txn").length === 0,
      "T27: and neither leg is ALSO posted on its own",
    );
    assert(
      balanceOf(entries, "cash") === -5000 && balanceOf(entries, "bank:B1") === 5000,
      `T27: the money left cash and arrived at the bank — cash ${balanceOf(entries, "cash")}, bank ${balanceOf(entries, "bank:B1")}`,
    );
    assert(
      balanceOf(entries, "suspense") === 0,
      "T27: a paired transfer explains itself — nothing goes to Suspense",
    );

    // The same pair as the shop's older records hold it: no transferId on
    // either side, recognised only by the note and the amount.
    const legacy = emptyBook();
    legacy.banks = b.banks;
    legacy.cashAdjustments = [
      { ...b.cashAdjustments[0], id: "CA2", transferId: undefined } as never,
    ];
    legacy.bankTxns = [{ ...b.bankTxns[0], id: "BT2", transferId: undefined } as never];
    const legacyEntries = buildJournal(legacy);
    assert(
      legacyEntries.filter((e) => e.docKind === "transfer").length === 1,
      "T27: an older unstamped pair is still one transfer, not two loose entries",
    );
    assert(
      balanceOf(legacyEntries, "cash") === -5000 && balanceOf(legacyEntries, "bank:B1") === 5000,
      "T27: and it moves the same money the same way",
    );
  }

  /* Phase 1 arriving where it was always headed: a stated reason becomes the
     account the other side of the cash movement posts to. */
  {
    const b = emptyBook();
    b.cashAdjustments.push(
      {
        id: "C1",
        date: "2026-04-01",
        type: "add",
        amount: 29000,
        purpose: "opening",
        createdAt: "",
      } as never,
      {
        id: "C2",
        date: "2026-04-02",
        type: "add",
        amount: 5000,
        purpose: "owner-in",
        createdAt: "",
      } as never,
      {
        id: "C3",
        date: "2026-04-03",
        type: "reduce",
        amount: 2000,
        purpose: "owner-out",
        createdAt: "",
      } as never,
      { id: "C4", date: "2026-04-04", type: "reduce", amount: 100, createdAt: "" } as never,
    );
    const entries = buildJournal(b);
    assert(entries.every(isBalanced), "T27: cash vouchers balance");
    assert(
      balanceOf(entries, "opening-equity") === -29000,
      `T27: the shop's ₹29,000 lands in Opening Balance Equity — ${balanceOf(entries, "opening-equity")}`,
    );
    assert(
      balanceOf(entries, "capital") === -5000,
      "T27: money the owner put in is capital, not profit",
    );
    assert(
      balanceOf(entries, "drawings") === 2000,
      "T27: money the owner took out is drawings, not an expense",
    );
    assert(
      balanceOf(entries, "cash-short-over") === 100,
      `T27: and an entry with no stated reason is visible as unexplained — ${balanceOf(entries, "cash-short-over")}`,
    );
    assert(
      balanceOf(entries, "cash") === 31900,
      `T27: cash in hand is unaffected by which reason was given — ${balanceOf(entries, "cash")}`,
    );
  }

  /* ── The randomised sweep ─────────────────────────────────────────────
     Full books: GST and non-GST bills, part payments, allocations with
     write-offs, advances, both kinds of return, expenses, manual cash,
     deposits, and transfers of all three shapes. The stored bank balance is
     moved exactly as the app moves it, so comparing the ledger against it
     means something. */
  for (let t = 0; t < 150; t++) {
    const book = emptyBook();
    const pid = (n: number) => `p${t}-${n}`;

    const nParties = 2 + ri(4);
    for (let i = 0; i < nParties; i++)
      book.parties.push({
        id: pid(i),
        name: `Party ${i}`,
        type: "both",
        openingBalance: ri(3) === 0 ? r2((rnd() - 0.5) * 20000) : 0,
        createdAt: "2026-01-01T00:00:00Z",
      } as never);

    const nBanks = 1 + ri(2);
    for (let i = 0; i < nBanks; i++) {
      const opening = r2(rnd() * 50000);
      book.banks.push({
        id: `b${t}-${i}`,
        name: `Bank ${i}`,
        openingBalance: opening,
        // The app keeps this as a stored running total; every write below
        // moves it the way the real screens do.
        balance: opening,
        createdAt: "2026-01-01T00:00:00Z",
      } as never);
    }
    const bumpBank = (bankId: string, delta: number) => {
      const acct = book.banks.find((b) => b.id === bankId)!;
      acct.balance = r2(acct.balance + delta);
    };

    for (let i = 0; i < 2 + ri(6); i++)
      book.items.push({
        id: `i${t}-${i}`,
        name: `Item ${i}`,
        unit: "PCS",
        gstRate: pick([0, 5, 12, 18]),
        purchasePrice: r2(10 + rnd() * 500),
        salePrice: 0,
        stock: 0,
        openingStock: ri(2) === 0 ? ri(50) : 0,
        createdAt: "2026-01-01T00:00:00Z",
      } as never);

    /** A bill, built the way InvoiceForm builds one. */
    const makeBill = (kind: "sale" | "purchase", n: number) => {
      const party = pick(book.parties);
      const gst = ri(4) !== 0;
      /* An imported bill that says it carries no GST but still has a tax
         figure sitting in the field. valueExTax guards against exactly this
         ("legacy/imported documents"), so the posting rules have to be fed it
         or that guard is untested — and it was: removing it broke nothing. */
      const staleTax = !gst && ri(3) === 0;
      const lines = Array.from({ length: 1 + ri(3) }, () => {
        const item = pick(book.items);
        const qty = 1 + ri(5);
        const price = r2(20 + rnd() * 800);
        const gstRate = gst ? item.gstRate : 0;
        return {
          id: nid(),
          itemId: item.id,
          name: item.name,
          qty,
          unit: "PCS",
          price,
          discountPct: 0,
          gstRate,
          amount: r2(qty * price),
          costPrice: item.purchasePrice,
        };
      });
      const subtotal = r2(lines.reduce((s, l) => s + l.amount, 0));
      const taxAmount = r2(lines.reduce((s, l) => s + (l.amount * l.gstRate) / 100, 0));
      const discount = ri(4) === 0 ? r2(rnd() * 100) : 0;
      const shippingCharge = kind === "sale" && ri(4) === 0 ? r2(rnd() * 200) : 0;
      const staleTaxAmount = r2(subtotal * 0.18);
      // A non-GST bill total never includes tax, whatever the field holds.
      const raw = r2(subtotal - discount + shippingCharge + (gst ? taxAmount : 0));
      const total = Math.round(raw);
      const roundOff = r2(total - raw);

      const mode = pick(["cash", "bank", "upi", "credit"] as PaymentMode[]);
      const useBankId = mode === "bank" && ri(2) === 0;
      const bankId = useBankId ? pick(book.banks).id : undefined;
      // A bill tied to a bank account has its money on that account's stored
      // balance already, so later payments are never allocated to it — the
      // same shape the app produces, and what makes the bank row comparable.
      const paid = ri(3) === 0 ? total : ri(3) === 0 ? r2(total * rnd()) : 0;

      const bill = {
        id: `${kind[0]}${t}-${n}`,
        number: `${kind === "sale" ? "INV" : "PB"}-${t}-${n}`,
        date: `2026-0${1 + ri(6)}-1${ri(9)}`,
        partyId: party.id,
        partyName: party.name,
        gstEnabled: gst,
        lineItems: lines,
        subtotal,
        discount,
        shippingCharge,
        // The tax field on a non-GST bill: normally 0, and on a stale import
        // whatever the exporting system left in it — which is not zero, and
        // is the entire point of the case.
        taxAmount: gst ? taxAmount : staleTax ? staleTaxAmount : 0,
        roundOff,
        total,
        paid,
        paymentMode: mode,
        ...(bankId ? { bankId, bankPaidAmount: paid } : {}),
        createdAt: "",
      } as unknown as Invoice;

      if (bankId && paid) bumpBank(bankId, kind === "sale" ? paid : -paid);
      return { bill, allocatable: !bankId };
    };

    for (let i = 0; i < 1 + ri(8); i++) {
      const { bill } = makeBill("sale", i);
      book.sales.push(bill);
    }
    for (let i = 0; i < ri(5); i++) {
      const { bill } = makeBill("purchase", i);
      book.purchases.push(bill);
    }

    /* Payments against open bills, some with a write-off, plus pure
       advances. `paid` moves by cash + discount, exactly as payments.tsx
       does, which is what keeps the direct-portion subtraction honest. */
    const settle = (bills: Invoice[], type: "in" | "out") => {
      for (const bill of bills) {
        if (bill.bankId) continue;
        const due = r2(bill.total - bill.paid);
        if (due <= 1 || ri(2)) continue;
        const cash = r2(due * (0.2 + rnd() * 0.6));
        const writeOff = ri(3) === 0 ? r2(Math.min(due - cash, rnd() * 200)) : 0;
        if (cash <= 0) continue;
        bill.paid = r2(bill.paid + cash + writeOff);
        const mode = pick(["cash", "bank", "upi"] as PaymentMode[]);
        const bankId = mode === "bank" && ri(2) === 0 ? pick(book.banks).id : undefined;
        if (bankId) bumpBank(bankId, type === "in" ? cash : -cash);
        book.payments.push({
          id: nid(),
          date: "2026-06-20",
          partyId: bill.partyId,
          partyName: bill.partyName,
          type,
          amount: cash,
          mode,
          ...(bankId ? { bankId } : {}),
          allocations: [
            {
              invoiceId: bill.id,
              number: bill.number,
              amount: cash,
              ...(writeOff ? { discount: writeOff } : {}),
            },
          ],
          createdAt: "",
        } as unknown as Payment);
      }
    };
    settle(book.sales, "in");
    settle(book.purchases, "out");

    for (let i = 0; i < ri(3); i++) {
      const party = pick(book.parties);
      const type = ri(2) ? "in" : "out";
      const amount = r2(100 + rnd() * 5000);
      const mode = pick(["cash", "bank", "upi"] as PaymentMode[]);
      const bankId = mode === "bank" && ri(2) === 0 ? pick(book.banks).id : undefined;
      if (bankId) bumpBank(bankId, type === "in" ? amount : -amount);
      book.payments.push({
        id: nid(),
        date: "2026-06-25",
        partyId: party.id,
        partyName: party.name,
        type,
        amount,
        mode,
        ...(bankId ? { bankId } : {}),
        createdAt: "",
      } as unknown as Payment);
    }

    // Returns, both directions.
    for (const [source, target] of [
      [book.sales, book.saleReturns],
      [book.purchases, book.purchaseReturns],
    ] as const) {
      for (const bill of source) {
        if (ri(5)) continue;
        const total = Math.round(bill.total * 0.2);
        const gst = bill.gstEnabled !== false;
        const taxAmount = gst ? r2(total - total / 1.18) : 0;
        target.push({
          id: nid(),
          number: `RT-${bill.number}`,
          date: "2026-06-28",
          partyId: bill.partyId,
          partyName: bill.partyName,
          gstEnabled: gst,
          lineItems: (bill.lineItems ?? []).slice(0, 1).map((l) => ({ ...l, qty: 1 })),
          subtotal: r2(total - taxAmount),
          taxAmount,
          total,
          createdAt: "",
        } as unknown as Return);
      }
    }

    for (let i = 0; i < ri(5); i++) {
      const amount = r2(50 + rnd() * 3000);
      const mode = pick(["cash", "bank", "upi"] as PaymentMode[]);
      const bankId = mode === "bank" && ri(2) === 0 ? pick(book.banks).id : undefined;
      if (bankId) bumpBank(bankId, -amount);
      book.expenses.push({
        id: nid(),
        date: "2026-06-30",
        category: pick(["Shop Rent", "Salary", "Electricity", "Tea"]),
        amount,
        paymentMode: mode,
        ...(bankId ? { bankId } : {}),
        createdAt: "",
      } as unknown as Expense);
    }

    for (let i = 0; i < ri(4); i++)
      book.cashAdjustments.push({
        id: nid(),
        date: "2026-06-30",
        type: ri(2) ? "add" : "reduce",
        amount: r2(100 + rnd() * 4000),
        purpose: pick(["opening", "owner-in", "owner-out", "short-over", "other", undefined]),
        createdAt: "",
      } as unknown as CashAdjustment);

    // Loose deposits and withdrawals — the ones with no other side recorded.
    for (let i = 0; i < ri(3); i++) {
      const bank = pick(book.banks);
      const type = ri(2) ? "deposit" : "withdraw";
      const amount = r2(100 + rnd() * 8000);
      bumpBank(bank.id, type === "deposit" ? amount : -amount);
      book.bankTxns.push({
        id: nid(),
        bankId: bank.id,
        date: "2026-06-30",
        type,
        amount,
        createdAt: "",
      } as unknown as BankTxn);
    }

    // Cash ↔ bank, and bank ↔ bank when there are two accounts.
    if (ri(2) === 0) {
      const bank = pick(book.banks);
      const amount = r2(500 + rnd() * 9000);
      const toBank = ri(2) === 0;
      const transferId = nid();
      bumpBank(bank.id, toBank ? amount : -amount);
      book.cashAdjustments.push({
        id: nid(),
        date: "2026-07-01",
        type: toBank ? "reduce" : "add",
        amount,
        reason: "Transfer",
        transferId,
        createdAt: "",
      } as unknown as CashAdjustment);
      book.bankTxns.push({
        id: nid(),
        bankId: bank.id,
        date: "2026-07-01",
        type: toBank ? "deposit" : "withdraw",
        amount,
        notes: "Transfer",
        transferId,
        createdAt: "",
      } as unknown as BankTxn);
    }
    if (book.banks.length > 1 && ri(2) === 0) {
      const amount = r2(500 + rnd() * 9000);
      const transferId = nid();
      bumpBank(book.banks[0].id, -amount);
      bumpBank(book.banks[1].id, amount);
      book.bankTxns.push(
        {
          id: nid(),
          bankId: book.banks[0].id,
          date: "2026-07-02",
          type: "withdraw",
          amount,
          notes: "Transfer",
          transferId,
          createdAt: "",
        } as unknown as BankTxn,
        {
          id: nid(),
          bankId: book.banks[1].id,
          date: "2026-07-02",
          type: "deposit",
          amount,
          notes: "Transfer",
          transferId,
          createdAt: "",
        } as unknown as BankTxn,
      );
    }

    for (let i = 0; i < ri(3); i++) {
      const item = pick(book.items);
      book.stockAdjustments.push({
        id: nid(),
        itemId: item.id,
        itemName: item.name,
        date: "2026-07-03",
        type: ri(2) ? "add" : "reduce",
        qty: 1 + ri(5),
        createdAt: "",
      } as unknown as StockAdjustment);
    }

    /* ── and now the check ─────────────────────────────────────────── */
    const recon = reconcile(book);

    assert(
      recon.unbalanced.length === 0,
      `T27: every entry balances — ${recon.unbalanced.length} did not, first ${JSON.stringify(
        recon.unbalanced[0]?.narration,
      )} out by ${recon.unbalanced[0] ? entryDrift(recon.unbalanced[0]) : 0}`,
    );

    const tb = trialBalance(recon.entries, recon.accounts);
    assert(tb.drift === 0, `T27: the trial balance itself balances — out by ${tb.drift}`);
    assert(
      tb.orphans.length === 0,
      `T27: every posting points at an account in the chart — orphans ${JSON.stringify(tb.orphans)}`,
    );

    for (const row of recon.rows) {
      assert(
        row.ok,
        `T27: ${row.label} — ledger ${row.ledger} vs app ${row.app}, out by ${row.diff}`,
      );
    }
    assert(
      recon.partyGaps.length === 0,
      `T27: every party's position matches netPartyPositions — ${recon.partyGaps.length} differ, worst ${JSON.stringify(
        recon.partyGaps[0],
      )}`,
    );
    assert(recon.ok, "T27: so the whole book reconciles");

    /* The trial balance must also be readable: assets and expenses lean
       debit, everything else credit, or the report prints every liability as
       a negative number. */
    const assetRow = tb.rows.find((r) => r.accountId === "cash");
    if (assetRow) {
      assert(assetRow.balance === assetRow.net, "T27: an asset's balance is its debit position");
    }
    const gstRow = tb.rows.find((r) => r.accountId === "output-gst");
    if (gstRow) {
      assert(
        gstRow.balance === -gstRow.net,
        "T27: a liability reads as what is owed, not as a negative",
      );
    }
  }
}

/* ═══ TEST 28: statements off the ledger, and closing a year ════════════
   Phase 2 built the ledger and proved it agrees with the app. This is what it
   was for. The Balance Sheet and the P&L are two views of the same postings,
   so the interesting failures are not arithmetic — they are the three-way
   rule about closing entries, which is easy to get backwards and makes every
   statement confidently wrong when you do:

     the P&L EXCLUDES them, the balance sheet INCLUDES them, and the close
     itself includes every EARLIER close.

   Every assertion below is about that, or about the identity a balance sheet
   lives or dies by. */
{
  /* ── Which year a date belongs to ──────────────────────────────────── */
  {
    const fy = (d: string) => financialYear(d);
    assert(
      fy("2026-08-26").start === "2026-04-01" && fy("2026-08-26").end === "2027-03-31",
      `T28: August is in the year that started in April — ${JSON.stringify(fy("2026-08-26"))}`,
    );
    assert(
      fy("2026-03-31").start === "2025-04-01" && fy("2026-03-31").end === "2026-03-31",
      "T28: 31 March is the LAST day of the year before, not the first of the next",
    );
    assert(
      fy("2026-04-01").start === "2026-04-01",
      "T28: and 1 April is the first day of the new one",
    );
    assert(
      fy("2026-01-15").label === "2025-26",
      `T28: January reads as 2025-26 — ${fy("2026-01-15").label}`,
    );
    assert(
      fy("2026-05-15").label === "2026-27",
      `T28: May reads as 2026-27 — ${fy("2026-05-15").label}`,
    );
    // A calendar-year shop: the end is 31 December, not 30 November.
    assert(
      financialYear("2026-05-15", 1).start === "2026-01-01" &&
        financialYear("2026-05-15", 1).end === "2026-12-31",
      `T28: a January start year ends on 31 December — ${JSON.stringify(financialYear("2026-05-15", 1))}`,
    );
  }

  /* ── A whole small year, closed, and everything checked around it ──── */
  {
    const book: Book = {
      parties: [{ id: "P1", name: "Cust", openingBalance: 0, createdAt: "2025-04-01T00:00:00Z" }],
      items: [
        {
          id: "I1",
          name: "Item",
          purchasePrice: 100,
          openingStock: 0,
          createdAt: "2025-04-01T00:00:00Z",
        },
      ],
      banks: [],
      sales: [
        {
          id: "S1",
          number: "INV-1",
          date: "2025-06-10",
          partyId: "P1",
          partyName: "Cust",
          gstEnabled: false,
          lineItems: [{ itemId: "I1", qty: 3, price: 500, costPrice: 100 }],
          subtotal: 1500,
          discount: 0,
          taxAmount: 0,
          total: 1500,
          paid: 1500,
          paymentMode: "cash",
          createdAt: "",
        },
      ],
      purchases: [],
      saleReturns: [],
      purchaseReturns: [],
      payments: [],
      expenses: [
        {
          id: "E1",
          date: "2025-07-01",
          category: "Shop Rent",
          amount: 400,
          paymentMode: "cash",
          createdAt: "",
        },
      ],
      cashAdjustments: [],
      bankTxns: [],
      stockAdjustments: [],
    } as unknown as Book;

    const chart = () => accountsFor(book.banks, book.expenses);
    const FY = financialYear("2025-06-10");
    assert(
      FY.label === "2025-26" && FY.end === "2026-03-31",
      "T28: the year under test is 2025-26",
    );

    // Revenue 1500, cost of the goods 300, rent 400 → 800.
    const before = profitAndLoss(buildJournal(book), chart(), FY.start, FY.end);
    assert(
      before.totalIncome === 1500,
      `T28: income is the taxable value of the bill — ${before.totalIncome}`,
    );
    assert(
      before.totalExpense === 700,
      `T28: expenses are the goods' cost plus the rent — ${before.totalExpense}`,
    );
    assert(before.netProfit === 800, `T28: so the year made 800 — ${before.netProfit}`);

    // The balance sheet balances BEFORE the year is closed. It has to: a
    // statement that only balances on 31 March is no use on the other 364
    // days, which is why unclosed profit is shown as equity.
    const bs = balanceSheet(buildJournal(book), chart(), FY.end);
    assert(bs.drift === 0, `T28: assets equal liabilities plus equity — out by ${bs.drift}`);
    assert(
      bs.currentEarnings === 800,
      `T28: with the year's profit sitting in equity, unclosed — ${bs.currentEarnings}`,
    );
    assert(
      bs.totalAssets === r2(bs.totalLiabilities + bs.totalEquity),
      `T28: and the two sides are equal — ${bs.totalAssets} vs ${r2(bs.totalLiabilities + bs.totalEquity)}`,
    );

    /* ── The plan ─────────────────────────────────────────────────────── */
    const plan = planYearClose(buildJournal(book), chart(), FY.end, "2026-06-01");
    assert(!plan.blocked, `T28: a finished year can be closed — ${plan.blocked}`);
    assert(
      plan.netProfit === 800 && plan.totalIncome === 1500 && plan.totalExpense === 700,
      `T28: the plan closes exactly what the P&L reported — ${plan.netProfit}`,
    );
    const entry = closingEntry(plan);
    assert(
      closingEntryBalances(entry),
      `T28: the closing entry balances — out by ${entryDrift(entry)}`,
    );
    assert(
      entry.lines.some((l) => l.accountId === "retained" && l.credit === 800),
      `T28: the profit goes to Retained Earnings — ${JSON.stringify(entry.lines)}`,
    );
    /* It must touch NOTHING but income, expenses and Retained Earnings. This
       is what lets a close post into a period the shop has locked after
       filing GST: it moves no account that appears in a filed return. If that
       ever stops being true, the exemption stops being honest. */
    const allowed = new Set(
      chart()
        .filter((a) => a.group === "income" || a.group === "expense")
        .map((a) => a.id)
        .concat("retained"),
    );
    assert(
      entry.lines.every((l) => allowed.has(l.accountId)),
      `T28: a close touches only income, expenses and Retained Earnings — ${JSON.stringify(
        entry.lines.filter((l) => !allowed.has(l.accountId)),
      )}`,
    );
    assert(
      !entry.lines.some((l) => l.accountId === "output-gst" || l.accountId === "input-gst"),
      "T28: never a GST account — that is what makes posting into a filed period safe",
    );

    /* ── Posted ───────────────────────────────────────────────────────── */
    book.journalEntries = [
      {
        id: "YC1",
        date: entry.date,
        voucherType: entry.voucherType,
        voucherNo: entry.voucherNo,
        docKind: entry.docKind,
        narration: entry.narration,
        fyLabel: plan.fy.label,
        lines: entry.lines,
        createdAt: "2026-06-01T00:00:00Z",
      },
    ] as never;

    const closed = buildJournal(book);
    // The year's own P&L must be UNCHANGED. This is the assertion that catches
    // the mistake of letting closing entries into the statement: the year
    // would report zero income, zero expenses and no profit at all.
    const after = profitAndLoss(closed, chart(), FY.start, FY.end);
    assert(
      after.netProfit === 800 && after.totalIncome === 1500,
      `T28: closing the year does not change what the year earned — ${after.netProfit} / ${after.totalIncome}`,
    );

    // The balance sheet, on the other hand, must now show it as Retained
    // Earnings rather than as this period's profit — and still balance.
    const bsAfter = balanceSheet(closed, chart(), FY.end);
    assert(bsAfter.drift === 0, `T28: it still balances after the close — out by ${bsAfter.drift}`);
    assert(
      bsAfter.currentEarnings === 0,
      `T28: nothing is left unclosed — ${bsAfter.currentEarnings}`,
    );
    assert(
      bsAfter.equity.find((l) => l.accountId === "retained")?.amount === 800,
      `T28: the profit is Retained Earnings now — ${JSON.stringify(bsAfter.equity)}`,
    );
    assert(
      bsAfter.totalEquity === bs.totalEquity,
      `T28: and the shop is worth exactly what it was worth a moment ago — ${bsAfter.totalEquity} vs ${bs.totalEquity}`,
    );

    // Every income and expense account is empty as at the year end.
    const tb = trialBalance(
      closed.filter((e) => e.date <= FY.end),
      chart(),
    );
    assert(
      tb.rows
        .filter((rw) => rw.group === "income" || rw.group === "expense")
        .every((rw) => rw.balance === 0),
      `T28: the year's income and expense accounts are emptied — ${JSON.stringify(
        tb.rows.filter((rw) => (rw.group === "income" || rw.group === "expense") && rw.balance),
      )}`,
    );
    assert(tb.drift === 0, "T28: and the trial balance still balances");

    /* ── Closing twice, and closing early ─────────────────────────────── */
    const again = planYearClose(buildJournal(book), chart(), FY.end, "2026-06-01");
    assert(
      !!again.blocked && again.blocked.includes("already been closed"),
      `T28: a year cannot be closed twice — ${again.blocked}`,
    );
    assert(!!again.existingId, "T28: and the existing close is found, so it can be reopened");

    const early = planYearClose(buildJournal(book), chart(), "2027-03-31", "2026-06-01");
    assert(
      !!early.blocked && early.blocked.includes("not finished"),
      `T28: a year that has not finished cannot be closed — ${early.blocked}`,
    );

    /* ── The second year: the close must take ONLY its own profit ─────
       This is the assertion that proves the close-includes-earlier-closes
       rule. Last year's close already removed last year's income, so what is
       left standing is this year's — and if the rule were the other way
       round, year two would carry year one's 800 all over again. */
    book.sales.push({
      id: "S2",
      number: "INV-2",
      date: "2026-09-15",
      partyId: "P1",
      partyName: "Cust",
      gstEnabled: false,
      lineItems: [{ itemId: "I1", qty: 1, price: 200, costPrice: 100 }],
      subtotal: 200,
      discount: 0,
      taxAmount: 0,
      total: 200,
      paid: 200,
      paymentMode: "cash",
      createdAt: "",
    } as never);

    const FY2 = financialYear("2026-09-15");
    assert(FY2.label === "2026-27", "T28: the second year is 2026-27");
    const plan2 = planYearClose(buildJournal(book), chart(), FY2.end, "2027-06-01");
    assert(
      plan2.netProfit === 100,
      `T28: year two closes its own 100, not last year's 800 as well — ${plan2.netProfit}`,
    );
    assert(plan2.totalIncome === 200, `T28: and sees only its own income — ${plan2.totalIncome}`);

    // Retained Earnings after both closes is the two years added up.
    book.journalEntries = [
      ...(book.journalEntries ?? []),
      {
        id: "YC2",
        date: FY2.end,
        voucherType: "Closing Entry",
        voucherNo: `YC-${FY2.label}`,
        docKind: "year-close",
        narration: "second",
        fyLabel: FY2.label,
        lines: closingEntry(plan2).lines,
        createdAt: "2027-06-01T00:00:00Z",
      },
    ] as never;
    const bothClosed = buildJournal(book);
    assert(
      balanceOf(bothClosed, "retained") === -900,
      `T28: two closed years add up in Retained Earnings — ${balanceOf(bothClosed, "retained")}`,
    );
    assert(
      balanceSheet(bothClosed, chart(), FY2.end).drift === 0,
      "T28: and the balance sheet still balances",
    );
    assert(
      profitAndLoss(bothClosed, chart(), FY.start, FY.end).netProfit === 800 &&
        profitAndLoss(bothClosed, chart(), FY2.start, FY2.end).netProfit === 100,
      "T28: each year still reports what IT earned, after both are closed",
    );

    /* The reconciliation must survive all of this. Its profit row compares
       the ledger against the app's all-time P&L, and the app has no notion of
       a closed year — so a row read off the accounts as they stand would be
       short by every closed year's profit. That is a false alarm on the one
       screen that must not cry wolf. */
    const recon = reconcile(book);
    const profitRow = recon.rows.find((rw) => rw.key === "profit");
    assert(
      profitRow?.ok,
      `T28: closing a year does not make the reconciliation cry wolf — ledger ${profitRow?.ledger} vs app ${profitRow?.app}`,
    );
    assert(recon.unbalanced.length === 0, "T28: and every entry, closings included, balances");
  }

  /* ── A loss, which must go the other way ──────────────────────────── */
  {
    const book: Book = {
      parties: [],
      items: [],
      banks: [],
      sales: [],
      purchases: [],
      saleReturns: [],
      purchaseReturns: [],
      payments: [],
      expenses: [
        {
          id: "E1",
          date: "2025-07-01",
          category: "Shop Rent",
          amount: 5000,
          paymentMode: "cash",
          createdAt: "",
        },
      ],
      cashAdjustments: [],
      bankTxns: [],
      stockAdjustments: [],
    } as unknown as Book;
    const chart = accountsFor(book.banks, book.expenses);
    const plan = planYearClose(buildJournal(book), chart, "2026-03-31", "2026-06-01");
    assert(plan.netProfit === -5000, `T28: a year of only rent is a loss — ${plan.netProfit}`);
    const entry = closingEntry(plan);
    assert(closingEntryBalances(entry), "T28: a loss closes just as evenly");
    assert(
      entry.lines.some((l) => l.accountId === "retained" && l.debit === 5000),
      `T28: and a loss DEBITS Retained Earnings — ${JSON.stringify(entry.lines)}`,
    );
  }

  /* ── The identity, over the randomised books ──────────────────────────
     A balance sheet's whole claim is that what the shop owns equals what it
     owes plus what is left over. Asserted over generated books rather than
     one worked example, because the failure mode is an account group being
     read the wrong way round, which a single tidy case can miss. */
  for (let t = 0; t < 120; t++) {
    const book: Book = {
      parties: [],
      items: [],
      banks: [],
      sales: [],
      purchases: [],
      saleReturns: [],
      purchaseReturns: [],
      payments: [],
      expenses: [],
      cashAdjustments: [],
      bankTxns: [],
      stockAdjustments: [],
    } as unknown as Book;

    const party = {
      id: `bp${t}`,
      name: "P",
      openingBalance: r2((rnd() - 0.5) * 8000),
      createdAt: "2025-04-01T00:00:00Z",
    };
    book.parties.push(party as never);
    book.banks.push({
      id: `bb${t}`,
      name: "Bank",
      openingBalance: r2(rnd() * 20000),
      balance: 0,
      createdAt: "2025-04-01T00:00:00Z",
    } as never);
    book.items.push({
      id: `bi${t}`,
      name: "Item",
      purchasePrice: r2(10 + rnd() * 200),
      openingStock: ri(20),
      createdAt: "2025-04-01T00:00:00Z",
    } as never);

    for (let i = 0; i < 1 + ri(4); i++) {
      const gst = ri(2) === 0;
      const sub = r2(100 + rnd() * 5000);
      const tax = gst ? r2(sub * 0.18) : 0;
      const total = Math.round(sub + tax);
      book.sales.push({
        id: `bs${t}-${i}`,
        number: `INV-${i}`,
        date: `2025-${String(6 + ri(6)).padStart(2, "0")}-1${ri(9)}`,
        partyId: party.id,
        partyName: party.name,
        gstEnabled: gst,
        lineItems: [{ itemId: `bi${t}`, qty: 1 + ri(3), price: sub, costPrice: r2(sub * 0.6) }],
        subtotal: sub,
        discount: 0,
        taxAmount: tax,
        roundOff: r2(total - sub - tax),
        total,
        paid: ri(2) ? total : 0,
        paymentMode: pick(["cash", "credit", "upi"] as PaymentMode[]),
        createdAt: "",
      } as never);
    }
    for (let i = 0; i < ri(3); i++)
      book.expenses.push({
        id: `be${t}-${i}`,
        date: "2025-09-01",
        category: pick(["Shop Rent", "Salary"]),
        amount: r2(50 + rnd() * 2000),
        paymentMode: "cash",
        createdAt: "",
      } as never);
    for (let i = 0; i < ri(3); i++)
      book.cashAdjustments.push({
        id: `bc${t}-${i}`,
        date: "2025-10-01",
        type: ri(2) ? "add" : "reduce",
        amount: r2(100 + rnd() * 3000),
        purpose: pick(["opening", "owner-in", "owner-out", "short-over", undefined]),
        createdAt: "",
      } as never);

    const chart = accountsFor(book.banks, book.expenses);
    const FY = financialYear("2025-06-10");

    const open = balanceSheet(buildJournal(book), chart, FY.end);
    assert(open.drift === 0, `T28: an unclosed balance sheet balances — out by ${open.drift}`);
    // Unclosed profit must be exactly what the P&L says for the same period,
    // or the two statements are telling the shop different things.
    const pl = profitAndLoss(buildJournal(book), chart, "", FY.end);
    assert(
      open.currentEarnings === pl.netProfit,
      `T28: unclosed profit equals the P&L for the same period — ${open.currentEarnings} vs ${pl.netProfit}`,
    );

    const plan = planYearClose(buildJournal(book), chart, FY.end, "2026-06-01");
    assert(
      plan.netProfit === pl.netProfit,
      `T28: and the close takes exactly that — ${plan.netProfit} vs ${pl.netProfit}`,
    );
    const entry = closingEntry(plan);
    assert(
      closingEntryBalances(entry),
      `T28: every closing entry balances — out by ${entryDrift(entry)}`,
    );

    book.journalEntries = [
      {
        id: `yc${t}`,
        date: entry.date,
        voucherType: entry.voucherType,
        docKind: entry.docKind,
        narration: entry.narration,
        lines: entry.lines,
        createdAt: "",
      },
    ] as never;
    const after = balanceSheet(buildJournal(book), chart, FY.end);
    assert(after.drift === 0, `T28: and it still balances once closed — out by ${after.drift}`);
    assert(
      after.currentEarnings === 0,
      `T28: with nothing left unclosed — ${after.currentEarnings}`,
    );
    assert(
      after.totalEquity === open.totalEquity,
      `T28: closing moves value between equity accounts and creates none — ${after.totalEquity} vs ${open.totalEquity}`,
    );
    assert(
      profitAndLoss(buildJournal(book), chart, "", FY.end).netProfit === pl.netProfit,
      "T28: and the year still reports what it earned",
    );
  }
}

/* ═══ TEST 29: corrections that leave a record ══════════════════════════
   Deleting a bill that has already been counted rewrites history: the month
   it was in quietly becomes a different month, and nothing on any screen says
   so. From here, anything dated before today is VOIDED instead — it stays
   where it is, stops counting everywhere, and the ledger posts a reversal on
   the day it was cancelled.

   Two properties carry the whole feature, and both are easy to lose:
     1. A voided document stops counting in EVERY total, without any caller
        having to remember to filter it.
     2. The ledger reverses it rather than forgetting it — the original stays
        in its own month, and the cancellation lands in the month it was
        decided. */
{
  /* ── Where the line falls ─────────────────────────────────────────── */
  {
    const now = "2026-08-26";
    assert(canDeleteOutright("2026-08-26", now), "T29: today's mistake can still be deleted");
    assert(
      canDeleteOutright("2026-09-01", now),
      "T29: and so can a future-dated one — nobody has reported on it either",
    );
    assert(
      !canDeleteOutright("2026-08-25", now),
      "T29: yesterday's is voided instead — its day has been counted",
    );
    assert(!canDeleteOutright("", now), "T29: a document with no date is never destroyed");
    assert(removalWord("2026-08-26", now) === "Delete", "T29: the action says Delete when it will");
    assert(
      removalWord("2026-08-25", now) === "Void",
      "T29: and says Void when it will — a button that lies about what it does is worse than no button",
    );
    assert(isVoided({ voidedAt: "2026-08-26T00:00:00Z" }), "T29: a cancelled record reads as one");
    assert(!isVoided({}) && !isVoided(undefined), "T29: and a live one does not");
  }

  /* ── The write layer, directly ─────────────────────────────────────────
     Filtering happens in Repository.all() rather than at the two hundred-odd
     places that call it, because "remember to filter" is not a mechanism and
     one forgotten total is the entire failure mode of this feature. */
  {
    const repo = new Repository<{ id: string; name: string; voidedAt?: string }>("void-test");
    repo.add({ id: "A", name: "live" } as never);
    repo.add({ id: "B", name: "to cancel" } as never);

    assert(repo.all().length === 2, "T29: both records are live to begin with");

    const logBefore = AuditLogRepo.all().length;
    const result = repo.voidBatched(null, "B", "Entered twice");
    assert(!!result, "T29: voiding returns the record it cancelled");
    assert(
      repo.all().length === 1 && repo.all()[0].id === "A",
      "T29: an ordinary read no longer sees it",
    );
    assert(repo.allWithVoided().length === 2, "T29: and the one read that asks for it still does");
    assert(
      !!repo.get("B"),
      "T29: a direct link to it still opens — it exists, it just does not count",
    );

    /* Voiding twice must be refused. Everything a caller does around this —
       restoring stock, reversing a bank balance — is a blind atomic
       increment, so a second pass would move the shop's real figures twice.
       Returning nothing is what tells the caller to stop. */
    const again = repo.voidBatched(null, "B", "again");
    assert(!again, "T29: voiding an already-cancelled record does nothing and says so");
    const missing = repo.voidBatched(null, "NOPE", "reason");
    assert(!missing, "T29: and neither does voiding one that is not there");

    /* It is recorded the same way a deletion is, and labelled as what it was.
       A log that called this a delete would send someone looking for a
       document that is still sitting on the list. */
    const logged = AuditLogRepo.all().slice(0, AuditLogRepo.all().length - logBefore);
    const entry = logged.find((e) => e.recordId === "B");
    assert(!!entry, "T29: cancelling a record is written to the audit log");
    assert(entry?.action === "void", `T29: as a void, not as a delete — ${entry?.action}`);
    assert(
      !!entry?.snapshot && (entry.snapshot as { name?: string }).name === "to cancel",
      "T29: with the record as it stood",
    );
  }

  /* ── The ledger reverses; it does not forget ──────────────────────── */
  {
    const b: Book = {
      parties: [{ id: "P1", name: "Cust", openingBalance: 0, createdAt: "" }],
      items: [{ id: "I1", name: "Item", purchasePrice: 100, openingStock: 0, createdAt: "" }],
      banks: [],
      sales: [
        {
          id: "S1",
          number: "INV-1",
          date: "2026-05-10",
          partyId: "P1",
          partyName: "Cust",
          gstEnabled: false,
          lineItems: [{ itemId: "I1", qty: 2, price: 500, costPrice: 100 }],
          subtotal: 1000,
          discount: 0,
          taxAmount: 0,
          total: 1000,
          paid: 1000,
          paymentMode: "cash",
          createdAt: "",
          // Cancelled two months after it was billed.
          voidedAt: "2026-07-20T10:00:00Z",
          voidedBy: "someone@shop",
          voidReason: "Entered twice",
        },
      ],
      purchases: [],
      saleReturns: [],
      purchaseReturns: [],
      payments: [],
      expenses: [],
      cashAdjustments: [],
      bankTxns: [],
      stockAdjustments: [],
    } as unknown as Book;

    const entries = buildJournal(b);
    const original = entries.find((e) => e.docKind === "sale");
    const reversal = entries.find((e) => e.docKind === "sale-void");
    assert(!!original, "T29: the original sale is still posted");
    assert(!!reversal, "T29: and a reversal follows it");
    assert(
      original?.date === "2026-05-10",
      `T29: the original keeps its own date — ${original?.date}`,
    );
    assert(
      reversal?.date === "2026-07-20",
      `T29: the reversal lands on the day it was cancelled, not the day of the bill — ${reversal?.date}`,
    );
    /* Guarded, not asserted with a "!". Without the reversal these lines
       throw on a missing value, and this harness has no per-block catch — so
       one broken rule killed the whole run and reported nothing at all,
       instead of failing by name and letting the other 109,000 assertions
       finish. */
    if (reversal) {
      assert(isBalanced(reversal), "T29: and it balances");
      assert(
        reversal.narration.startsWith("Voided:"),
        `T29: it says what it is — ${reversal.narration}`,
      );
    }

    // Every account nets to nothing once both are in.
    for (const account of ["ar", "cash", "sales", "cogs", "inventory"]) {
      assert(
        balanceOf(entries, account) === 0,
        `T29: ${account} nets to nothing across the pair — ${balanceOf(entries, account)}`,
      );
    }

    /* This is the point of dating the reversal when it happened. A trial
       balance drawn in June still shows the sale, because in June it was
       real — that is what "the accounts are a record" means, and it is
       exactly what deleting the bill would have destroyed. */
    const inJune = entries.filter((e) => e.date <= "2026-06-30");
    assert(
      balanceOf(inJune, "sales") === -1000,
      `T29: a statement drawn before the void still shows the sale — ${balanceOf(inJune, "sales")}`,
    );
    const afterward = entries.filter((e) => e.date <= "2026-07-31");
    assert(
      balanceOf(afterward, "sales") === 0,
      `T29: one drawn after it shows both, netting to nothing — ${balanceOf(afterward, "sales")}`,
    );
  }

  /* ── Both sides of a cancelled transfer ───────────────────────────── */
  {
    const b: Book = {
      parties: [],
      items: [],
      banks: [{ id: "B1", name: "Bank", openingBalance: 0, balance: 0, createdAt: "" }],
      sales: [],
      purchases: [],
      saleReturns: [],
      purchaseReturns: [],
      payments: [],
      expenses: [],
      cashAdjustments: [
        {
          id: "CA1",
          date: "2026-05-05",
          type: "reduce",
          amount: 5000,
          reason: "Transfer",
          transferId: "TR1",
          createdAt: "",
          voidedAt: "2026-06-01T00:00:00Z",
        },
      ],
      bankTxns: [
        {
          id: "BT1",
          bankId: "B1",
          date: "2026-05-05",
          type: "deposit",
          amount: 5000,
          notes: "Transfer",
          transferId: "TR1",
          createdAt: "",
          voidedAt: "2026-06-01T00:00:00Z",
        },
      ],
      stockAdjustments: [],
    } as unknown as Book;

    const entries = buildJournal(b);
    assert(
      entries.filter((e) => e.docKind === "transfer").length === 1 &&
        entries.filter((e) => e.docKind === "transfer-void").length === 1,
      `T29: one transfer, one reversal — ${JSON.stringify(entries.map((e) => e.docKind))}`,
    );
    assert(
      balanceOf(entries, "cash") === 0 && balanceOf(entries, "bank:B1") === 0,
      `T29: and both ends come back — cash ${balanceOf(entries, "cash")}, bank ${balanceOf(entries, "bank:B1")}`,
    );
  }

  /* ── liveOnly strips exactly the transaction documents ────────────── */
  {
    const b: Book = {
      parties: [{ id: "P1", name: "P", openingBalance: 0, createdAt: "" }],
      items: [{ id: "I1", name: "I", purchasePrice: 1, openingStock: 0, createdAt: "" }],
      banks: [{ id: "B1", name: "B", openingBalance: 0, balance: 0, createdAt: "" }],
      sales: [
        { id: "S1", date: "2026-01-01", total: 1, lineItems: [], voidedAt: "2026-02-01" },
        { id: "S2", date: "2026-01-01", total: 1, lineItems: [] },
      ],
      purchases: [{ id: "PB1", date: "2026-01-01", total: 1, lineItems: [], voidedAt: "x" }],
      saleReturns: [{ id: "R1", date: "2026-01-01", total: 1, lineItems: [], voidedAt: "x" }],
      purchaseReturns: [{ id: "R2", date: "2026-01-01", total: 1, lineItems: [], voidedAt: "x" }],
      payments: [{ id: "PAY1", date: "2026-01-01", amount: 1, voidedAt: "x" }],
      expenses: [{ id: "E1", date: "2026-01-01", amount: 1, voidedAt: "x" }],
      cashAdjustments: [{ id: "C1", date: "2026-01-01", amount: 1, voidedAt: "x" }],
      bankTxns: [{ id: "T1", date: "2026-01-01", amount: 1, voidedAt: "x" }],
      stockAdjustments: [],
    } as unknown as Book;
    const live = liveOnly(b);
    assert(
      live.sales.length === 1 && live.sales[0].id === "S2",
      "T29: the cancelled sale is dropped and the live one kept",
    );
    for (const [name, list] of [
      ["purchases", live.purchases],
      ["sale returns", live.saleReturns],
      ["purchase returns", live.purchaseReturns],
      ["payments", live.payments],
      ["expenses", live.expenses],
      ["cash entries", live.cashAdjustments],
      ["bank entries", live.bankTxns],
    ] as const) {
      assert(list.length === 0, `T29: cancelled ${name} are dropped too — ${list.length} left`);
    }
    // Master data is not a record of something that happened, so it is not
    // voidable and must come through untouched.
    assert(
      live.parties.length === 1 && live.items.length === 1 && live.banks.length === 1,
      "T29: parties, items and bank accounts are left alone",
    );
    assert(b.sales.length === 2, "T29: and the original book is not modified");
  }

  /* ── The reconciliation still holds, over books with cancellations ──
     The one that matters. Each side of that comparison reads a different
     book — the ledger sees everything and reverses, the app's own
     calculations see only what is live — and if those two are not fed the
     right book each, a voided document counts once on one side and nets to
     nothing on the other. That mismatch is invisible in any single figure
     and shows up only here. */
  for (let t = 0; t < 120; t++) {
    const book: Book = {
      parties: [],
      items: [],
      banks: [],
      sales: [],
      purchases: [],
      saleReturns: [],
      purchaseReturns: [],
      payments: [],
      expenses: [],
      cashAdjustments: [],
      bankTxns: [],
      stockAdjustments: [],
    } as unknown as Book;

    const party = { id: `vp${t}`, name: "Party", openingBalance: 0, createdAt: "" };
    book.parties.push(party as never);
    const bank = {
      id: `vb${t}`,
      name: "Bank",
      openingBalance: 10000,
      balance: 10000,
      createdAt: "",
    };
    book.banks.push(bank as never);
    book.items.push({
      id: `vi${t}`,
      name: "Item",
      purchasePrice: 100,
      openingStock: 0,
      createdAt: "",
    } as never);

    /** Cancel a document the way the screens do: mark it, and put back
     *  whatever it moved on a stored running total. */
    const voidIt = (doc: { voidedAt?: string }, undoBank = 0) => {
      doc.voidedAt = "2026-08-01T00:00:00Z";
      bank.balance = r2(bank.balance + undoBank);
    };

    for (let i = 0; i < 1 + ri(4); i++) {
      const total = Math.round(100 + rnd() * 4000);
      const mode = pick(["cash", "bank", "credit"] as PaymentMode[]);
      const useBank = mode === "bank" && ri(2) === 0;
      const paid = ri(2) ? total : 0;
      const sale = {
        id: `vs${t}-${i}`,
        number: `INV-${i}`,
        date: `2026-0${1 + ri(5)}-1${ri(9)}`,
        partyId: party.id,
        partyName: party.name,
        gstEnabled: false,
        lineItems: [{ itemId: `vi${t}`, qty: 1, price: total, costPrice: 60 }],
        subtotal: total,
        discount: 0,
        taxAmount: 0,
        total,
        paid,
        paymentMode: mode,
        ...(useBank ? { bankId: bank.id, bankPaidAmount: paid } : {}),
        createdAt: "",
      } as unknown as Invoice & { voidedAt?: string };
      if (useBank && paid) bank.balance = r2(bank.balance + paid);
      book.sales.push(sale);
      // A third of them get cancelled, with the bank side put back exactly
      // as the Sales screen puts it back.
      if (ri(3) === 0) voidIt(sale, useBank && paid ? -paid : 0);
    }

    for (let i = 0; i < ri(4); i++) {
      const amount = r2(50 + rnd() * 1500);
      const useBank = ri(2) === 0;
      if (useBank) bank.balance = r2(bank.balance - amount);
      const exp = {
        id: `ve${t}-${i}`,
        date: "2026-06-15",
        category: "Shop Rent",
        amount,
        paymentMode: useBank ? "bank" : "cash",
        ...(useBank ? { bankId: bank.id } : {}),
        createdAt: "",
      } as unknown as Expense & { voidedAt?: string };
      book.expenses.push(exp);
      if (ri(3) === 0) voidIt(exp, useBank ? amount : 0);
    }

    for (let i = 0; i < ri(4); i++) {
      const adj = {
        id: `vc${t}-${i}`,
        date: "2026-06-20",
        type: ri(2) ? "add" : "reduce",
        amount: r2(100 + rnd() * 2000),
        purpose: pick(["owner-in", "owner-out", "short-over", undefined]),
        createdAt: "",
      } as unknown as CashAdjustment & { voidedAt?: string };
      book.cashAdjustments.push(adj);
      if (ri(3) === 0) voidIt(adj);
    }

    const recon = reconcile(book);
    for (const row of recon.rows) {
      assert(
        row.ok,
        `T29: with cancelled documents in the book, ${row.label} still agrees — ledger ${row.ledger} vs app ${row.app}, out by ${row.diff}`,
      );
    }
    assert(
      recon.partyGaps.length === 0,
      `T29: and every party's position too — ${JSON.stringify(recon.partyGaps[0])}`,
    );
    assert(recon.unbalanced.length === 0, "T29: every entry, reversals included, balances");

    /* And the reversals really are there — a book where voiding simply
       dropped the documents would pass every assertion above while quietly
       destroying the record, which is the failure this whole test exists to
       catch. */
    const cancelled = [...book.sales, ...book.expenses, ...book.cashAdjustments].filter(
      (d) => (d as { voidedAt?: string }).voidedAt,
    );
    if (cancelled.length) {
      const reversals = recon.entries.filter((e) => e.docKind.endsWith("-void"));
      assert(
        reversals.length === cancelled.length,
        `T29: one reversal per cancelled document — ${reversals.length} for ${cancelled.length}`,
      );
      assert(
        reversals.every((e) => e.date === "2026-08-01"),
        "T29: every one of them dated the day of the cancellation",
      );
    }
  }
}

/* ═══ TEST 30: the other half of the door ═══════════════════════════════
   Phase 4 stopped an older document being deleted, then extended the same
   line to editing, reasoning that an edit leaves no trace of itself.

   That reasoning expired. The audit trail records who changed what and when,
   so an edit IS attributable — and what the rule actually did in the shop was
   refuse to let anyone fix a rate they had typed wrongly the previous day,
   with no way to say "this month is not filed yet". The calendar does not
   know which months are closed. The owner does, and already says so in
   Settings.

   So editing is governed by the period lock, and deletion is deliberately NOT
   relaxed with it: an edit is recorded, a deletion removes the record. */
{
  const now = "2026-08-26";

  /* No lock — the state most shops are in, and the one that was unusable.
     Every date is editable, including months old. */
  assert(canEditInPlace("2026-08-26"), "T30: today's document can be edited");
  assert(
    canEditInPlace("2026-05-11"),
    "T30: and so can one from months ago, when the shop has closed nothing",
  );
  assert(!canEditInPlace(""), "T30: a document with no date at all cannot");

  /* Locked — the protection, now under the owner's control rather than the
     calendar's. */
  const lock = "2026-07-31";
  assert(!canEditInPlace("2026-07-31", lock), "T30: the last closed day is closed");
  assert(!canEditInPlace("2026-06-02", lock), "T30: and everything before it");
  assert(
    canEditInPlace("2026-08-01", lock),
    "T30: while the day after the lock is open for correction",
  );
  assert(canEditInPlace(now, lock), "T30: as is today");

  /* Editing and deleting NO LONGER move together, and that is the point. A
     three-month-old bill can be corrected — the change is attributable — but
     removing it destroys the record, so it is still voided rather than
     deleted. */
  assert(
    canEditInPlace("2026-05-11") && !canDeleteOutright("2026-05-11", now),
    "T30: an old bill can be corrected but still cannot be destroyed — it is voided",
  );

  assert(
    editRefusalMessage("invoice", lock).includes("Void it and issue a new one"),
    "T30: the refusal says what to do instead — a screen that only refuses gets worked around",
  );
  assert(
    editRefusalMessage("invoice", lock).includes(lock),
    "T30: and names the date the books are closed to, so it can be argued with",
  );
}

/* ═══ TEST 31: reopening a year reverses the close ══════════════════════
   Everything else in this application leaves the original where it is and
   posts a reversal. A year close was the exception: reopening deleted it. Of
   all the documents to make an exception of, that is the worst one — next
   year's opening position is built on it, and a deleted close leaves no
   record that the year was ever closed. */
{
  const book: Book = {
    parties: [],
    items: [],
    banks: [],
    sales: [],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
    expenses: [
      {
        id: "E1",
        date: "2025-07-01",
        category: "Shop Rent",
        amount: 400,
        paymentMode: "cash",
        createdAt: "",
      },
    ],
    cashAdjustments: [],
    bankTxns: [],
    stockAdjustments: [],
  } as unknown as Book;
  const chart = accountsFor(book.banks, book.expenses);
  const FY = financialYear("2025-07-01");

  const plan = planYearClose(buildJournal(book), chart, FY.end, "2026-06-01");
  assert(plan.netProfit === -400, `T31: the year lost 400 — ${plan.netProfit}`);
  const entry = closingEntry(plan);

  book.journalEntries = [
    {
      id: "YC1",
      date: entry.date,
      voucherType: entry.voucherType,
      docKind: entry.docKind,
      narration: entry.narration,
      fyLabel: plan.fy.label,
      lines: entry.lines,
      createdAt: "2026-06-01T00:00:00Z",
    },
  ] as never;

  assert(
    !!planYearClose(buildJournal(book), chart, FY.end, "2026-06-01").blocked,
    "T31: once closed, it cannot be closed again",
  );
  assert(
    balanceOf(buildJournal(book), "retained") === 400,
    `T31: and the loss sits in Retained Earnings — ${balanceOf(buildJournal(book), "retained")}`,
  );

  /* Reopen it — the way the screen now does, by cancelling the entry rather
     than destroying it. */
  (book.journalEntries as unknown as { voidedAt?: string }[])[0].voidedAt = "2026-09-15T00:00:00Z";
  const reopened = buildJournal(book);

  assert(
    reopened.some((e) => e.docKind === "year-close"),
    "T31: the closing entry is STILL on record — that is the whole point",
  );
  assert(
    reopened.some((e) => e.docKind === "year-close-void"),
    `T31: with a reversal against it — ${JSON.stringify(reopened.map((e) => e.docKind))}`,
  );
  /* Dated the year end, NOT the day it was reopened — the one deliberate
     exception to how every other reversal is dated.

     A bill is an event: it happened in its month, and undoing it is a second
     event in another. A closing entry is not an event, it is a boundary. A
     reversal dated three months later would leave the year closed as at 31
     March and open afterwards, which is not a state a year can be in — and
     the year could then never be closed again, because nothing would be left
     in the accounts to close. */
  assert(
    reopened.find((e) => e.docKind === "year-close-void")?.date === FY.end,
    `T31: the reversal lands on the year end, where the close itself is — ${
      reopened.find((e) => e.docKind === "year-close-void")?.date
    }`,
  );
  assert(
    !!(book.journalEntries as unknown as { voidedAt?: string }[])[0].voidedAt,
    "T31: while the record still says WHEN it was reopened",
  );
  assert(
    balanceOf(reopened, "retained") === 0,
    `T31: Retained Earnings is back where it was — ${balanceOf(reopened, "retained")}`,
  );

  const plan2 = planYearClose(reopened, chart, FY.end, "2026-10-01");
  assert(
    !plan2.blocked,
    `T31: and the year can be closed again — a reversed close is not a close (${plan2.blocked})`,
  );
  assert(
    plan2.netProfit === -400,
    `T31: for the same amount it lost the first time — ${plan2.netProfit}`,
  );

  /* The P&L never moved through any of this. It excludes closing entries AND
     their reversals: counting the close would report zero, and counting the
     reversal would report double. */
  for (const [label, es] of [
    ["before closing", buildJournal({ ...book, journalEntries: [] })],
    ["after reopening", reopened],
  ] as const) {
    assert(
      profitAndLoss(es, chart, FY.start, FY.end).netProfit === -400,
      `T31: the year still reports what it lost, ${label} — ${profitAndLoss(es, chart, FY.start, FY.end).netProfit}`,
    );
  }

  assert(
    balanceSheet(reopened, chart, FY.end).drift === 0,
    "T31: and the balance sheet still balances with both entries on it",
  );
  assert(
    balanceSheet(reopened, chart, FY.end).currentEarnings === -400,
    `T31: with the loss back in the open period — ${balanceSheet(reopened, chart, FY.end).currentEarnings}`,
  );
}

/* ═══ TEST 32: the repair tools read LIVE documents, and must ═══════════
   The delete guards had to be taught to count cancelled documents. This is
   the same question with the opposite answer, which is why it is written
   down: voiding a sale already puts its stock back, so a repair tool that
   also counted the cancelled sale would compute a stock figure that is short
   by the very quantity the void restored — and then "repair" the shop's real
   stock to it.

   Both readings are one word apart at the call site, and the wrong one is
   the plausible-looking one after seeing the delete-guard fix. */
{
  const item = {
    id: "RI",
    name: "Repair Item",
    unit: "PCS",
    gstRate: 0,
    purchasePrice: 100,
    salePrice: 200,
    openingStock: 100,
    // Voiding the sale below restored its 10, so the stored figure is back
    // where it started. This is the state the shop is actually in.
    stock: 100,
    createdAt: "",
  } as unknown as Item;

  const soldThenVoided = {
    id: "RS",
    number: "INV-R",
    date: "2026-05-01",
    partyId: "P",
    partyName: "P",
    lineItems: [
      {
        id: "l",
        itemId: "RI",
        name: "Repair Item",
        qty: 10,
        unit: "PCS",
        price: 200,
        discountPct: 0,
        gstRate: 0,
        amount: 2000,
      },
    ],
    subtotal: 2000,
    discount: 0,
    taxAmount: 0,
    total: 2000,
    paid: 0,
    paymentMode: "credit",
    createdAt: "",
    voidedAt: "2026-07-01T00:00:00Z",
  } as unknown as Invoice;

  const base = {
    items: [item],
    purchases: [] as Invoice[],
    saleReturns: [] as Return[],
    purchaseReturns: [] as Return[],
    stockAdjustments: [] as StockAdjustment[],
  };

  // What the screen actually passes: SalesRepo.all(), which skips the
  // cancelled bill.
  const live = planStockRepair({ ...base, sales: [] });
  assert(
    live.length === 0,
    `T32: with the cancelled sale excluded, stock already agrees and nothing is "repaired" — ${JSON.stringify(live)}`,
  );

  // And what would happen if someone changed that call to allWithVoided by
  // analogy with the delete guards: the tool would decide the shop is 10
  // short and write that figure onto real stock.
  const withVoided = planStockRepair({ ...base, sales: [soldThenVoided] });
  assert(
    withVoided.length === 1 && withVoided[0].correct === 90,
    `T32: counting it would silently take 10 off the real stock — ${JSON.stringify(withVoided)}`,
  );
}

/* ═══ TEST 33: what an account figure is made of ════════════════════════
   A trial balance without this is a set of assertions: "Accounts Receivable
   is 4,12,300" and nothing to do but believe it. The first question anyone
   asks of a figure they doubt is "made up of what", and an accountant asks it
   of every figure. */
{
  const b: Book = {
    parties: [{ id: "P1", name: "Cust", openingBalance: 0, createdAt: "" }],
    items: [],
    banks: [],
    sales: [
      {
        id: "S1",
        number: "INV-1",
        date: "2026-05-10",
        partyId: "P1",
        partyName: "Cust",
        gstEnabled: false,
        lineItems: [],
        subtotal: 1000,
        discount: 0,
        taxAmount: 0,
        total: 1000,
        paid: 0,
        paymentMode: "credit",
        createdAt: "",
      },
      {
        id: "S2",
        number: "INV-2",
        date: "2026-03-02",
        partyId: "P1",
        partyName: "Cust",
        gstEnabled: false,
        lineItems: [],
        subtotal: 400,
        discount: 0,
        taxAmount: 0,
        total: 400,
        paid: 0,
        paymentMode: "credit",
        createdAt: "",
      },
    ],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [
      {
        id: "PAY1",
        date: "2026-06-01",
        partyId: "P1",
        partyName: "Cust",
        type: "in",
        amount: 250,
        mode: "cash",
        createdAt: "",
      },
    ],
    expenses: [],
    cashAdjustments: [],
    bankTxns: [],
    stockAdjustments: [],
  } as unknown as Book;

  const entries = buildJournal(b);
  const led = accountLedger(entries, "ar");

  assert(led.rows.length === 3, `T33: every line that touched the account — ${led.rows.length}`);
  /* Oldest first. A running balance read from the newest end is not a running
     balance, and the trial balance itself sorts the other way — so this is a
     deliberate difference rather than an oversight, and worth pinning. */
  assert(
    led.rows[0].date === "2026-03-02" &&
      led.rows[1].date === "2026-05-10" &&
      led.rows[2].date === "2026-06-01",
    `T33: oldest first, so the running balance runs — ${led.rows.map((r) => r.date).join(", ")}`,
  );
  assert(
    led.rows.map((r) => r.balance).join(",") === "400,1400,1150",
    `T33: and the balance runs with it — ${led.rows.map((r) => r.balance).join(",")}`,
  );
  assert(
    led.closing === balanceOf(entries, "ar"),
    `T33: ending exactly where the trial balance says — ${led.closing} vs ${balanceOf(entries, "ar")}`,
  );
  assert(
    led.debit === 1400 && led.credit === 250,
    `T33: with both columns totalled — dr ${led.debit} cr ${led.credit}`,
  );
  /* Every row names the document behind it, so "why is receivable 1,150"
     ends at a bill with a number on it rather than at a shrug. */
  assert(
    led.rows.every((r) => !!r.docId && !!r.docKind),
    "T33: every line points back at the document that caused it",
  );
  assert(
    led.rows.some((r) => r.voucherNo === "INV-1"),
    `T33: by its number — ${led.rows.map((r) => r.voucherNo).join(", ")}`,
  );
  assert(
    accountLedger(entries, "nothing-here").rows.length === 0,
    "T33: an account nothing touched reads as empty, not as an error",
  );
}

/* ═══ TEST 34: Inventory is shown, and shown honestly ═══════════════════
   Until now the trial balance printed an Inventory figure that nothing on any
   screen was ever compared against — the one account with no second opinion.
   It has one now, but the two answer different questions: the ledger carries
   stock at what each movement cost at the time, the stock report values what
   is on the shelf at today's purchase price. They separate when a purchase
   price moves, which is trading, not a fault. So the row is shown and
   measured, and marked as information rather than as a verdict. */
{
  const item = {
    id: "I1",
    name: "Item",
    // Bought at 100, now costs 150 — the ordinary case, not a corner one.
    purchasePrice: 150,
    openingStock: 0,
    stock: 10,
    createdAt: "2026-01-01T00:00:00Z",
  } as unknown as Item;

  const b: Book = {
    parties: [{ id: "P1", name: "Supp", openingBalance: 0, createdAt: "" }],
    items: [item],
    banks: [],
    sales: [],
    purchases: [
      {
        id: "PB1",
        number: "PB-1",
        date: "2026-02-01",
        partyId: "P1",
        partyName: "Supp",
        gstEnabled: false,
        lineItems: [{ itemId: "I1", qty: 10, price: 100, costPrice: 100 }],
        subtotal: 1000,
        discount: 0,
        taxAmount: 0,
        total: 1000,
        paid: 1000,
        paymentMode: "cash",
        createdAt: "",
      },
    ],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
    expenses: [],
    cashAdjustments: [],
    bankTxns: [],
    stockAdjustments: [],
  } as unknown as Book;

  const recon = reconcile(b);
  const row = recon.rows.find((r) => r.key === "inventory");
  assert(!!row, "T34: Inventory is on the reconciliation at all — it never used to be");
  assert(row?.ledger === 1000, `T34: the ledger carries it at what it cost — ${row?.ledger}`);
  assert(row?.app === 1500, `T34: the stock report values it at today's price — ${row?.app}`);
  assert(row?.diff === -500, `T34: and the difference is stated — ${row?.diff}`);

  /* The important part. A 500 gap that is purely a price movement must not
     turn the reconciliation red, or the screen that exists to be believed
     starts crying wolf every time a supplier raises a price. */
  assert(row?.informational === true, "T34: marked as information, not as a verdict");
  assert(row?.ok === true, "T34: so a normal price movement does not read as a failure");
  assert(
    recon.ok,
    "T34: and the book as a whole still reconciles — the other rows are what pass or fail",
  );
  assert(
    (row?.why ?? "").includes("purchase prices move"),
    `T34: with the reason on the row, where the reader is — ${row?.why}`,
  );
}

/* ═══ TEST 35: stock that is counted, not stored ════════════════════════
   The shop buys adapters by the box and sells them one at a time, and every
   unit carries the serial the customer's warranty is written against.

   The decision the whole feature rests on: for a serialised item, stock stops
   being the stored `item.stock` number and becomes the count of serials on
   hand. `item.stock` is one of only two stored running totals in this
   application and lib/dataRepair.ts exists because it drifts — for these
   items that entire class of bug disappears, because there is one source and
   nothing for it to disagree with.

   Which means the stored number must be *ignored*, not trusted as a fallback.
   That is what most of this checks. */
{
  const plain = { id: "P", name: "Cable", stock: 7, purchasePrice: 50 } as unknown as Item;
  /* A stored number that is deliberately WRONG. Every assertion below that
     expects 2 rather than 999 is checking that the stored figure is not
     consulted at all — a fallback here would be the worst of both: a number
     nothing maintains, shown as though something did. */
  const tracked = {
    id: "T",
    name: "Adapter",
    stock: 999,
    purchasePrice: 100,
    trackSerials: true,
  } as unknown as Item;

  const serials = [
    { id: "s1", itemId: "T", serial: "AAA1", status: "in_stock", createdAt: "3" },
    { id: "s2", itemId: "T", serial: "AAA2", status: "in_stock", createdAt: "2" },
    { id: "s3", itemId: "T", serial: "AAA3", status: "sold", createdAt: "1" },
    { id: "s4", itemId: "T", serial: "AAA4", status: "damaged", createdAt: "4" },
    { id: "s5", itemId: "OTHER", serial: "BBB1", status: "in_stock", createdAt: "5" },
  ] as unknown as Serial[];

  assert(isSerialised(tracked) && !isSerialised(plain), "T35: an item says which kind it is");
  assert(!isSerialised(undefined), "T35: and a missing item is not serialised");

  const counts = inStockCounts(serials);
  assert(counts.get("T") === 2, `T35: only what is on the shelf counts — ${counts.get("T")}`);
  assert(counts.get("OTHER") === 1, "T35: counted per item, not lumped together");

  assert(
    stockOf(tracked, counts) === 2,
    `T35: a serialised item's stock is its serial count — ${stockOf(tracked, counts)}`,
  );
  assert(
    stockOf(tracked, counts) !== 999,
    "T35: and the stored number is ignored entirely, not used as a fallback",
  );
  assert(
    stockOf(plain, counts) === 7,
    `T35: an ordinary item still reads its stored stock — ${stockOf(plain, counts)}`,
  );

  /* A serialised item with no serials is zero. Falling back to item.stock
     here is the tempting bug: it would make a brand-new tracked item claim
     whatever number happened to be sitting on it. */
  const empty = { id: "E", name: "New", stock: 42, trackSerials: true } as unknown as Item;
  assert(
    stockOf(empty, counts) === 0,
    `T35: a serialised item with no serials has none, whatever the old number said — ${stockOf(empty, counts)}`,
  );

  // Sold and damaged units are off the shelf but still on file.
  assert(
    serialsOf("T", serials).length === 4,
    `T35: every unit of the item is still listed — ${serialsOf("T", serials).length}`,
  );
  assert(
    serialsOf("T", serials)[0].serial === "AAA4",
    "T35: newest first, so the last one received is at the top",
  );

  /* Uniqueness is per ITEM, not global: two manufacturers can legitimately
     stamp the same string, and a global rule would refuse a real unit with no
     way to explain why. */
  assert(!!findSerial("T", "AAA1", serials), "T35: a serial is found under its own item");
  assert(
    !findSerial("OTHER", "AAA1", serials),
    "T35: and not under a different one — uniqueness is per item",
  );
  /* Scanners add spaces and cases differ. "f2lx9k3" and "F2LX9K3 " are the
     same adapter to everyone except a string compare. */
  assert(
    findSerial("T", "  aaa1 ", serials)?.id === "s1",
    "T35: found whatever the scanner did to the spacing and case",
  );
  assert(!findSerial("T", "   ", serials), "T35: and an empty scan finds nothing");
}

/* ═══ TEST 36: warranty dates a customer could argue about ══════════════
   The whole point of the serial is the warranty, so the date it produces has
   to survive being read off a bill by someone who wants it honoured. */
{
  assert(
    warrantyEnd("2026-03-12", 12) === "2027-03-12",
    `T36: a year's warranty ends a year later — ${warrantyEnd("2026-03-12", 12)}`,
  );
  assert(
    warrantyEnd("2026-08-27", 6) === "2027-02-27",
    `T36: six months crosses the year end correctly — ${warrantyEnd("2026-08-27", 6)}`,
  );
  /* 31 January plus one month. A naive setMonth gives 2 or 3 March, which is
     a date the customer would rightly argue with — the month ends on the
     28th, so the warranty does. */
  assert(
    warrantyEnd("2026-01-31", 1) === "2026-02-28",
    `T36: a month from the 31st lands on the last day of a short month — ${warrantyEnd("2026-01-31", 1)}`,
  );
  assert(
    warrantyEnd("2028-01-31", 1) === "2028-02-29",
    `T36: and on the 29th in a leap year — ${warrantyEnd("2028-01-31", 1)}`,
  );
  assert(!warrantyEnd("2026-03-12", 0), "T36: no warranty means no end date, not today");
  assert(!warrantyEnd("2026-03-12", undefined), "T36: and neither does an unset policy");
  assert(!warrantyEnd("", 12), "T36: nor a missing sale date");

  assert(
    warrantyDaysLeft("2026-09-01", "2026-08-27") === 5,
    `T36: days left counts forward — ${warrantyDaysLeft("2026-09-01", "2026-08-27")}`,
  );
  assert(
    (warrantyDaysLeft("2026-08-20", "2026-08-27") ?? 0) < 0,
    "T36: and goes negative once it has run out, rather than clamping to zero",
  );
  assert(
    warrantyDaysLeft(undefined, "2026-08-27") === undefined,
    "T36: no warranty is not the same as an expired one",
  );
}

/* ═══ TEST 37: the repair tool leaves serialised items alone ════════════
   planStockRepair rebuilds item.stock from documents. For a serialised item
   that is the wrong question — stock IS the serial count, so there is nothing
   to rebuild, and "repairing" it would write a documents-derived figure over
   a shelf count that is already right.

   Note this is the OPPOSITE answer to the delete guards, which had to start
   counting voided documents. The two look alike and are not: that one asks
   "is this still referenced", this asks "what should the number be". */
{
  const line = { itemId: "T", qty: 3, price: 100 };
  const base = {
    purchases: [] as Invoice[],
    saleReturns: [] as Return[],
    purchaseReturns: [] as Return[],
    stockAdjustments: [] as StockAdjustment[],
    sales: [{ id: "S", lineItems: [line] }] as unknown as Invoice[],
  };

  const plain = planStockRepair({
    ...base,
    items: [{ id: "T", name: "Adapter", openingStock: 10, stock: 10 }] as unknown as Item[],
  });
  assert(
    plain.length === 1 && plain[0].correct === 7,
    `T37: an ordinary item is still rebuilt from its documents — ${JSON.stringify(plain)}`,
  );

  const tracked = planStockRepair({
    ...base,
    items: [
      { id: "T", name: "Adapter", openingStock: 10, stock: 10, trackSerials: true },
    ] as unknown as Item[],
  });
  assert(
    tracked.length === 0,
    `T37: a serialised item is left alone — its serials are the stock, and this would overwrite them — ${JSON.stringify(tracked)}`,
  );
}

/* ═══ TEST 38: the rule the whole feature rests on ══════════════════════
   Serial count equals line quantity, and the document will not save
   otherwise. Without it the data rots inside a month, and a warranty screen
   that is confidently wrong is worse than no warranty screen at all. */
{
  const tracked = { id: "T", trackSerials: true };
  const plain = { id: "P" };
  const itemOf = (id: string) => (id === "T" ? tracked : plain) as never;

  assert(
    serialShortfalls([{ itemId: "P", name: "Cable", qty: 5 }], itemOf).length === 0,
    "T38: an ordinary item is never asked for serials",
  );
  assert(
    serialShortfalls([{ itemId: "T", name: "Adapter", qty: 2, serialIds: ["a", "b"] }], itemOf)
      .length === 0,
    "T38: a matched line passes",
  );
  const short = serialShortfalls(
    [{ itemId: "T", name: "Adapter", qty: 3, serialIds: ["a"] }],
    itemOf,
  );
  assert(
    short.length === 1 && short[0].includes("2 serials still to scan"),
    `T38: a short line says how many are missing — ${short[0]}`,
  );
  const over = serialShortfalls(
    [{ itemId: "T", name: "Adapter", qty: 1, serialIds: ["a", "b"] }],
    itemOf,
  );
  assert(
    over.length === 1 && over[0].includes("more serials than quantity"),
    `T38: and too many is refused just as firmly — ${over[0]}`,
  );
  assert(
    serialShortfalls([{ itemId: "T", name: "Adapter", qty: 1 }], itemOf).length === 1,
    "T38: a serialised line with no serials at all is short, not exempt",
  );
}

/* ═══ TEST 39: what a purchase and a sale do to the units ═══════════════
   Only a document moves a serial. These are the two that matter most, and
   the edit paths — where a unit is taken off a bill it used to be on — are
   where the mistakes live. */
{
  const item = {
    id: "T",
    name: "Adapter",
    trackSerials: true,
    warrantyMonths: 12,
    vendorWarrantyMonths: 24,
  } as unknown as Item;
  const itemOf = (id: string) => (id === "T" ? item : undefined);

  const bill = (over: Record<string, unknown> = {}) =>
    ({
      id: "PB1",
      number: "PB-1",
      date: "2026-05-10",
      partyId: "V1",
      partyName: "Mehta Distributors",
      lineItems: [{ id: "l1", itemId: "T", name: "Adapter", qty: 2, price: 1180, serialIds: [] }],
      total: 2360,
      ...over,
    }) as unknown as Invoice;

  /* Receiving. Two scanned units do not exist yet — they are drafts, and
     become records only when the bill saves. Writing them the moment they
     are scanned would leave orphan stock behind every time somebody opened a
     purchase and changed their mind. */
  const received = bill();
  received.lineItems[0].serialIds = ["draft:AAA1", "draft:AAA2"];
  const p1 = planPurchaseSerials(received, null, itemOf);
  assert(p1.create.length === 2, `T39: both scanned units are created — ${p1.create.length}`);
  assert(
    p1.create.every((c) => c.itemId === "T") && p1.create[0].serial === "AAA1",
    "T39: under the right item, with the serial that was scanned",
  );
  assert(p1.update.length === 0 && p1.release.length === 0, "T39: and nothing else moves");

  /* Editing the bill: one unit taken off. It never arrived, so it stops
     being stock — but the record of it survives, like every other
     cancellation in this application. */
  const before = bill();
  before.lineItems[0].serialIds = ["s1", "s2"];
  const after = bill();
  after.lineItems[0].serialIds = ["s1"];
  const p2 = planPurchaseSerials(after, before, itemOf);
  assert(
    p2.release.length === 1 && p2.release[0].id === "s2",
    `T39: the unit taken off the bill is released — ${JSON.stringify(p2.release)}`,
  );
  /* Guarded. Without it the assertion above fails correctly and then this
     line throws on an empty array, killing the run before it can report —
     the harness has no per-block catch, so one broken rule would hide the
     other hundred thousand assertions. */
  if (p2.release[0]) {
    assert(
      !!(p2.release[0].patch as { voidedAt?: string }).voidedAt,
      "T39: by being marked, not by being deleted",
    );
  }
  assert(
    p2.update.length === 1 && p2.update[0].id === "s1",
    "T39: and the one still on it is re-stamped, in case the date or price changed",
  );
  assert(
    (p2.update[0].patch as { cost?: number }).cost === 1180,
    `T39: with what THIS unit cost — ${(p2.update[0].patch as { cost?: number }).cost}`,
  );
  assert(
    (p2.update[0].patch as { vendorWarrantyEnd?: string }).vendorWarrantyEnd === "2028-05-10",
    `T39: and the shop's own claim window against the vendor — ${(p2.update[0].patch as { vendorWarrantyEnd?: string }).vendorWarrantyEnd}`,
  );

  /* Selling. */
  const sale = bill({
    id: "S1",
    number: "INV-1",
    date: "2026-06-01",
    partyId: "C1",
    partyName: "Ramesh",
  });
  sale.lineItems[0].serialIds = ["s1", "s2"];
  const p3 = planSaleSerials(sale, null, itemOf);
  assert(p3.update.length === 2, "T39: both units are marked sold");
  const patch = p3.update[0].patch as Record<string, unknown>;
  assert(patch.status === "sold", "T39: off the shelf");
  assert(
    patch.customerName === "Ramesh" && patch.saleDate === "2026-06-01",
    "T39: with who bought it and when — the two things a warranty claim needs",
  );
  assert(
    patch.warrantyEnd === "2027-06-01" && patch.warrantyMonths === 12,
    `T39: and the warranty it was sold with — ${patch.warrantyEnd}`,
  );

  /* Taking a unit off a sale on an edit. It goes back on the shelf AND
     forgets who had it: leaving a customer's name on a unit that is back in
     stock is how a warranty lookup ends up naming the wrong person. */
  const soldBefore = bill({ id: "S1", date: "2026-06-01" });
  soldBefore.lineItems[0].serialIds = ["s1", "s2"];
  const soldAfter = bill({ id: "S1", date: "2026-06-01" });
  soldAfter.lineItems[0].serialIds = ["s1"];
  const p4 = planSaleSerials(soldAfter, soldBefore, itemOf);
  assert(p4.release.length === 1 && p4.release[0].id === "s2", "T39: the removed unit is released");
  const back = p4.release[0].patch as Record<string, unknown>;
  assert(back.status === "in_stock", "T39: back on the shelf");
  /* The KEYS must be present and undefined, not merely absent. The write is a
     full set() of the merged record with undefined stripped, so a key that is
     present-and-undefined disappears from the stored document while a key
     that was never mentioned keeps whatever it had. Checking "=== undefined"
     alone cannot tell those two apart, and only one of them actually forgets
     the customer. */
  for (const k of [
    "customerName",
    "customerId",
    "saleId",
    "saleDate",
    "warrantyEnd",
    "warrantyMonths",
  ]) {
    assert(
      Object.prototype.hasOwnProperty.call(back, k) && back[k] === undefined,
      `T39: releasing a unit clears ${k} explicitly, so the stored record loses it — ${JSON.stringify(back)}`,
    );
  }
  assert(
    back.customerName === undefined && back.saleId === undefined,
    "T39: and the customer forgotten with it",
  );

  /* An ordinary item is never touched by any of this. */
  const plainBill = bill();
  plainBill.lineItems[0].itemId = "OTHER";
  plainBill.lineItems[0].serialIds = ["draft:X"];
  const p5 = planPurchaseSerials(plainBill, null, itemOf);
  assert(
    p5.create.length === 0 && p5.update.length === 0,
    "T39: an item that is not serialised moves no units, whatever is on the line",
  );
}

/* ═══ TEST 40: a unit in a customer's hands cannot be un-received ═══════
   The shop's record of where a unit came from is the only thing that lets
   them claim a faulty one back from the vendor. Editing that purchase out
   from under a sold unit would destroy exactly that. */
{
  const inv = {
    id: "PB1",
    lineItems: [{ id: "l", itemId: "T", qty: 2, serialIds: ["s1", "s2"] }],
  } as unknown as Invoice;
  const serials = [
    { id: "s1", itemId: "T", serial: "A1", status: "sold" },
    { id: "s2", itemId: "T", serial: "A2", status: "in_stock" },
  ] as unknown as Serial[];

  const sold = soldSerialsOf(inv, serials);
  assert(
    sold.length === 1 && sold[0].serial === "A1",
    `T40: the unit already sold is named — ${JSON.stringify(sold.map((s) => s.serial))}`,
  );
  assert(
    soldSerialsOf(inv, serials, new Set(["s2"])).length === 0,
    "T40: and a unit still on the shelf is no obstacle to removing it",
  );
  assert(
    soldSerialsOf(inv, serials, new Set(["s1"])).length === 1,
    "T40: while removing the sold one is refused",
  );
}

/* ═══ TEST 41: undoing a document puts its units back ═══════════════════
   Deleting and voiding need exactly the same serial movements — the document
   stops counting either way — so they share one answer rather than two that
   drift apart silently until a shelf count goes wrong. */
{
  const item = { id: "T", trackSerials: true } as unknown as Item;
  const itemOf = (id: string) => (id === "T" ? item : undefined);
  const doc = { lineItems: [{ itemId: "T", serialIds: ["s1", "s2"] }] };

  const undoneSale = undoSerialsOf(doc, "sale", itemOf);
  assert(undoneSale.length === 2, "T41: every unit on the bill moves");
  assert(
    (undoneSale[0].patch as Record<string, unknown>).status === "in_stock",
    "T41: a cancelled sale puts them back on the shelf",
  );
  assert(
    Object.prototype.hasOwnProperty.call(undoneSale[0].patch, "customerName"),
    "T41: and forgets the customer explicitly, so the stored record loses it",
  );

  const undonePurchase = undoSerialsOf(doc, "purchase", itemOf);
  assert(
    !!(undonePurchase[0].patch as { voidedAt?: string }).voidedAt,
    "T41: a cancelled purchase means the units never arrived",
  );
  assert(
    (undonePurchase[0].patch as Record<string, unknown>).status === undefined,
    "T41: marked rather than restatused — the record survives, the count does not",
  );

  assert(
    (undoSerialsOf(doc, "sale-return", itemOf)[0].patch as Record<string, unknown>).status ===
      "sold",
    "T41: undoing a sale return means the customer still has it",
  );
  assert(
    (undoSerialsOf(doc, "purchase-return", itemOf)[0].patch as Record<string, unknown>).status ===
      "in_stock",
    "T41: undoing a purchase return means it never went back to the vendor",
  );

  const plain = { lineItems: [{ itemId: "OTHER", serialIds: ["x"] }] };
  assert(
    undoSerialsOf(plain, "sale", itemOf).length === 0,
    "T41: an item that is not serialised moves nothing, whatever is on the line",
  );
}

/* ═══ TEST 42: looking a unit up by what is printed on it ═══════════════
   The counter's search, not the accountant's: somebody is holding an adapter
   and wants to know whether the shop still owes them a warranty. They do not
   know the item id, and half the time they are reading the last characters
   down a phone line. */
{
  const serials = [
    { id: "s1", itemId: "A", serial: "F2LX9K3", status: "sold" },
    { id: "s2", itemId: "B", serial: "F2LX9K3", status: "in_stock" },
    { id: "s3", itemId: "A", serial: "QQ119K3", status: "in_stock" },
    { id: "s4", itemId: "A", serial: "ZZZ0001", status: "in_stock" },
  ] as unknown as Serial[];

  const exact = lookupSerials("f2lx9k3", serials);
  assert(exact.hits.length === 2, "T42: an exact match on two items returns both");
  assert(!exact.partial, "T42: and is not reported as a guess");
  assert(
    lookupSerials("  F2LX9K3 ", serials).hits.length === 2,
    "T42: a scanner's stray space and case change nothing",
  );

  const tail = lookupSerials("9K3", serials);
  assert(
    tail.hits.length === 3 && tail.partial,
    `T42: read out from the end, it matches every unit ending that way — got ${tail.hits.length}`,
  );
  // "K3" genuinely ends three of these — so this only passes because the
  // length floor refuses it, not because the search happened to find nothing.
  assert(
    lookupSerials("K3", serials).hits.length === 0,
    "T42: two characters is too loose to mean anything, so it answers nothing",
  );
  assert(
    lookupSerials("F2L", serials).hits.length === 0,
    "T42: and it is ends-with, not contains — a prefix is not a match",
  );
  assert(lookupSerials("", serials).hits.length === 0, "T42: an empty box searches for nothing");

  const many = Array.from({ length: SERIAL_MATCH_LIMIT + 5 }, (_, i) => ({
    id: `m${i}`,
    itemId: "A",
    serial: `X${i}999`,
    status: "in_stock",
  })) as unknown as Serial[];
  const flood = lookupSerials("999", many);
  assert(
    flood.hits.length === SERIAL_MATCH_LIMIT && flood.truncated,
    "T42: a search that matches the whole shelf says so rather than listing it",
  );
}

/* ═══ TEST 43: is it still under warranty? ══════════════════════════════
   "No warranty was given" and "the warranty has run out" lead to different
   conversations. Collapsing them into one "not covered" is how a shop refuses
   a repair it had in fact promised. */
{
  const TODAY = "2026-06-15";
  const sold = (warrantyEnd?: string) =>
    warrantyState({ status: "sold", warrantyEnd } as Serial, TODAY);

  assert(
    warrantyState({ status: "in_stock", warrantyEnd: "2027-01-01" } as Serial, TODAY).tone ===
      "none",
    "T43: a unit on the shelf has no promise running, whatever date is left on it",
  );
  assert(
    sold(undefined).label.includes("no warranty recorded"),
    "T43: sold with no warranty says so, and does not say expired",
  );
  assert(sold("2027-06-15").tone === "ok", "T43: a year out is simply covered");
  assert(
    sold("2026-07-01").tone === "expiring",
    "T43: inside a month, the counter is told before being asked",
  );
  // Zero is the last covered day, not the first uncovered one — a warranty
  // "until the 15th" is honoured on the 15th, which is the day the customer
  // actually turns up.
  assert(sold(TODAY).tone === "expiring", "T43: the last day is still a covered day");
  assert(sold(TODAY).label === "Warranty ends today", "T43: and is said in those words");
  assert(sold("2026-06-14").tone === "expired", "T43: the day after is not");
  assert(
    sold("2026-06-14").label.includes("1 day ago"),
    `T43: singular when it is one day — "${sold("2026-06-14").label}"`,
  );
  assert(
    sold("2026-06-13").label.includes("2 days ago"),
    "T43: plural when it is more, because it will be read out loud",
  );

  assert(
    vendorClaimState({ vendorWarrantyEnd: "2026-12-01" } as Serial, TODAY).tone === "ok",
    "T43: the shop's own claim window is answered separately from the customer's",
  );
  assert(
    vendorClaimState({ vendorWarrantyEnd: "2026-01-01" } as Serial, TODAY).tone === "expired",
    "T43: a closed vendor window is the half that quietly costs money",
  );
  assert(
    vendorClaimState({} as Serial, TODAY).tone === "none",
    "T43: and an unrecorded one is not silently treated as open",
  );
}

/* ═══ TEST 44: a sale return takes named units back ═════════════════════
   The unit really was sold to that customer and really did come back. Both
   halves are the record — erasing the first is what makes a return
   impossible to undo correctly. */
{
  const item = { id: "T", trackSerials: true } as unknown as Item;
  const itemOf = (id: string) => (id === "T" ? item : undefined);
  const ret = {
    id: "CR1",
    date: "2026-06-10",
    lineItems: [{ itemId: "T", serialIds: ["s1", "s2"] }],
  } as unknown as Return;

  const p = planSaleReturnSerials(ret, null, itemOf);
  assert(p.update.length === 2, "T44: every unit named on the note moves");
  const patch = p.update[0].patch as Record<string, unknown>;
  assert(patch.status === "in_stock", "T44: a returned unit goes back on the shelf");
  assert(patch.returnId === "CR1", "T44: stamped with the note that brought it back");
  assert(patch.returnDate === "2026-06-10", "T44: and when");
  // The sale must survive: it is the trail, and it is what undoing this
  // return puts back. A patch that MENTIONED these keys would clear them,
  // because a full set() strips undefined.
  assert(
    !Object.prototype.hasOwnProperty.call(patch, "customerName"),
    "T44: the customer who had it is not erased — the return is not a denial of the sale",
  );
  assert(
    !Object.prototype.hasOwnProperty.call(patch, "saleId"),
    "T44: nor which bill it went out on",
  );

  // A warranty failure is the commonest sale return there is.
  const faulty = planSaleReturnSerials({ ...ret, unitsDamaged: true }, null, itemOf);
  assert(
    (faulty.update[0].patch as Record<string, unknown>).status === "damaged",
    "T44: a faulty unit is marked damaged, not put back on the sellable shelf",
  );

  // Taken off the note before saving: it did not come back after all.
  const edited = planSaleReturnSerials(
    { ...ret, lineItems: [{ itemId: "T", serialIds: ["s1"] }] } as unknown as Return,
    ret,
    itemOf,
  );
  assert(edited.release.length === 1, "T44: a unit removed from the note is put back as it was");
  const rel = edited.release[0].patch as Record<string, unknown>;
  assert(rel.status === "sold", "T44: which means it is with the customer again");
  assert(
    Object.prototype.hasOwnProperty.call(rel, "returnId") && rel.returnId === undefined,
    "T44: and the note is cleared explicitly, not merely left unmentioned",
  );

  const plain = { ...ret, lineItems: [{ itemId: "OTHER", serialIds: ["x"] }] } as unknown as Return;
  assert(
    planSaleReturnSerials(plain, null, itemOf).update.length === 0,
    "T44: an item that is not serialised moves nothing, whatever is on the line",
  );
}

/* ═══ TEST 45: a purchase return sends named units back to the vendor ═══
   These leave for good, which is why they stop counting as stock without
   being deleted — the shop still has to say where a unit went. */
{
  const item = { id: "T", trackSerials: true } as unknown as Item;
  const itemOf = (id: string) => (id === "T" ? item : undefined);
  const ret = {
    id: "DR1",
    date: "2026-06-11",
    lineItems: [{ itemId: "T", serialIds: ["s1"] }],
  } as unknown as Return;

  const p = planPurchaseReturnSerials(ret, null, itemOf);
  const patch = p.update[0].patch as Record<string, unknown>;
  assert(patch.status === "returned_to_vendor", "T45: the unit goes back to the vendor");
  assert(patch.returnId === "DR1", "T45: stamped with the note that sent it");
  assert(
    !Object.prototype.hasOwnProperty.call(patch, "purchaseId"),
    "T45: and keeps where it came from, which is the whole point of the record",
  );

  const edited = planPurchaseReturnSerials(
    { ...ret, lineItems: [] } as unknown as Return,
    ret,
    itemOf,
  );
  assert(
    (edited.release[0].patch as Record<string, unknown>).status === "in_stock",
    "T45: a unit taken off the note never left the shop",
  );
}

/* ═══ TEST 46: undoing a return clears the note as well as the status ═══
   A status put back while the note id stayed would leave a unit claiming to
   have been returned by a document that no longer counts. */
{
  const item = { id: "T", trackSerials: true } as unknown as Item;
  const itemOf = (id: string) => (id === "T" ? item : undefined);
  const doc = { lineItems: [{ itemId: "T", serialIds: ["s1"] }] };

  for (const kind of ["sale-return", "purchase-return"] as const) {
    const patch = undoSerialsOf(doc, kind, itemOf)[0].patch as Record<string, unknown>;
    assert(
      Object.prototype.hasOwnProperty.call(patch, "returnId") && patch.returnId === undefined,
      `T46: cancelling a ${kind} clears the note off the unit explicitly`,
    );
    assert(
      Object.prototype.hasOwnProperty.call(patch, "returnDate") && patch.returnDate === undefined,
      `T46: including the date, so nothing is left half-set on a ${kind}`,
    );
  }
}

/* ═══ TEST 47: does the unit list still agree with the documents? ═══════
   A serial's status is not derived, it is MOVED, one document at a time. Miss
   a move and nothing else in the app notices — the shelf count comes from the
   units, so the shop keeps trading on a figure that has quietly stopped being
   true. This is the only thing looking. */
{
  const items = [
    { id: "A", name: "Apple 20W Adapter", trackSerials: true },
    { id: "P", name: "USB Cable" },
  ] as unknown as Item[];
  const base = {
    items,
    sales: [] as Invoice[],
    purchases: [] as Invoice[],
    saleReturns: [] as Return[],
    purchaseReturns: [] as Return[],
  };
  const unit = (over: Record<string, unknown>) =>
    ({ id: "u1", itemId: "A", serial: "SN1", status: "in_stock", ...over }) as unknown as Serial;
  const bill = (number: string, serialIds: string[], qty = serialIds.length) =>
    ({ number, lineItems: [{ itemId: "A", qty, serialIds }] }) as unknown as Invoice;

  // Nothing wrong: a sold unit with a bill that sold it.
  const clean = checkSerialIntegrity({
    ...base,
    serials: [unit({ status: "sold" })],
    sales: [bill("INV-1", ["u1"])],
  });
  assert(
    clean.issues.length === 0,
    `T47: a shop in order reports nothing — ${JSON.stringify(clean.issues)}`,
  );
  assert(clean.checked === 1, "T47: and says how many units it actually looked at");

  // The move that got missed: the bill is gone, the unit still says sold.
  const ghost = checkSerialIntegrity({ ...base, serials: [unit({ status: "sold" })] });
  assert(ghost.issues[0]?.kind === "sold-but-no-bill", "T47: a unit sold by nothing is found");
  assert(
    // ?? "": a bare .message here throws when the array is empty, which
    // kills the run and reports NOTHING instead of failing this one line.
    (ghost.issues[0]?.message ?? "").includes("one short"),
    "T47: and says which way the shelf count is wrong, because that is the consequence",
  );

  // The opposite: counted on the shelf while a live bill still holds it.
  const over = checkSerialIntegrity({
    ...base,
    serials: [unit({ status: "in_stock" })],
    sales: [bill("INV-2", ["u1"])],
  });
  assert(
    over.issues[0]?.kind === "in-stock-but-still-sold",
    "T47: a unit on the shelf that a live bill sold is found",
  );
  assert(
    (over.issues[0]?.message ?? "").includes("INV-2"),
    "T47: naming the bill, so it can be looked at",
  );

  // Sold, then returned. Back on the shelf WITH the sale still named on it —
  // that is the design, and it must not be reported as a fault.
  const returned = checkSerialIntegrity({
    ...base,
    serials: [unit({ status: "in_stock" })],
    sales: [bill("INV-3", ["u1"])],
    saleReturns: [
      {
        number: "CR-1",
        lineItems: [{ itemId: "A", qty: 1, serialIds: ["u1"] }],
      } as unknown as Return,
    ],
  });
  assert(
    returned.issues.length === 0,
    `T47: a returned unit is back on the shelf legitimately, not a fault — ${JSON.stringify(returned.issues)}`,
  );

  // The same unit on two live bills.
  const twice = checkSerialIntegrity({
    ...base,
    serials: [unit({ status: "sold" })],
    sales: [bill("INV-4", ["u1"]), bill("INV-5", ["u1"])],
  });
  assert(
    twice.issues.some((i) => i.kind === "on-two-bills"),
    "T47: one unit sold on two bills is found",
  );

  // A line that names SOME of its units. The form cannot produce this; a
  // console edit or a bug can, and it is exactly what nothing else catches.
  const half = checkSerialIntegrity({
    ...base,
    serials: [unit({ status: "sold" })],
    sales: [bill("INV-6", ["u1"], 3)],
  });
  assert(
    half.issues.some((i) => i.kind === "line-count-mismatch"),
    "T47: a line crediting three units while naming one is found",
  );

  // Naming NONE is the legacy case — the item was switched on after the bill
  // was written, and there is no way to invent units for it afterwards.
  const legacy = checkSerialIntegrity({
    ...base,
    serials: [],
    sales: [bill("INV-7", [], 3)],
  });
  assert(
    legacy.issues.length === 0,
    `T47: a bill written before the item was tracked is not a fault — ${JSON.stringify(legacy.issues)}`,
  );
  assert(
    legacy.untrackedLines === 1,
    "T47: but it is counted, because 'is my history complete' is a fair question",
  );

  // An ordinary item's line is not checked at all, whatever is on it.
  const plain = checkSerialIntegrity({
    ...base,
    serials: [],
    sales: [
      {
        number: "INV-8",
        lineItems: [{ itemId: "P", qty: 5, serialIds: [] }],
      } as unknown as Invoice,
    ],
  });
  assert(
    plain.issues.length === 0 && plain.untrackedLines === 0,
    "T47: an item that is not tracked by serial is none of this check's business",
  );

  // Two units of the same item with the same number: one is a mis-scan.
  const dupe = checkSerialIntegrity({
    ...base,
    serials: [unit({ id: "u1" }), unit({ id: "u2", serial: "sn1 " })],
  });
  assert(
    dupe.issues.some((i) => i.kind === "duplicate-serial"),
    "T47: the same number twice on one item is found, ignoring case and space",
  );

  // …but the SAME string on a DIFFERENT item is legitimate: two makers can
  // stamp the same thing, which is why uniqueness was never global.
  const shared = checkSerialIntegrity({
    ...base,
    items: [...items, { id: "B", name: "Other Adapter", trackSerials: true }] as unknown as Item[],
    serials: [unit({ id: "u1" }), unit({ id: "u2", itemId: "B" })],
  });
  assert(
    !shared.issues.some((i) => i.kind === "duplicate-serial"),
    "T47: and the same number on two different items is not a fault",
  );

  /* Item "AB" + serial "1" and item "A" + serial "B1" both read "AB1" if the
     two are simply glued together. Neither is a duplicate of the other, and
     an undelimited key would call them one — which is precisely the bug a
     stray byte in the separator produced once. */
  const glued = checkSerialIntegrity({
    ...base,
    items: [
      { id: "AB", name: "First", trackSerials: true },
      { id: "A", name: "Second", trackSerials: true },
    ] as unknown as Item[],
    serials: [
      unit({ id: "g1", itemId: "AB", serial: "1" }),
      unit({ id: "g2", itemId: "A", serial: "B1" }),
    ],
  });
  assert(
    !glued.issues.some((i) => i.kind === "duplicate-serial"),
    "T47: the item and the number are kept apart, so two units cannot collide by running together",
  );

  const orphan = checkSerialIntegrity({ ...base, serials: [unit({ itemId: "GONE" })] });
  assert(orphan.issues[0]?.kind === "unknown-item", "T47: a unit of a deleted item is found");

  const vendor = checkSerialIntegrity({
    ...base,
    serials: [unit({ status: "returned_to_vendor" })],
  });
  assert(
    vendor.issues[0]?.kind === "returned-but-no-note",
    "T47: a unit sent back with no debit note behind it is found",
  );
}

/* ═══ TEST 48: a named unit is costed at what THAT unit cost ════════════
   An ordinary item can only be costed on an average: twelve identical cables
   arrived at three prices and nobody can say which one left. A serialised
   item has no such excuse — the unit that went is named on the bill, and what
   it cost was stamped on it the day it arrived. */
{
  const costs = serialCostIndex([
    { id: "s1", cost: 1000 },
    // 1500, not 1400: at 1400 the exact sum (2400) equals 2 x the 1200
    // snapshot, and every assertion below would pass on either basis.
    { id: "s2", cost: 1500 },
    { id: "s3" },
  ] as unknown as Serial[]);
  assert(costs.size === 2, "T48: a unit with no recorded cost is not a unit costing zero");

  const fallback = () => 1200;

  const exact = lineCostBasis(
    { itemId: "A", qty: 2, costPrice: 1200, serialIds: ["s1", "s2"] },
    costs,
    fallback,
  );
  assert(exact.exact, "T48: a line whose units are all costed is costed exactly");
  assert(
    exact.amount === 2500,
    `T48: at the sum of what those two units cost, not 2 x the average of 2400 — ${exact.amount}`,
  );

  // One basis per line, never a mixture: a half-exact figure is neither, and
  // nobody could later say which lines it applied to.
  const partial = lineCostBasis(
    { itemId: "A", qty: 2, costPrice: 1200, serialIds: ["s1", "s3"] },
    costs,
    fallback,
  );
  assert(!partial.exact, "T48: one uncosted unit drops the WHOLE line back to the snapshot");
  assert(partial.amount === 2400, `T48: which is qty x the snapshot — ${partial.amount}`);

  const plain = lineCostBasis({ itemId: "A", qty: 3, costPrice: 100 }, costs, fallback);
  assert(
    !plain.exact && plain.amount === 300,
    "T48: a line that names no units is costed the way it always was",
  );

  const legacy = lineCostBasis({ itemId: "A", qty: 2 }, costs, fallback);
  assert(
    legacy.amount === 2400,
    "T48: and one saved before costPrice existed falls back to the item's price",
  );
}

/* ═══ TEST 49: the ledger and the P&L must cost goods the same way ══════
   Reports → Ledger Reconciliation compares these two directly. If one moves
   to exact serial costing and the other does not, the difference is not
   rounding — it is a permanent gap the size of the shop's entire
   serial-tracked margin, reported forever as a fault that cannot be fixed. */
{
  const items = [
    { id: "A", name: "Adapter", trackSerials: true, purchasePrice: 1200, salePrice: 1900 },
  ] as unknown as Item[];
  const serials = [
    { id: "s1", itemId: "A", serial: "X1", status: "sold", cost: 1000 },
    { id: "s2", itemId: "A", serial: "X2", status: "sold", cost: 1500 },
  ] as unknown as Serial[];
  const sale = {
    id: "S1",
    number: "INV-1",
    date: "2026-06-01",
    partyId: "P1",
    partyName: "A Customer",
    gstEnabled: false,
    lineItems: [
      {
        id: "L1",
        itemId: "A",
        name: "Adapter",
        unit: "pcs",
        qty: 2,
        price: 1900,
        discountPct: 0,
        gstRate: 0,
        costPrice: 1200,
        amount: 3800,
        serialIds: ["s1", "s2"],
      },
    ],
    subtotal: 3800,
    discount: 0,
    shippingCharge: 0,
    taxAmount: 0,
    total: 3800,
    paid: 3800,
    paymentMode: "cash",
    createdAt: "2026-06-01T09:00:00Z",
  } as unknown as Invoice;

  const appCogs = computeCogs([sale], [], items, serials);
  assert(
    appCogs === 2500,
    `T49: the P&L costs the two named units at 1000 + 1500, not 2 x 1200 — ${appCogs}`,
  );

  const book = {
    parties: [],
    items,
    banks: [],
    sales: [sale],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
    expenses: [],
    cashAdjustments: [],
    bankTxns: [],
    stockAdjustments: [],
    serials,
  } as unknown as Book;
  const entries = buildJournal(book);
  const cogsPostings = entries
    .flatMap((e) => e.lines)
    .filter((l) => l.accountId === "cogs")
    .reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0);
  assert(
    Math.abs(cogsPostings - 2500) < 0.005,
    `T49: and the posting ledger charges the identical figure — ${cogsPostings}`,
  );
  assert(
    Math.abs(cogsPostings - appCogs) < 0.005,
    "T49: the two bases agree, which is the only reason reconciliation can compare them",
  );

  // A sale return gives the same units back at the same cost, so a bill
  // returned in full leaves no profit and no COGS behind it.
  const ret = {
    id: "R1",
    number: "CR-1",
    date: "2026-06-02",
    partyId: "P1",
    partyName: "A Customer",
    gstEnabled: false,
    lineItems: [
      {
        id: "RL1",
        itemId: "A",
        name: "Adapter",
        unit: "pcs",
        qty: 2,
        price: 1900,
        discountPct: 0,
        gstRate: 0,
        costPrice: 1200,
        amount: 3800,
        serialIds: ["s1", "s2"],
      },
    ],
    subtotal: 3800,
    taxAmount: 0,
    total: 3800,
    createdAt: "2026-06-02T09:00:00Z",
  } as unknown as Return;
  assert(
    computeCogs([sale], [ret], items, serials) === 0,
    "T49: a bill returned in full costs nothing, on the same exact basis both ways",
  );

  /* And the screen that actually compares them agrees. This is the assertion
     that matters: reconcile() is what the shop opens to decide whether to
     trust the ledger, and a basis mismatch would show there as a red row it
     could never clear — the gap is structural, not a data error. */
  const recon = reconcile(book);
  const profitRow = recon.rows.find((r) => /profit/i.test(r.label));
  assert(!!profitRow, "T49: reconciliation has a profit row to compare at all");
  assert(
    Math.abs(profitRow?.diff ?? 1) < 0.02,
    `T49: and it reports no gap for a book of serial-tracked sales — ${JSON.stringify(profitRow)}`,
  );
}

/* ═══ TEST 50: units cannot follow a line to a different item ═══════════
   Changing the item on a line keeps its quantity and discount, which is the
   point of the feature. Its SERIALS are the one thing that cannot come with
   it: a serial belongs to the item it was stamped on, so carrying them over
   would mark units of one item as sold on a line for another and leave the
   shelf count for both wrong from that moment.

   Asserted on the library the save path uses, because that is what turns a
   stale id into a written record. */
{
  const adapter = { id: "A", name: "Adapter", trackSerials: true } as unknown as Item;
  const cable = { id: "C", name: "Cable" } as unknown as Item;
  const itemOf = (id: string) => (id === "A" ? adapter : id === "C" ? cable : undefined);

  // A line that still carried the adapter's units after being changed to the
  // cable: the cable is not serialised, so nothing should move at all.
  const stale = {
    id: "S1",
    date: "2026-06-01",
    partyId: "P",
    partyName: "X",
    lineItems: [{ itemId: "C", qty: 1, serialIds: ["u1"] }],
  } as unknown as Invoice;
  assert(
    planSaleSerials(stale, null, itemOf).update.length === 0,
    "T50: a line whose item is not serialised moves no units, whatever ids are stuck to it",
  );

  // And the reverse: ids belonging to the OLD item on a line that is now a
  // serialised one is exactly the corruption the form must not produce.
  const wrong = {
    ...stale,
    lineItems: [{ itemId: "A", qty: 1, serialIds: ["u-belongs-to-cable"] }],
  } as unknown as Invoice;
  assert(
    planSaleSerials(wrong, null, itemOf).update[0]?.id === "u-belongs-to-cable",
    "T50: which is why the FORM clears them on a change rather than the plan guessing",
  );
}

/* ═══ TEST S1: splits describe today's documents without changing them ══
   The seam has one job before anything can create a split: report, for every
   document that already exists, exactly the attribution the current readers
   compute. If it disagrees with them by a rupee, routing them through it
   moves money on screens the shop is using right now. */
{
  const cashBill = { paid: 1000, paymentMode: "cash" } as unknown as Invoice;
  assert(splitsOf(cashBill).length === 1, "S1: a cash bill is one row");
  assert(cashPart(cashBill) === 1000, "S1: and all of it is in the drawer");
  assert(bankParts(cashBill).size === 0, "S1: with no account involved");

  /* A bank bill reports bankPaidAmount, NOT paid. They differ whenever a
     receipt was allocated to this invoice afterwards, and the bank ledger has
     always used the smaller figure — reporting paid here would credit the
     account with money that arrived as a separate Payment. */
  const bankBill = {
    paid: 5000,
    paymentMode: "bank",
    bankId: "B1",
    bankPaidAmount: 3000,
  } as unknown as Invoice;
  assert(bankParts(bankBill).get("B1") === 3000, "S1: a bank bill reports what it attributed");
  assert(
    cashPart(bankBill) === 0,
    "S1: and nothing to cash — the rest of paid came from a Payment with its own mode",
  );

  // Credit is the absence of payment, not a way of paying.
  assert(
    splitsOf({ paid: 0, paymentMode: "credit" } as unknown as Invoice).length === 0,
    "S1: a credit bill attributes nothing",
  );
  assert(
    splitsOf({ paid: 0, paymentMode: "cash" } as unknown as Invoice).length === 0,
    "S1: nor does an unpaid one, whatever mode it names",
  );

  /* upi and cheque name no account. That is a pre-existing wart the daybook
     already buckets, and it must stay visible rather than being quietly
     credited to some account it never reached. */
  const upi = { paid: 700, paymentMode: "upi" } as unknown as Invoice;
  assert(bankParts(upi).size === 0, "S1: unassigned money is not credited to an account");
  assert(cashPart(upi) === 0, "S1: nor counted as cash");
  assert(unassignedPart(upi) === 700, "S1: it is reported as unassigned, which is the truth");

  // Payments and expenses use different field names for the same idea.
  assert(
    cashPart({ amount: 250, mode: "cash" } as unknown as Payment) === 250,
    "S1: a Payment reads the same way",
  );
  assert(
    bankParts({ amount: 400, paymentMode: "bank", bankId: "B2" } as unknown as Expense).get(
      "B2",
    ) === 400,
    "S1: and so does an Expense",
  );

  /* Money that reached the document LATER belongs to the Payment that
     brought it, which carries its own mode and is counted there. A legacy
     document reports its amount less that; stored rows are already the
     document's own portion and must not be reduced a second time. Getting
     either direction wrong is a wrong number on the Cash page. */
  assert(
    cashPart({ paid: 1000, paymentMode: "cash" } as unknown as Invoice, 400) === 600,
    "S1: a legacy row reports only what the document itself settled",
  );
  assert(
    cashPart({ paid: 1000, paymentMode: "cash" } as unknown as Invoice, 1000) === 0,
    "S1: and nothing at all once every rupee of it arrived later",
  );
  assert(
    bankParts(bankBill, 2000).get("B1") === 3000,
    "S1: a legacy bank row is already the at-billing snapshot, so it is NOT reduced again",
  );

  // Stored rows win, and are the only case with more than one.
  const split = {
    paid: 10000,
    paymentMode: "cash",
    paidSplits: [
      { mode: "cash", amount: 4000 },
      { mode: "bank", amount: 6000, bankId: "B1" },
    ],
  } as unknown as Invoice;
  assert(cashPart(split) === 4000, "S1: a split bill reports its cash row");
  assert(
    cashPart(split, 2500) === 4000,
    "S1: and stored rows are the document's own portion already — never reduced twice",
  );
  assert(bankParts(split).get("B1") === 6000, "S1: and its bank row");
  assert(
    cashPart(split) + (bankParts(split).get("B1") ?? 0) === split.paid,
    "S1: and together they are the whole of what was paid",
  );
}

/* ═══ TEST S2: a document may not disagree with itself ══════════════════ */
{
  const ok = [
    { mode: "cash", amount: 4000 },
    { mode: "bank", amount: 6000, bankId: "B1" },
  ] as PaymentSplit[];
  assert(splitProblems(ok, 10000).length === 0, "S2: rows that add up are accepted");
  assert(
    splitProblems(ok, 9500).some((p) => p.message.includes("add up")),
    "S2: rows that do not add up to the amount are refused, and say both figures",
  );
  /* No assertion about sub-paisa dust: splitProblems rounds BOTH sides to
     paise before comparing, so dust cannot reach the comparison at all and
     any test of the tolerance passes with the tolerance removed. The
     tolerance stays as belt-and-braces should the rounding ever go, but
     claiming it is covered would be claiming coverage that does not exist. */
  assert(
    splitProblems([{ mode: "bank", amount: 500 }] as PaymentSplit[], 500).some((p) =>
      p.message.includes("which account"),
    ),
    "S2: bank money must say which account it went to",
  );
  assert(
    splitProblems([{ mode: "cash", amount: 0 }] as PaymentSplit[], 0).some((p) =>
      p.message.includes("enter an amount"),
    ),
    "S2: a row with no amount is not a row",
  );
  assert(
    splitProblems([{ mode: "credit", amount: 100 }] as PaymentSplit[], 100).some((p) =>
      p.message.includes("credit"),
    ),
    "S2: credit is what is left unpaid, not a way of paying",
  );
  assert(splitProblems([], 1000).length === 0, "S2: no rows at all is a single-mode document");
}

/* ═══ TEST S3: a part-cash, part-bank bill reaches BOTH places ══════════
   The reported case: ₹10,000 taken as ₹4,000 cash and ₹6,000 into HDFC.

   The dangerous half is cash. modeFlows used to drop any bill that touched a
   bank, so the ₹6,000 was booked to HDFC correctly and the ₹4,000 simply
   stopped existing — which at the counter reads as the till being short
   rather than as a bug in a report. */
{
  const splitBill = {
    id: "SPL1",
    number: "INV-SPL",
    date: "2026-06-01",
    partyId: "P1",
    partyName: "A Customer",
    lineItems: [],
    total: 10000,
    paid: 10000,
    paymentMode: "cash",
    paidSplits: [
      { mode: "cash", amount: 4000 },
      { mode: "bank", amount: 6000, bankId: "B1" },
    ],
  } as unknown as Invoice;

  const cash = cashFlows([splitBill], [], [], [], []);
  assert(cash.length === 1, `S3: the bill reaches the cash page — ${cash.length} entries`);
  assert(
    netFlow(cash) === 4000,
    `S3: for the cash part only, not the whole bill and not nothing — ${netFlow(cash)}`,
  );

  // And the bank half is still the bank's, counted once.
  assert(
    bankParts(splitBill).get("B1") === 6000,
    "S3: the bank part is attributed to the account it went into",
  );
  assert(
    netFlow(modeFlows("bank", [splitBill], [], [], [])) === 0,
    "S3: and does NOT also appear in the bank-mode flows, which would double it",
  );
  assert(
    r2(netFlow(cash) + (bankParts(splitBill).get("B1") ?? 0)) === splitBill.paid,
    "S3: the two halves account for every rupee of what was paid, exactly once",
  );

  /* The bank half must reach the ACCOUNT's own ledger, not just the
     accessor. This is the mirror of the cash bug: read the account off the
     document's single bankId and a split bill — which has none — shows its
     cash correctly and its bank half nowhere at all. */
  {
    const bank = { id: "B1", name: "HDFC", openingBalance: 0 } as unknown as BankAccount;
    const led = buildBankLedger(bank, {
      sales: [splitBill],
      purchases: [],
      payments: [],
      bankTxns: [],
      expenses: [],
    });
    assert(
      led.rows.some((r) => r.credit === 6000),
      `S3: the account's own ledger shows the bank half — ${JSON.stringify(led.rows.map((r) => r.credit))}`,
    );
    assert(
      r2(led.fullBalance) === 6000,
      `S3: and its balance is that and no more — ${led.fullBalance}`,
    );
    const other = buildBankLedger({ ...bank, id: "B2" } as unknown as BankAccount, {
      sales: [splitBill],
      purchases: [],
      payments: [],
      bankTxns: [],
      expenses: [],
    });
    assert(
      r2(other.fullBalance) === 0,
      "S3: while an account the money never reached shows nothing",
    );
  }

  /* A purchase settled the same way takes money OUT of both. */
  const splitPurchase = {
    ...splitBill,
    id: "SPL2",
    number: "PUR-SPL",
  } as unknown as Invoice;
  assert(
    netFlow(cashFlows([], [splitPurchase], [], [], [])) === -4000,
    "S3: a purchase settled part-cash takes only the cash part out of the drawer",
  );

  /* An ordinary single-mode bill is unaffected — the whole point of the
     accessor is that nothing existing moved. */
  const plainCash = {
    ...splitBill,
    id: "SPL3",
    paidSplits: undefined,
    paid: 800,
    paymentMode: "cash",
  } as unknown as Invoice;
  assert(
    netFlow(cashFlows([plainCash], [], [], [], [])) === 800,
    "S3: a plain cash bill still counts in full",
  );
  const plainBank = {
    ...splitBill,
    id: "SPL4",
    paidSplits: undefined,
    paid: 900,
    paymentMode: "bank",
    bankId: "B1",
    bankPaidAmount: 900,
  } as unknown as Invoice;
  assert(
    netFlow(cashFlows([plainBank], [], [], [], [])) === 0,
    "S3: and a plain bank bill still contributes nothing to cash",
  );
}

/* ═══ TEST S4: how a document says it was paid ══════════════════════════
   A bill printing "Cash" when half of it went to a bank is the original
   complaint restated. Asserted on the exact string, because the printed page
   contains the total and every other figure too — "does the page mention
   ₹1,000" cannot tell a payment label from an invoice line. */
{
  const named = (id: string) => (id === "B1" ? "HDFC Current" : undefined);

  const one = { paid: 1000, paymentMode: "cash" } as unknown as Invoice;
  assert(
    describePayment(one, named) === "Cash",
    `S4: a single-mode bill says just the mode — "${describePayment(one, named)}"`,
  );

  const bank = {
    paid: 1000,
    paymentMode: "bank",
    bankId: "B1",
    bankPaidAmount: 1000,
  } as unknown as Invoice;
  assert(
    describePayment(bank, named) === "HDFC Current",
    `S4: and a bank one names the ACCOUNT rather than the word Bank — "${describePayment(bank, named)}"`,
  );
  assert(
    describePayment(bank) === "Bank",
    "S4: falling back to the mode when no name is available",
  );

  const split = {
    paid: 1000,
    paymentMode: "cash",
    paidSplits: [
      { mode: "cash", amount: 400 },
      { mode: "bank", amount: 600, bankId: "B1" },
    ],
  } as unknown as Invoice;
  assert(
    describePayment(split, named) === "Cash ₹400.00 + HDFC Current ₹600.00",
    `S4: a split says both parts and how much each was — "${describePayment(split, named)}"`,
  );

  assert(
    describePayment({ paid: 0, paymentMode: "credit" } as unknown as Invoice, named) === "Credit",
    "S4: a credit bill still reads as credit",
  );
  /* A new bill starts on Cash so that tabbing lands there, which means an
     unpaid bill can have the Cash pill lit. It is not a cash sale, and saying
     "Cash" on the customer's copy of a bill nobody paid is a small lie that
     becomes an argument later. */
  assert(
    describePayment({ paid: 0, paymentMode: "cash" } as unknown as Invoice, named) === "Unpaid",
    `S4: a bill with the Cash pill lit and nothing received reads as Unpaid — "${describePayment({ paid: 0, paymentMode: "cash" } as unknown as Invoice, named)}"`,
  );
  assert(
    describePayment({ paid: 0, paymentMode: "bank", bankId: "B1" } as unknown as Invoice, named) ===
      "Unpaid",
    "S4: and so does an unpaid one pointed at an account",
  );
}

/* ═══ TEST S5: a split reaches the account's own passbook ═══════════════
   Found by sweeping the rest of the app rather than by a failing test, and
   the worst of the lot. Step 5 moved the account's stored balance for a
   split receipt; the passbook still filtered on the document's bankId, which
   a split does not have. So the balance moved and the passbook did not show
   why — and bankRepair RE-DERIVES balances from exactly these entries, so the
   next repair would have "corrected" the balance back down and taken the
   money with it. */
{
  const bank = { id: "B1", name: "HDFC", openingBalance: 0 } as unknown as BankAccount;
  const splitReceipt = {
    id: "PS1",
    date: "2026-06-01",
    partyId: "P1",
    partyName: "A Customer",
    type: "in",
    amount: 1000,
    mode: "cash",
    splits: [
      { mode: "cash", amount: 400 },
      { mode: "bank", amount: 600, bankId: "B1" },
    ],
  } as unknown as Payment;
  const splitExpense = {
    id: "ES1",
    date: "2026-06-02",
    category: "Rent",
    amount: 500,
    paymentMode: "cash",
    splits: [
      { mode: "cash", amount: 200 },
      { mode: "bank", amount: 300, bankId: "B1" },
    ],
  } as unknown as Expense;

  const led = buildBankLedger(bank, {
    sales: [],
    purchases: [],
    payments: [splitReceipt],
    bankTxns: [],
    expenses: [splitExpense],
  });
  assert(
    led.rows.some((r) => r.credit === 600),
    `S5: a part-bank receipt shows in the passbook — ${JSON.stringify(led.rows.map((r) => [r.type, r.debit, r.credit]))}`,
  );
  assert(
    led.rows.some((r) => r.debit === 300),
    "S5: and so does a part-bank expense",
  );
  assert(
    r2(led.fullBalance) === 300,
    `S5: leaving the balance the passbook itself explains — 600 in, 300 out — ${led.fullBalance}`,
  );
  /* The property that makes the repair safe: what the passbook says and what
     the account holds must be the same number, or a repair "fixes" one of
     them into being wrong. */
  const cashSideOnly = cashPart(splitReceipt) - cashPart(splitExpense);
  assert(
    r2(cashSideOnly) === 200,
    `S5: and the cash halves stay in the drawer, not on the account — ${cashSideOnly}`,
  );
}

/* ═══ TEST S6: a split changes no NUMBER a party is shown ═══════════════
   Asked directly what "the party ledger is unaffected by design" means, and
   it deserves an assertion rather than a reading of the code — that same
   reasoning is what missed the passbook.

   The claim: a split decides which of the SHOP's accounts holds the money.
   It never changes what the party owes. So the same bill, settled the same
   total, must produce identical figures whether it was taken one way or two.
   If this ever fails, the split work is wrong.

   This compared whole rows byte-for-byte until the shop asked to be told
   which account each payment landed in — "which bank, cash, which — nothing
   mentioned anywhere". Rows now carry `settledBy` for exactly that, and it
   differs between a one-way and a split bill BECAUSE that is the difference
   being reported. So the comparison drops that one display-only field and
   keeps every figure, which is what the invariant was always about: the
   party's money, not the shop's filing. */
{
  const party = { id: "PX", openingBalance: 0 };
  const bill = (id: string, paidSplits?: unknown) =>
    ({
      id,
      number: "INV-" + id,
      date: "2026-06-01",
      partyId: "PX",
      partyName: "Someone",
      lineItems: [],
      total: 1000,
      paid: 1000,
      paymentMode: "cash",
      createdAt: "2026-06-01T09:00:00Z",
      ...(paidSplits ? { paidSplits } : {}),
    }) as unknown as Invoice;

  const oneWay = buildPartyStatement(party, {
    sales: [bill("A")],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  const twoWays = buildPartyStatement(party, {
    sales: [
      bill("A", [
        { mode: "cash", amount: 400 },
        { mode: "bank", amount: 600, bankId: "B1" },
      ]),
    ],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });

  assert(
    oneWay.fullBalance === twoWays.fullBalance,
    `S6: splitting a bill does not move the party's balance — ${oneWay.fullBalance} vs ${twoWays.fullBalance}`,
  );
  /** Everything except how the shop filed it. */
  const figuresOf = (rows: typeof oneWay.rows) =>
    JSON.stringify(rows.map(({ settledBy: _ignored, ...rest }) => rest));
  assert(
    figuresOf(oneWay.rows) === figuresOf(twoWays.rows),
    "S6: nor any figure on their statement — a split is about the shop's accounts, not the party",
  );
  /* And the new field is genuinely display-only: it is the ONLY difference
     between the two statements. Asserted so that a future change which
     smuggles a calculation into it fails here rather than quietly. */
  assert(
    JSON.stringify(oneWay.rows) !== JSON.stringify(twoWays.rows),
    "S6: while the split IS reported — the shop can see which account took it",
  );
  assert(
    twoWays.fullBalance === 0,
    `S6: and a bill paid in full leaves them owing nothing, however it was paid — ${twoWays.fullBalance}`,
  );
}

/* ═══ TEST S7: re-saving a split must not re-attribute the money ════════
   The bug this guards, found by asking whether the feature was really
   finished rather than by any test failing: the payment and expense dialogs
   never loaded an existing record's rows, so reopening a split showed it as
   single-mode. Saving then reversed the rows off their accounts and put the
   whole amount under one mode. The money did not vanish, which is worse —
   it moved somewhere nobody asked it to.

   Asserted on the property that makes a re-save safe: reversing what a
   document attributed and re-applying it must leave every account where it
   started. If the rows are lost in between, this stops being true. */
{
  const rows = [
    { mode: "cash", amount: 400 },
    { mode: "bank", amount: 600, bankId: "B1" },
  ] as PaymentSplit[];
  const saved = { amount: 1000, mode: "cash", splits: rows } as unknown as Payment;

  // What the dialog reloads, and what it would save back unchanged.
  const reloaded = saved.splits?.length ? saved.splits : null;
  assert(!!reloaded, "S7: reopening a split receipt finds its rows to show");

  const resaved = {
    amount: 1000,
    mode: reloaded ? largestSplitMode(reloaded) : "cash",
    splits: reloaded ?? undefined,
  } as unknown as Payment;

  const before = bankParts(saved);
  const after = bankParts(resaved);
  assert(
    (after.get("B1") ?? 0) === (before.get("B1") ?? 0),
    `S7: re-saving it untouched leaves the account exactly where it was — ${before.get("B1")} then ${after.get("B1")}`,
  );
  assert(
    cashPart(resaved) === cashPart(saved),
    "S7: and the drawer too, instead of swallowing the bank half",
  );

  /* The failure it replaces, stated so the assertion above cannot be read as
     trivia: a dialog that dropped the rows would re-save this as one mode. */
  const dropped = { amount: 1000, mode: "cash", splits: undefined } as unknown as Payment;
  assert(
    cashPart(dropped) === 1000 && (bankParts(dropped).get("B1") ?? 0) === 0,
    "S7: losing the rows would put the whole receipt in cash and empty the account",
  );
}

/* ═══════ TEST W: the WhatsApp link, said in a way a shop can act on ═══════
   The bridge reports three states and a shop needs six. Everything below is
   about the three it cannot report — and the two boundaries that decide
   whether the shop is told "wait" or "go and scan", which are the entire
   value of the feature and are trivially inverted. */
{
  const T0 = Date.parse("2026-09-09T10:00:00Z");
  const fresh = { everConnected: false };
  const used = { everConnected: true, lastConnectedAt: "2026-09-07T10:00:00Z" };

  /* ── Connected outranks everything, including a stale unsettled clock ── */
  assert(
    deriveLinkState({ status: "connected" }, { everConnected: true, unsettledSince: 0 }, T0) ===
      "connected",
    "W1: a live socket reads connected even if the fault clock was left running",
  );
  assert(linkSeverity("connected") === "ok", "W1: and it is the only green state");
  assert(
    linkSeverity("dropped") === "bad" &&
      linkSeverity("never_linked") === "bad" &&
      linkSeverity("unreachable") === "bad" &&
      linkSeverity("scan_needed") === "bad",
    "W1: every state that cannot send a bill shows red",
  );
  assert(
    linkSeverity("starting") === "busy",
    "W1: except a normal start, which must not train the shop to ignore red",
  );

  /* ── The grace period, at both sides of the line ────────────────────── */
  const waitingFor = (ms: number, h: { everConnected: boolean }) =>
    deriveLinkState({ status: "waiting" }, { ...h, unsettledSince: T0 - ms }, T0);

  assert(
    waitingFor(LINK_GRACE_MS - 1000, used) === "starting",
    "W2: one second inside the grace period is still just starting up",
  );
  assert(
    waitingFor(LINK_GRACE_MS + 1000, used) === "dropped",
    "W2: one second past it is a fault the shop is told about",
  );
  assert(
    deriveLinkState({ status: "waiting" }, { everConnected: true }, T0) === "starting",
    "W2: a first reading with no fault clock yet is treated as a start, not a fault",
  );

  /* ── The same wire response, opposite messages ──────────────────────── */
  assert(
    waitingFor(LINK_GRACE_MS + 1000, fresh) === "never_linked",
    "W3: identical bytes mean 'not set up' for a shop that never linked",
  );
  assert(
    waitingFor(LINK_GRACE_MS + 1000, used) === "dropped",
    "W3: and 'it broke' for one that had it working",
  );
  assert(
    linkHeadline("scan_needed", fresh) !== linkHeadline("scan_needed", used),
    "W3: a first link and a relink are not described with the same sentence",
  );

  /* ── A QR is an action, so it outranks the wait ─────────────────────── */
  assert(
    deriveLinkState({ status: "qr" }, { ...used, unsettledSince: T0 - 1000 }, T0) === "scan_needed",
    "W4: a QR one second old is offered immediately, not hidden behind the grace period",
  );

  /* ── An unreachable service is a different fault from a dead socket ─── */
  assert(
    deriveLinkState({ status: null }, { ...used, unsettledSince: T0 - 1000 }, T0) === "starting",
    "W5: one missed poll during a cold start does not go red",
  );
  assert(
    deriveLinkState({ status: null }, { ...used, unsettledSince: T0 - 60_000 }, T0) ===
      "unreachable",
    "W5: a service that keeps not answering is named as the service, not as WhatsApp",
  );
  assert(
    linkHeadline("unreachable", used) !== linkHeadline("dropped", used),
    "W5: because the two need different people to fix them",
  );

  /* ── Staff are never handed work only an owner can do ───────────────── */
  for (const st of ["scan_needed", "dropped", "never_linked", "unreachable"] as const) {
    assert(
      !/scan/i.test(linkAdvice(st, used, false)),
      "W6: staff are never told to scan a QR they will never be shown — " + st,
    );
    assert(
      needsScan(st) === (st !== "unreachable"),
      "W6: only a link fault is fixed by scanning; an unreachable service is not — " + st,
    );
  }
  assert(
    /owner/i.test(linkAdvice("dropped", used, false)),
    "W6: they are told who can fix it instead",
  );
  assert(
    /Linked Devices/i.test(linkAdvice("scan_needed", used, true)),
    "W6: while the owner gets the actual steps on the phone",
  );
  assert(
    !needsScan("connected") && !needsScan("starting"),
    "W6: and nothing is asked of anyone while it is working",
  );

  /* ── "since Tuesday" — the phrase that says how many bills went unsent ─ */
  const H = 3_600_000;
  assert(sinceLabel(undefined, T0) === undefined, "W7: a shop that never linked has no since");
  assert(
    sinceLabel(new Date(T0 - 30 * 60_000).toISOString(), T0) === "Last connected 30 minutes ago",
    "W7: minutes while it is still this shift",
  );
  assert(
    sinceLabel(new Date(T0 - 5 * H).toISOString(), T0) === "Last connected 5 hours ago",
    "W7: hours after that",
  );
  assert(
    sinceLabel(new Date(T0 - 50 * H).toISOString(), T0) === "Last connected 2 days ago",
    "W7: and days once it has been broken overnight",
  );
  assert(
    sinceLabel(new Date(T0 - 40 * 24 * H).toISOString(), T0) ===
      "Last connected more than a week ago",
    "W7: past a week it stops implying a precision this record does not have",
  );
  assert(
    sinceLabel(new Date(T0 + H).toISOString(), T0) === undefined,
    "W7: a clock skewed into the future says nothing rather than something absurd",
  );
}

/* ═══════ TEST W8: the QR must never reach a staff browser ═══════
   Read from the source rather than exercised, because the thing being
   protected is an absence — a field that must not be in a response — and the
   way it comes back is a refactor that "simplifies" the explicit field list
   into a spread. A test that renders a screen would not notice. */
{
  const src = readFileSync(process.cwd() + "/src/lib/whatsappAdmin.ts", "utf8");

  const staffAt = src.indexOf("export const getWhatsAppLinkStateServerFn");
  assert(
    staffAt !== -1,
    "W8: the staff-facing reader exists (renamed? this check just went blind)",
  );

  // To the end of that declaration, not to the end of the file.
  const after = src.slice(staffAt);
  const end = after.indexOf("\n  });");
  assert(end !== -1, "W8: its handler body could be delimited");
  const body = after.slice(0, end);

  assert(body.includes("requireActiveUser"), "W8: anyone who may send a bill may read the status");
  assert(
    !body.includes("requireOwner"),
    "W8: but it is not quietly narrowed back to owners, which would break the header for staff",
  );
  assert(
    !/\bqr\s*:/.test(body),
    "W8: and it never returns the QR itself — that code IS a login to the shop's WhatsApp",
  );
  assert(
    !/\.\.\.\s*\w+/.test(body),
    "W8: fields are listed one by one, so a new secret on the service stays behind by default",
  );

  const ownerAt = src.indexOf("export const getWhatsAppStatusServerFn");
  assert(ownerAt !== -1, "W8: the owner's reader is still there");
  const ownerBody = src.slice(ownerAt, ownerAt + src.slice(ownerAt).indexOf("\n  });"));
  assert(
    ownerBody.includes("requireOwner"),
    "W8: and it is the one that stayed owner-only, since it is the one carrying the QR",
  );
}

/* ═══════ TEST X: the outbox, and what it refuses to do on its own ═══════
   A queue that retries everything is not resilience — it is a machine for
   sending a customer two copies of the same invoice, and for keeping a bill
   that can never send in a red badge until the shop stops reading badges.
   Both refusals are asserted here. */
{
  const T0 = Date.parse("2026-09-09T10:00:00Z");
  const row = (over: Partial<OutboxItem> = {}): OutboxItem => ({
    id: "q1",
    label: "INV-0012",
    phone: "9876543210",
    message: "hi",
    fileName: "INV-0012.pdf",
    html: "<html></html>",
    landscape: false,
    queuedAt: new Date(T0 - 3_600_000).toISOString(),
    attempts: 0,
    auto: true,
    ...over,
  });

  /* ── Nothing that will fail forever goes in the queue ────────────────── */
  for (const m of [
    "This party has no phone number saved — add one to send via WhatsApp.",
    "Not signed in",
    "WhatsApp service isn't configured yet — set WHATSAPP_SERVICE_URL and ...",
    "Only the business owner can do this.",
    "Your account isn't active — ask the business owner to check your access.",
  ]) {
    assert(
      classifySendFailure(m, false) === "permanent",
      "X1: a fault in the request is never queued to retry forever — " + m.slice(0, 34),
    );
    assert(
      classifySendFailure(m, true) === "permanent",
      "X1: and the link's state does not change that — " + m.slice(0, 34),
    );
  }

  /* ── Only a failure we can prove is retried by itself ────────────────── */
  assert(
    classifySendFailure("Could not send WhatsApp message", false) === "offline",
    "X2: with the link already down, the message certainly did not go",
  );
  assert(
    classifySendFailure("Session not connected", true) === "offline",
    "X2: and the service saying so is just as good a proof",
  );
  assert(
    classifySendFailure("socket hang up", true) === "uncertain",
    "X3: but an unexplained failure on a live link might have sent — it is NOT offline",
  );
  assert(
    !isDue(row({ auto: false }), T0 + 86_400_000),
    "X3: and an uncertain one is never sent again by a timer, however long it waits",
  );
  assert(needsAttention(row({ auto: false })), "X3: it waits for a person instead, and says so");

  /* ── Backoff counts from the last attempt, not from queueing ─────────── */
  assert(
    retryDelayMs(0) < retryDelayMs(3) && retryDelayMs(3) < retryDelayMs(6),
    "X4: waits grow with each failure",
  );
  assert(retryDelayMs(99) === 1_800_000, "X4: and stop growing at half an hour");
  {
    const tried = row({ attempts: 3, lastAttemptAt: new Date(T0 - 1000).toISOString() });
    assert(
      !isDue(tried, T0),
      "X4: a row tried a second ago is not due again, however old the queue entry is",
    );
    assert(
      isDue({ ...tried, lastAttemptAt: new Date(T0 - retryDelayMs(3) - 1000).toISOString() }, T0),
      "X4: and is due once its own wait has passed",
    );
  }

  /* ── Two tills must not send the same bill twice ─────────────────────── */
  assert(
    !isDue(row({ sendingSince: T0 - 1000 }), T0),
    "X5: a row another tab is already sending is left alone",
  );
  assert(
    isDue(row({ sendingSince: T0 - CLAIM_STALE_MS - 1000 }), T0),
    "X5: unless that tab died holding it, or the row would be stuck forever",
  );

  /* ── Giving up hands over to a person; it never discards the bill ────── */
  assert(
    !isDue(row({ attempts: MAX_ATTEMPTS }), T0),
    "X6: after the last attempt the timer stops trying",
  );
  assert(
    needsAttention(row({ attempts: MAX_ATTEMPTS })),
    "X6: and the row is raised for a person rather than quietly dropped",
  );
  assert(
    !needsAttention(row({ attempts: MAX_ATTEMPTS - 1 })),
    "X6: while it still has attempts left, nobody is bothered",
  );

  /* ── The counter is told which of the two situations it is ───────────── */
  assert(
    queuedMessage("offline", "this invoice") !== queuedMessage("uncertain", "this invoice"),
    "X7: 'it will send itself' and 'check whether it sent' are not the same sentence",
  );
  assert(
    /queued|will send/i.test(queuedMessage("offline", "this invoice")),
    "X7: the offline one promises it will go",
  );
  assert(
    !/will send on its own/i.test(queuedMessage("uncertain", "this invoice")),
    "X7: the uncertain one promises nothing of the sort",
  );
}

/* ═══════ TEST Y: the two rules at the send seam ═══════
   Read from the source, because both are about ORDER and about an exception
   NOT being swallowed — neither shows up in the value a function returns, and
   both are exactly the kind of thing a later tidy-up inverts while every
   other test stays green. */
{
  const src = readFileSync(process.cwd() + "/src/lib/whatsappSend.ts", "utf8");

  /* ── The link is read BEFORE the attempt ───────────────────────────────
     A failed send drives the indicator red. Read it afterwards and the
     answer is always "it was down", so every unexplained failure would be
     filed as safe-to-retry — which is the machine for sending a customer a
     second copy of their invoice. */
  const readAt = src.indexOf('useWhatsAppLinkStore.getState().state === "connected"');
  const transmitAt = src.indexOf("await transmit(");
  assert(readAt !== -1, "Y1: the send path still reads the link state at all");
  assert(transmitAt !== -1, "Y1: and still transmits (renamed? this check just went blind)");
  assert(
    readAt < transmitAt,
    "Y1: it is read BEFORE the attempt, or every uncertain failure is misfiled as offline",
  );

  /* ── A fault in the request is never queued ──────────────────────────── */
  assert(
    /phase === "prepare"\)\s*throw/.test(src),
    "Y2: a prepare-phase failure is rethrown, not put in a queue that can only fail",
  );
  assert(/kind === "permanent"\)\s*throw/.test(src), "Y2: and so is anything classified permanent");

  /* ── Only a provable failure retries itself ──────────────────────────── */
  assert(
    /auto:\s*kind === "offline"/.test(src),
    "Y3: the queue only re-sends on its own what it can prove never went",
  );

  /* ── One bill, one id, across every attempt ───────────────────────────
     The service refuses a second send of an id it has already sent. That
     only protects anybody if a retry arrives under the SAME id — a fresh id
     per attempt is, from the service's side, simply a different bill, and
     the duplicate it exists to stop goes out anyway. Two halves, both
     needed, and both silently satisfiable-looking on their own. */
  const mintAt = src.indexOf("const clientMessageId =");
  assert(mintAt !== -1, "Y4: the send path mints an id for the bill");
  assert(
    mintAt < transmitAt,
    "Y4: before the first attempt, so the first send and its retries share it",
  );
  assert(
    /id:\s*clientMessageId,/.test(src),
    "Y4: and the queued row is stored under that very id, not a new one",
  );

  const queue = readFileSync(process.cwd() + "/src/store/whatsappOutbox.ts", "utf8");
  assert(
    /clientMessageId:\s*item\.id,/.test(queue),
    "Y4: which the queue then sends back as the id, closing the loop",
  );
}

/* ═══════ TEST Z: a service that answered is never called unreachable ═══════
   The bug this replaces was live for one deploy. A bridge responding in
   under half a second was shown to the shop as "Can't reach the WhatsApp
   service", because every failure — a rejected token, our own server
   erroring, the bridge genuinely being down — arrived as one exception and
   was rendered as the last of those. The fix is that the reader REPORTS an
   unreachable bridge rather than throwing, so a throw can only mean the call
   itself never got off the ground. Asserted from the source, because what
   matters is the shape of the contract rather than any one value. */
{
  const admin = readFileSync(process.cwd() + "/src/lib/whatsappAdmin.ts", "utf8");
  const at = admin.indexOf("export const getWhatsAppLinkStateServerFn");
  assert(at !== -1, "Z1: the staff-facing reader exists (renamed? this check just went blind)");
  const body = admin.slice(at, at + admin.slice(at).indexOf("\n  });"));

  assert(
    /reachable:\s*true/.test(body) && /reachable:\s*false/.test(body),
    "Z1: it answers whether the bridge replied, rather than leaving it to an exception",
  );
  assert(
    /catch\s*\(/.test(body),
    "Z1: a bridge that fails to answer is caught here, not thrown at the browser",
  );
  assert(
    /error:/.test(body),
    "Z1: and its actual words are handed back, so the screen can say what went wrong",
  );

  const store = readFileSync(process.cwd() + "/src/store/whatsappLink.ts", "utf8");
  assert(
    /lean\.reachable\s*\?/.test(store),
    "Z2: the store trusts that answer instead of inferring reachability from a throw",
  );
  assert(
    /askFailed\s*=\s*true/.test(store),
    "Z2: and a call that never got off the ground is recorded as OUR fault, separately",
  );
  assert(
    !/}\s*catch\s*{\s*reading\s*=\s*{\s*status:\s*null\s*};?\s*}/.test(store),
    "Z2: no bare catch quietly turning every fault into 'the service is down' again",
  );

  /* ── The Settings card must still be able to show a QR ────────────────
     Gating the code on being inside the header dialog meant an owner on the
     Settings page — where this shop has always scanned from — waited forever
     for a QR that was sitting on the service the whole time. */
  const ui = readFileSync(process.cwd() + "/src/components/WhatsAppLink.tsx", "utf8");
  assert(
    /useWatchWhileMounted\(isOwner\)/.test(ui),
    "Z3: any panel an owner is looking at asks for the QR, not only the dialog",
  );
  assert(
    /lastError/.test(ui),
    "Z3: and whatever went wrong is put on the screen rather than kept in a variable",
  );
}

/* ═══════ TEST M: a ledger says WHERE the money went, not only how much ═══
   The shop's report: "payment gone and received — which bank, cash, which —
   nothing mentioned anywhere". The statement held the answer the whole time
   and simply never carried it out of the builder. Asserted on values rather
   than on the rendering, because the rendering is the easy half. */
{
  const party = { id: "MP", openingBalance: 0 };
  const mk = (over: Record<string, unknown>) =>
    ({
      id: "MPAY1",
      createdAt: "2026-09-01T10:00:00Z",
      date: "2026-09-01",
      partyId: "MP",
      partyName: "Mode Party",
      type: "in",
      amount: 1000,
      ...over,
    }) as unknown as Payment;

  const bankPay = mk({ mode: "bank", bankId: "HDFC" });
  const st = buildPartyStatement(party, {
    sales: [],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [bankPay],
  });
  const row = st.rows.find((r) => r.type === "Payment Received");
  assert(!!row, "M1: the receipt has a row at all");
  assert(!!row?.settledBy, "M1: and that row carries the record the money moved through");
  assert(
    describePayment(row!.settledBy!, (id) => (id === "HDFC" ? "HDFC Current" : undefined)) ===
      "HDFC Current",
    "M1: which names the actual account, not the word 'Bank'",
  );

  /* A write-off moved no money. Labelling it with a mode would invent a
     payment that never happened — the one way this feature could lie. */
  const withDiscount = mk({
    id: "MPAY2",
    mode: "cash",
    amount: 0,
    allocations: [{ id: "X", number: "INV-1", amount: 0, discount: 250 }],
  });
  const st2 = buildPartyStatement(party, {
    sales: [],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [withDiscount],
  });
  const off = st2.rows.find((r) => r.type === "Discount Given");
  assert(!!off, "M2: the write-off has its own row");
  assert(!off?.settledBy, "M2: and carries no payment mode, because no money moved");

  /* An unpaid bill likewise: the pill highlighted on the form is not a
     payment, and printing it would be a small lie that becomes an argument. */
  const unpaid = {
    id: "MB1",
    createdAt: "2026-09-02T10:00:00Z",
    number: "INV-M1",
    date: "2026-09-02",
    partyId: "MP",
    partyName: "Mode Party",
    lineItems: [],
    total: 500,
    paid: 0,
    paymentMode: "cash",
  } as unknown as Invoice;
  const paidAtCounter = { ...unpaid, id: "MB2", number: "INV-M2", paid: 500 } as Invoice;
  const st3 = buildPartyStatement(party, {
    sales: [unpaid, paidAtCounter],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  assert(
    !st3.rows.find((r) => r.ref === "INV-M1")?.settledBy,
    "M3: an unpaid bill reports no mode, whatever pill was lit when it was written",
  );
  assert(
    !!st3.rows.find((r) => r.ref === "INV-M2")?.settledBy,
    "M3: while one settled at the counter does",
  );
}

/* ═══════ TEST P: a ledger PDF cannot be saved under the wrong name ═══════
   The bulk export walked TWO arrays with one index — the documents it had
   managed to render, and the parties it meant to name them after. Any party
   whose markup failed to mount was dropped from the first list only, and
   from there every remaining PDF was written under the previous party's
   name. The shop read that as "some came out full and some simple". What it
   actually was is one customer's account in a file named after another,
   which is the kind of thing that gets emailed onward.

   Read from the source because the failure is structural — two lists that
   must not be indexed independently — and a test that rendered one party
   would never see it. */
{
  const dlg = readFileSync(process.cwd() + "/src/components/PartyLedgerExportDialog.tsx", "utf8");

  assert(
    /docs\[i\]\.party\.name/.test(dlg),
    "P1: each PDF is named from the party carried WITH it",
  );
  assert(
    !/parties\[i\]\.name/.test(dlg),
    "P1: never from a second list walked with the same index",
  );
  assert(/party:\s*p,/.test(dlg), "P1: which means the party is pushed alongside its document");
  assert(
    /missed/.test(dlg),
    "P1: and a party whose document failed is reported, not silently dropped",
  );

  /* The bulk INVOICE export is the same shape and inherits the same trap,
     so it is held to the same rule. Checked here rather than on screen
     because the screen suite never downloads anything — a mutation that
     renamed the files from a second list survived every one of its
     assertions, which is exactly how the party version shipped broken. */
  const bulk = readFileSync(process.cwd() + "/src/components/InvoiceBulkExportDialog.tsx", "utf8");
  assert(
    /docs\[i\]\.inv\.number/.test(bulk),
    "P1: each bill's PDF is named from the bill carried WITH it",
  );
  assert(!/invoices\[i\]/.test(bulk), "P1: never from the selection list walked by the same index");
  assert(
    /inv,\s*el/.test(bulk) || /\{\s*inv,\s*el\s*\}/.test(bulk),
    "P1: which means the bill is pushed alongside its document",
  );

  /* The same trap one level down: the renderer hands back a plain array that
     callers pair positionally, so a short batch must fail rather than shift
     every later document onto the wrong name. */
  const pdf = readFileSync(process.cwd() + "/src/lib/pdf.ts", "utf8");
  assert(
    /pdfsBase64\.length !== slice\.length/.test(pdf),
    "P2: a batch that renders fewer PDFs than asked for throws instead of misaligning",
  );
}

/* ═══════ TEST K: the keyboard keeps its own cursor on screen ═══════
   The shop runs this from a MacBook with no mouse. On a 13" screen, tabbing
   into a field below the fold left the cursor somewhere invisible and the
   next thing typed went into a box nobody could see.

   Read from the source, and that is worth explaining rather than excusing.
   The behaviour lives in AppShell, and the screen suite — which renders real
   pages in a real browser — does NOT mount AppShell: a probe asserting
   document.querySelector("header") fails there. So nothing in the shell is
   covered by those 592 assertions, which is a gap worth knowing about well
   beyond this hook. Until that changes, the rules are pinned here, where
   they can at least not be deleted silently. */
{
  const hook = readFileSync(process.cwd() + "/src/hooks/useKeyboardFocusScroll.ts", "utf8");

  assert(/addEventListener\("focusin"/.test(hook), "K1: something watches where the focus lands");
  assert(
    /scrollIntoView\(\{\s*block:\s*"nearest"/.test(hook),
    "K1: and moves the least it can — anything stronger re-centres the page on every Tab",
  );

  /* The half that is easy to forget: a pointer must NOT scroll. A page that
     jumps under the hand that just clicked it is worse than one that never
     scrolls at all. */
  /* The SUBSCRIPTION, not the word. Matching "mousedown" anywhere passed
     happily when the listener was deleted and only its removeEventListener
     cleanup was left behind — found by mutation, which is the entire point
     of running one. */
  assert(
    /addEventListener\("mousedown", onPointer/.test(hook) &&
      /addEventListener\("touchstart", onPointer/.test(hook),
    "K2: a pointer cancels it, so clicking never yanks the page",
  );
  assert(
    /if \(!byKeyboard\) return;/.test(hook),
    "K2: enforced by a guard, not by hoping the events arrive in a helpful order",
  );

  /* Only keys that MOVE focus. Scrolling on a plain letter would fire in the
     middle of typing a party's name. */
  assert(
    /"Tab"/.test(hook) && /startsWith\("Arrow"\)/.test(hook),
    "K3: Tab and the arrows count as a focus move",
  );
  assert(!/e\.key\.length === 1/.test(hook), "K3: and a plain character is not treated as one");

  const shell = readFileSync(process.cwd() + "/src/components/layout/AppShell.tsx", "utf8");
  /* Commenting the call out left the name in the file, and a plain substring
     match called that mounted. It has to be a live statement. */
  assert(
    /^\s*useKeyboardFocusScroll\(\);\s*$/m.test(shell),
    "K4: the hook is actually mounted — app-wide, since every list page scrolls",
  );
}

/* ═══════ TEST D: an arrowed-to option is an option you can see ═══════
   Reported for "all dropdown selection": arrowing down walked the highlight
   straight past the bottom edge and kept going, invisibly. The shop arrows,
   sees nothing move, and presses Enter on something it cannot see — on a
   counter worked entirely by keyboard that is a wrong item on a bill, not a
   rough edge.

   Only the invoice form did this, with its own hand-rolled copy. It is one
   shared hook now, and every picker is held to using it. Listed by name on
   purpose: a new dropdown added later without it is the exact regression
   this is here to catch, and a count would quietly pass as they came and
   went. */
{
  const hook = readFileSync(process.cwd() + "/src/hooks/useHighlightScroll.ts", "utf8");
  assert(
    /scrollIntoView\(\{ block: "nearest" \}\)/.test(hook),
    "D1: the highlight is brought just into view, not re-centred on every keypress",
  );
  /* Without this it runs on every render and snaps a hand-scrolled list back
     to the highlight — which feels exactly like a list that cannot be
     scrolled, i.e. the complaint being fixed. */
  assert(
    /if \(prev\.current === index\) return;/.test(hook),
    "D1: and only when the highlight actually moved",
  );

  const wired = [
    "/src/components/SelectMenu.tsx",
    "/src/components/ComboInput.tsx",
    "/src/routes/payments.tsx",
    "/src/routes/expenses.tsx",
    "/src/components/ReturnForm.tsx",
    "/src/components/CashBankTransferDialog.tsx",
  ];

  /* The bill form is checked separately: its two item pickers carry their own
     older copies of this behaviour, so counting hooks against marked lists
     would not balance. What matters is the one that was missing — the
     customer picker, the single most-used dropdown in the app, which had no
     scroll handling of any kind while the bank and item pickers beside it
     did. That is how a shared hook gets written and a caller still gets
     forgotten. */
  /* The two money columns were asserted to be mutually exclusive, and that
     rule was WRONG — the shop found it. A bill settled at the counter moves
     the balance by nothing, so a 7,500 sale with 7,500 handed over rendered
     a completely blank row. Both movements belong on a bill's line.

     What replaces it is the property that actually has to hold, tested on
     values in TEST LC above: gave − got equals the net movement. All that is
     checked here is that both documents get their columns from the one place
     that enforces it, rather than each working it out again. */
  const stmt = readFileSync(process.cwd() + "/src/routes/parties_." + "$id.tsx", "utf8");
  const printable = readFileSync(
    process.cwd() + "/src/components/PrintablePartyStatement.tsx",
    "utf8",
  );
  for (const [name, src] of [
    ["the statement page", stmt],
    ["the printed statement", printable],
  ] as const) {
    assert(
      src.includes("ledgerColumns("),
      "D4: " + name + " takes its two columns from the shared rule",
    );
    assert(
      !src.includes("delta > 0 &&") && !src.includes("delta > 0.01 ?"),
      "D4: " + name + " no longer works the columns out from the net movement itself",
    );
  }

  const bill = readFileSync(process.cwd() + "/src/components/InvoiceForm.tsx", "utf8");
  assert(
    bill.includes("useHighlightScroll(partyListRef, partyIdx, partyOpen)"),
    "D3: the bill customer picker scrolls its highlight",
  );
  /* Counted, not merely present.

     A first version asked only whether each file mentioned the hook at all,
     and a file with TWO dropdowns passed happily after one of them lost its
     call — the other still matched. Found by mutation. Every marked list
     must have a hook call of its own, so the two counts have to agree. */
  for (const rel of wired) {
    const src = readFileSync(process.cwd() + rel, "utf8");
    const hooks = (src.match(/useHighlightScroll\([a-zA-Z]/g) ?? []).length;
    const lists = (src.match(/data-opt=\{/g) ?? []).length;
    assert(hooks > 0, "D2: this picker scrolls its highlight — " + rel);
    /* The hook finds the option by this attribute; without it the lookup
       silently returns nothing and the hook is decoration. */
    assert(lists > 0, "D2: and marks its options so the hook can find them — " + rel);
    assert(
      hooks === lists,
      `D2: every list in this file has a hook call of its own — ${rel}: ${hooks} hooks, ${lists} lists`,
    );
  }
}

/* ═══════ TEST B: a reopened bill form starts at the top ═══════
   Reported twice: open a new bill, scroll down, close it, open another, and
   it came back part-way down — customer card off the top, party field out of
   reach.

   Source-level, and for a reason worth writing down rather than hiding. The
   screen harness renders an 800x600 window, where an empty bill is not tall
   enough to scroll at all, so any assertion about its scroll position passes
   without testing anything — which is exactly what happened when I tried,
   and the check said so instead of going green. It also builds a fresh
   router per render, so it cannot reproduce the case that actually broke: a
   workspace tab whose component stays mounted while you work elsewhere.

   A test that cannot fail is worse than no test. What CAN be pinned is that
   the reset exists, happens more than once, and is keyed on more than first
   mount. Plain string checks rather than regexes, because the thing being
   matched is full of brackets and an escaping slip here fails silently. */
{
  const form = readFileSync(process.cwd() + "/src/components/InvoiceForm.tsx", "utf8");

  assert(form.includes("data-bill-scroll"), "B1: the form has a scrolling region of its own");
  assert(form.includes("el.scrollTop = 0;"), "B1: which is put back to the top");

  /* Once was not enough: the things that move a fresh form — data landing, a
     picker restoring, the router's own scroll handling — all happen after
     mount. */
  assert(
    form.includes("requestAnimationFrame(") && form.includes("}, 80);"),
    "B2: on the next frame and the next tick too, not only once on mount",
  );

  /* Keyed on the route, because reopening a bill in a workspace that keeps
     tabs alive is not a new mount. */
  assert(
    form.includes("[existing?.id, formPathname]"),
    "B3: and re-runs when the form is opened again, not only when it is built",
  );
}

/* ═══════ TEST PR: the printed statement behaves like paper ═══════
   The PDF is the very table that is on screen, so anything needing a mouse
   printed as nonsense. Three faults in one download:

     A folded breakdown printed the words "View details" and nothing else —
     an instruction the reader cannot carry out. The detail is always
     rendered now and merely hidden on screen while it is folded.

     The closing balance appeared on every page, because a browser repeats
     <tfoot> on each printed page of a table that breaks across pages.
     Repeating the column headers is exactly what you want; repeating the
     bottom line mid-statement is a second, contradictory total.

     And the rupee sign came out blank — the headless browser that draws
     these PDFs carries no font with it — so a column headed "You Gave (₹)"
     printed as "You Gave ( )". */
{
  const page = readFileSync(process.cwd() + "/src/routes/parties_." + "$id.tsx", "utf8");

  assert(
    page.includes("hidden print:table-row"),
    "PR1: a folded breakdown is hidden on screen but printed in full",
  );
  /* Matched on the control, not on its styling: the first version pinned an
     exact hover colour and broke the moment the row was restyled, which
     tells you nothing about whether the button still prints. */
  const foldButton = page.slice(page.indexOf("setOpen((v) => !v)"));
  assert(
    foldButton.slice(0, 400).includes("print:hidden"),
    "PR1: and the control that folds it never prints",
  );

  /* The closing balance lives in the body, so it prints once, at the end. */
  assert(
    !page.includes("<tfoot>"),
    "PR2: nothing sits in a tfoot, which a browser repeats on every printed page",
  );

  /* And a bottom line is never left alone on a fresh page. Moving it out of
     the tfoot stopped it REPEATING; this stops it arriving by itself under a
     full set of reprinted column headings, which reads as a second, empty
     statement. Both closing rows — the statement and the simple ledger —
     refuse a page break before them. */
  assert(
    (page.match(/breakBefore: "avoid"/g) ?? []).length >= 2,
    "PR4: neither closing row can be orphaned onto a page of its own",
  );

  assert(
    !page.includes("You Gave (\u20B9)"),
    "PR3: no column header leans on a glyph the PDF renderer cannot draw",
  );
}

/* ═══════ TEST SD: one ledger document, however it is downloaded ═══════
   Downloading one party's ledger built its PDF from the live table on the
   page; selecting several parties and downloading built theirs from
   PrintablePartyStatement. Two components rendering the same rows, so the
   two documents drifted apart — and the shop got a visibly different file
   depending on which button it pressed. Rebuilding the screen and forgetting
   the printable is exactly how that gap opened in the first place.

   Both go through the printable now. Asserted structurally, because the
   guarantee worth having is "there is only one of them", not "these two
   happen to match today". */
{
  const page = readFileSync(process.cwd() + "/src/routes/parties_." + "$id.tsx", "utf8");

  assert(
    page.includes("<PrintablePartyStatement"),
    "SD1: the party page renders the same printable the bulk export uses",
  );
  /* And points its PDFs at it. Rendering one and then exporting the screen
     anyway is a failure that looks exactly like success. */
  assert(
    page.includes('ledgerFormat === "simple" ? simpleLedgerRef.current : pdfRef.current'),
    "SD1: and every PDF is built from that, not from the screen",
  );

  /* The summary has to add up, or it is decoration. Opening + gave − got =
     closing: a party whose whole balance was an opening figure previously
     showed 0, 0, 0 and a closing balance of 5,100. */
  const printable = readFileSync(
    process.cwd() + "/src/components/PrintablePartyStatement.tsx",
    "utf8",
  );
  assert(
    printable.includes("Opening Balance") &&
      printable.includes("You Gave") &&
      printable.includes("You Got") &&
      printable.includes("Closing Balance"),
    "SD2: the summary carries the four figures that reconcile",
  );
  assert(
    !printable.includes('label: "Total Billed"'),
    "SD2: and not a fifth that takes part in no equation",
  );
}

/* ═══════ TEST NU: the WhatsApp nudge stays out of the way ═══════
   It opened across the Sales list while the counter was working, and the
   shop asked for it off those pages by name. What it reports is nearly
   always a configuration fault nobody at a till can fix — a wrong service
   URL, an expired key — so the red dot in the header carries it, and the
   dialog opens on a click when somebody actually wants it.

   In the audit suite because the nudge lives in AppShell, which the screen
   harness does not mount at all. */
{
  const ui = readFileSync(process.cwd() + "/src/components/WhatsAppLink.tsx", "utf8");
  /* Pulled out by string rather than by regex: the pattern being looked for
     is itself full of brackets and pipes, and an escaping slip in the search
     fails silently — it finds nothing and the check quietly passes. */
  const marker = 'const BUSY_ROUTE = new RegExp("';
  const at = ui.indexOf(marker);
  assert(at !== -1, "NU1: the nudge still has a list of places it must not appear");
  if (at !== -1) {
    const rest = ui.slice(at + marker.length);
    const re = new RegExp(rest.slice(0, rest.indexOf('"')));
    for (const path of ["/sales", "/purchase", "/sales/new", "/purchase/edit/abc"]) {
      assert(re.test(path), "NU1: it stays off " + path);
    }
    /* And still appears where there is nothing to interrupt, or it has
       simply been switched off rather than aimed. */
    for (const path of ["/", "/parties", "/settings"]) {
      assert(!re.test(path), "NU2: but it can still be shown on " + path);
    }
  }
}

/* ═══════ TEST LC: the two money columns always add up to the balance ═══
   The shop opened a party whose bills were all paid at the counter and saw
   a statement of blank rows: a 7,500 sale with 7,500 handed over moves the
   balance by nothing, and the columns were showing the movement. The money
   was in the ledger and invisible on it.

   A bill has two movements on one line — goods out, and whatever came back
   over the counter — and both belong on the row. The property that makes
   that safe is the one asserted here: whatever the two columns say, gave
   minus got must equal how far the balance actually moved. If that ever
   stops holding, the statement is telling the shop two different stories
   about the same rupees. */
{
  const check = (
    label: string,
    row: Record<string, unknown>,
    net: number,
    want: { gave: number; got: number },
  ) => {
    const c = ledgerColumns(row as never, net);
    assert(
      approx(c.gave, want.gave) && approx(c.got, want.got),
      "LC: " + label + " — got gave=" + c.gave + " got=" + c.got,
    );
    assert(
      approx(r2(c.gave - c.got), net),
      "LC: " + label + " reconciles — " + c.gave + " − " + c.got + " should be " + net,
    );
  };

  /* The case that was broken: nothing owed before, nothing owed after, and
     7,500 of trade on the line. */
  check("a sale settled in full at the counter", { docKind: "sale", total: 7500 }, 0, {
    gave: 7500,
    got: 7500,
  });
  check("a sale wholly on credit", { docKind: "sale", total: 300 }, 300, { gave: 300, got: 0 });
  check("a part-paid sale", { docKind: "sale", total: 1000 }, 600, { gave: 1000, got: 400 });

  /* Purchases mirror it: goods IN at full value, money out on the same line. */
  check("a purchase paid on the spot", { docKind: "purchase", total: 18000 }, 0, {
    gave: 18000,
    got: 18000,
  });
  check("a purchase on credit", { docKind: "purchase", total: 18000 }, -18000, {
    gave: 0,
    got: 18000,
  });

  /* One-directional rows stay one-directional. A return's stored settled
     figure equals its total for bookkeeping reasons, and reading that
     directly would invent a second movement. */
  check("a payment received", { type: "Payment Received", total: 2890 }, -2890, {
    gave: 0,
    got: 2890,
  });
  check("a payment made", { type: "Payment Made", total: 5000 }, 5000, { gave: 5000, got: 0 });
  check(
    "a sale return, whose settled figure mirrors its total",
    { docKind: "sale-return", total: 500, receivedOrPaid: 500 },
    -500,
    { gave: 0, got: 500 },
  );
  check("a write-off", { type: "Discount Given", total: 250 }, -250, { gave: 0, got: 250 });
}

/* ═══════ TEST SP: what a line starts at ═══════
   Two rules, both of which have already gone wrong in production.

   A sale line must start at the item selling price — not at this party own
   last price, which is how a picker showing 7,000 produced a line of 6,105.
   That preference was right while an item selling price was rewritten by
   whatever bill went out last; once that write was removed the selling price
   became the shop own decision, and history quietly overruling it is the
   shop being argued with by its records.

   And it must never fall back to the purchase price, which billed at cost
   with nothing on screen looking wrong.

   Source-level, and honestly so: the behavioural version of this passes
   whichever rule is in force, because the seeded item sells at 100 and has
   no differing history, so both mutations survive it. A test that cannot
   fail is not evidence. */
{
  const form = readFileSync(process.cwd() + "/src/components/InvoiceForm.tsx", "utf8");
  const want = "price: isSale ? (it.salePrice ?? 0) : (historicalPrice ?? it.purchasePrice),";
  const n = form.split(want).length - 1;
  assert(
    n === 2,
    "SP1: both places that build a line start a sale at the selling price — found " + n + " of 2",
  );
  assert(
    !form.includes("it.salePrice || it.purchasePrice"),
    "SP2: and no sale ever falls back to cost",
  );
}

/* ═══════ TEST LO: the total closes the entry, it does not open it ═══════
   A bill on paper lists what was bought and totals it underneath. The
   statement was doing the reverse — announcing "7 items · 17,790.00" and then
   showing the seven — which is an order you have to be taught to read. Every
   hand-written khata in the shop already works the other way round.

   Pinned at the source because document ORDER is the whole claim, and the two
   documents have to agree: the screen and the PDF are the same statement, and
   the shop has already been burnt once by them disagreeing. */
{
  const screen = readFileSync(process.cwd() + "/src/routes/parties_.$id.tsx", "utf8");
  const itemsAt = screen.indexOf("{hasDetail && (");
  const totalAt = screen.indexOf("onClick={onOpen}");
  assert(itemsAt > 0 && totalAt > 0, "LO1: the statement row still has both halves");
  assert(
    itemsAt < totalAt,
    "LO2: on screen the item lines come first and the total closes the entry",
  );

  const pdf = readFileSync(process.cwd() + "/src/components/PrintablePartyStatement.tsx", "utf8");
  const pItems = pdf.indexOf("{showBreakdown && (");
  const pTotal = pdf.indexOf(`{opening ? "" : fmtDate(r.date)}`);
  assert(pItems > 0 && pTotal > 0, "LO3: the printed statement still has both halves");
  assert(pItems < pTotal, "LO4: and the PDF prints them in that same order");

  /* A total torn onto the next page away from the lines it totals is the
     failure this order introduces, so both documents refuse that break. */
  assert(
    screen.includes(`breakBefore: hasDetail ? "avoid" : undefined`),
    "LO5: on screen a total is never broken away from its items",
  );
  assert(
    pdf.includes(`...(showBreakdown ? { pageBreakBefore: "avoid", breakBefore: "avoid" } : null)`),
    "LO6: nor in the PDF",
  );
}

/* ═══════ TEST PP: a dropdown that lands on the screen ═══════
   Photographed at the counter, on a phone: the item search dropdown opened
   with its prices hanging off the right edge of the display, and the
   last-prices popup lost its heading off the left. Both were anchored to an
   input inside a 720px-wide table on a 390px screen, and neither ever
   compared its answer to the width of the phone.

   The phone is the case every assertion here is built around, because the
   desk is the case that already worked. */
{
  const phone = { width: 390, height: 844 };
  /* An input sitting 140px into a table that is wider than the screen — so
     its right edge is already past the display. */
  const scrolledOff = { top: 300, bottom: 328, left: 140, right: 440, width: 300 };

  {
    const p = popupRect(scrolledOff, phone, { minWidth: 260 });
    assert(p.left >= 8, "PP1: a dropdown starts on the screen — left " + p.left);
    assert(p.left + p.width <= 390 - 8, "PP2: and ends on it — right edge " + (p.left + p.width));
    assert(p.width >= 260, "PP3: without being squeezed below readable — " + p.width);
  }

  /* Right-aligned, which is the one that walked off the LEFT: 256 subtracted
     from an input near the left gutter is a negative x. */
  {
    const nearLeft = { top: 300, bottom: 328, left: 12, right: 120, width: 108 };
    const p = popupRect(nearLeft, phone, { align: "right", preferredWidth: 256 });
    assert(p.left >= 8, "PP4: a right-aligned popup does not walk off the left — " + p.left);
    assert(p.left + p.width <= 382, "PP5: nor off the right — " + (p.left + p.width));
  }

  /* A panel may never be wider than the screen it has to fit on, however wide
     the thing it is anchored to. */
  {
    const wide = { top: 100, bottom: 130, left: 0, right: 700, width: 700 };
    const p = popupRect(wide, phone, { minWidth: 600 });
    assert(p.width <= 390 - 16, "PP6: never wider than the screen — " + p.width);
    assert(p.left >= 8 && p.left + p.width <= 382, "PP7: and still inside both gutters");
  }

  /* The keyboard, and the trap underneath it.
     A keyboard does not change the layout viewport at all — window.innerHeight
     is still 844 — it only covers the bottom of it. So the room below is
     measured against the visible band and the placement is measured against
     the layout box, and those are two different numbers that must not be
     swapped. */
  {
    const keyboardUp = { width: 390, height: 844, visibleTop: 0, visibleBottom: 400 };
    const low = { top: 330, bottom: 360, left: 20, right: 300, width: 280 };
    const p = popupRect(low, keyboardUp);
    assert(p.top === undefined, "PP8: with the keyboard over it, the list does not open downwards");
    /* The one that matters. `bottom` on a fixed element is measured from the
       bottom of the LAYOUT viewport, so this is the only value that puts the
       panel's lower edge against the input. Photographed failing: it was
       computed against the visible band instead and landed 220px above the
       box it belongs to, up beside the Bill Date field. */
    assert(
      p.bottom === 844 - (330 - 4),
      "PP9: it grows upward FROM the input — bottom " + p.bottom,
    );
    assert(
      844 - (p.bottom ?? 0) === 326,
      "PP10: whose lower edge is 4px above the input, not somewhere up the page",
    );
    assert(p.maxHeight > 0 && p.maxHeight <= 330, "PP11: within the room above it");
  }

  /* The exact reading that produced the photograph. At the moment a field is
     focused, iOS has already scrolled for the keyboard (offsetTop ≈ 217) but
     has not yet reported the shorter height, so visibleBottom comes back as
     1061 on an 844px phone. A bottom edge below the bottom of the screen is
     not a reading worth acting on: clamp it, and the answer is simply "there
     is room below", which there is. */
  {
    const stale = { width: 390, height: 844, visibleTop: 217, visibleBottom: 1061 };
    const box = { top: 330, bottom: 360, left: 20, right: 300, width: 280 };
    const p = popupRect(box, stale);
    assert(p.top === 364, "PP12: a viewport taller than the screen is not believed — top " + p.top);
    assert(
      (p.top ?? 0) + p.maxHeight <= 844,
      "PP13: and nothing is placed past the bottom of the real screen",
    );
  }

  /* And when there IS room below, it stays below — flipping a dropdown that
     had somewhere to go is its own kind of wrong. */
  {
    const high = { top: 100, bottom: 130, left: 20, right: 300, width: 280 };
    const p = popupRect(high, phone);
    assert(p.top === 134, "PP14: with room below, it hangs below the input — " + p.top);
    assert(p.bottom === undefined, "PP15: and is not bottom-anchored");
    assert(p.maxHeight <= 844 - 134, "PP16: never taller than the room it was given");
  }

  /* The desk, unchanged: a dropdown under a 200px input on a wide screen
     lines up with the input's own left edge and takes its own width. */
  {
    const desk = { width: 1440, height: 900 };
    const input = { top: 300, bottom: 328, left: 420, right: 620, width: 200 };
    const p = popupRect(input, desk);
    assert(p.left === 420, "PP17: on a desk it still lines up with its input");
    assert(p.width === 200, "PP18: at the input's own width");
    assert(p.top === 332, "PP19: just below it");
  }
}

/* ═══════ TEST WA: what the bridge now says, and what we do about it ═══════
   The bridge was rebuilt to answer honestly instead of optimistically, and
   every new sentence it can produce has to land in the right bucket here.
   Getting one wrong costs the shop a customer's trust in one direction or a
   duplicate invoice in the other. */
{
  /* A number that is not on WhatsApp. Before the bridge asked, this send
     "succeeded" into nothing — a landline or a mistyped digit swallowed a
     bill silently. It is a real answer about the number, so it must reach a
     person and must never sit in a retry queue: no amount of waiting makes a
     number exist. */
  assert(
    classifySendFailure(
      "919999999999 is not on WhatsApp — check the number saved for this party",
      true,
    ) === "permanent",
    "WA1: a number that is not on WhatsApp is never queued",
  );
  assert(
    classifySendFailure("919999999999 is not on WhatsApp — check the number", false) ===
      "permanent",
    "WA2: and stays permanent even when the app thought the link was down",
  );

  /* The two that must never be retried by a timer. Both can arrive while the
     app believes the link is down, which is exactly the path that used to
     classify them "offline" — safe to retry — when a message may already be
     on its way. */
  assert(
    classifySendFailure(
      "This message is already being sent — wait for that attempt to finish",
      false,
    ) === "uncertain",
    "WA3: a send already in flight is never auto-retried, link state notwithstanding",
  );
  assert(
    classifySendFailure(
      "The WhatsApp service didn't answer in time — the message may or may not have been sent.",
      false,
    ) === "uncertain",
    "WA4: nor is a request that timed out with no answer at all",
  );

  /* And the opposite mistake. A halted bridge reports through "not
     connected", which means nothing was handed over — so this one IS safe for
     the queue to retry on its own, and treating it as uncertain would leave
     the shop hand-sending every bill after a blip. */
  assert(
    classifySendFailure(
      "WhatsApp is not connected — this session was taken over by another connection",
      true,
    ) === "offline",
    "WA5: a session taken over means nothing was sent, so the queue may retry it",
  );
}

console.log(`  AUDIT RESULT: ${passed} assertions passed, ${failed} failed`);
if (fails.length) {
  console.log(`\nFailures:`);
  fails.forEach((f) => console.log("  ✗ " + f));
  process.exit(1);
}
console.log(`  ✅ ALL INVARIANTS HELD`);
console.log(`══════════════════════════════════════\n`);

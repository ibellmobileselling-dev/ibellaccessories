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
  StockAdjustment,
  BankTxn,
  CashAdjustment,
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
import { transferLegsFor } from "@/lib/transferLegs";
import { AuditLogRepo, nextVoucherNo } from "@/repositories";
import { isLocked, blockedDate, lockMessage } from "@/lib/periodLock";
import { buildJournal, isBalanced, entryDrift, liveOnly, type Book } from "@/lib/posting";
import { canDeleteOutright, isVoided, removalWord } from "@/lib/voiding";
import {
  financialYear,
  profitAndLoss,
  balanceSheet,
  planYearClose,
  closingEntry,
  closingEntryBalances,
} from "@/lib/financials";
import { accountsFor } from "@/lib/accounts";
import { reconcile, trialBalance, balanceOf, partyPositionsFromLedger } from "@/lib/trialBalance";
import {
  CASH_PURPOSES,
  CHOOSABLE_PURPOSES,
  purposeSpec,
  purposeLabel,
  totalsByPurpose,
} from "@/lib/cashPurpose";

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
  // transfer's other side is a real account, and clIBELLing "transfer" from the
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
     A balance sheet's whole clIBELL is that what the shop owns equals what it
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

console.log(`  AUDIT RESULT: ${passed} assertions passed, ${failed} failed`);
if (fails.length) {
  console.log(`\nFailures:`);
  fails.forEach((f) => console.log("  ✗ " + f));
  process.exit(1);
}
console.log(`  ✅ ALL INVARIANTS HELD`);
console.log(`══════════════════════════════════════\n`);

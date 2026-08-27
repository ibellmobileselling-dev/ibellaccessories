/**
 * Reading the ledger, and proving it agrees with the app.
 *
 * A posting ledger nobody has checked is worse than no ledger, because it
 * looks authoritative. So this file does two things:
 *
 *   `trialBalance()`  — sums the journal into one figure per account, the way
 *                       an accountant asks to see it.
 *   `reconcile()`     — puts the ledger's answer next to the answer the app
 *                       already gives, for every figure the shop actually
 *                       reads, and names the difference.
 *
 * The second is the point. BizDesk derives receivables one way, cash another
 * and profit a third; the dashboard double-count happened precisely because
 * two of those disagreed and nothing compared them. The ledger is a fourth
 * derivation — worth nothing until it is shown to match the three that the
 * shop has been running on, and worth a great deal once it does, because
 * from then on there is one number to read instead of four to hope about.
 *
 * Nothing here drives a screen the shop depends on yet. That is deliberate
 * (docs/ERP-PLAN.md §1, stage 2): reconcile first, switch readers one at a
 * time afterwards.
 */

import type { Account, AccountGroup } from "@/lib/accounts";
import { GROUP_ORDER, NORMAL_BALANCE, accountsFor, bankAccountId } from "@/lib/accounts";
import type { Book, JournalEntry } from "@/lib/posting";
import { buildJournal, liveOnly, unbalancedEntries } from "@/lib/posting";
import { profitAndLoss } from "@/lib/financials";
import {
  bankFlows,
  cashFlows,
  computeCogs,
  netFlow,
  netPartyPositions,
  totalSettlementDiscount,
  valueExTax,
} from "@/lib/ledger";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface AccountBalance {
  accountId: string;
  code: string;
  name: string;
  group: AccountGroup;
  note?: string;
  debit: number;
  credit: number;
  /** Debit minus credit. The raw arithmetic, signed. */
  net: number;
  /**
   * The same figure the way the account is read: a liability of 5,000 is
   * 5,000, not −5,000. Sign only survives when the account is genuinely the
   * wrong way round — a bank account overdrawn, receivables in credit —
   * which is exactly when it needs to be visible.
   */
  balance: number;
}

/** Debit minus credit on one account. */
export function balanceOf(entries: JournalEntry[], accountId: string): number {
  let n = 0;
  for (const e of entries) {
    for (const l of e.lines) {
      if (l.accountId === accountId) n += l.debit - l.credit;
    }
  }
  return r2(n);
}

/** Every account with a movement, plus the totals that must match. */
export function trialBalance(
  entries: JournalEntry[],
  accounts: Account[],
): {
  rows: AccountBalance[];
  totalDebit: number;
  totalCredit: number;
  /** Total debits minus total credits. Zero, or a posting rule is broken. */
  drift: number;
  /** Lines pointing at an account that is not in the chart. Always a bug. */
  orphans: string[];
} {
  const byId = new Map(accounts.map((a) => [a.id, a] as const));
  const acc = new Map<string, { debit: number; credit: number }>();
  const orphans = new Set<string>();

  for (const e of entries) {
    for (const l of e.lines) {
      if (!byId.has(l.accountId)) orphans.add(l.accountId);
      const cur = acc.get(l.accountId) ?? { debit: 0, credit: 0 };
      cur.debit = r2(cur.debit + l.debit);
      cur.credit = r2(cur.credit + l.credit);
      acc.set(l.accountId, cur);
    }
  }

  const rows: AccountBalance[] = [];
  for (const [accountId, v] of acc) {
    const a = byId.get(accountId);
    const group = a?.group ?? "asset";
    const net = r2(v.debit - v.credit);
    rows.push({
      accountId,
      code: a?.code ?? "9999",
      name: a?.name ?? `Unknown account (${accountId})`,
      group,
      note: a?.note,
      debit: v.debit,
      credit: v.credit,
      net,
      balance: r2(net * NORMAL_BALANCE[group]),
    });
  }

  rows.sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.code.localeCompare(b.code),
  );

  const totalDebit = r2(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = r2(rows.reduce((s, r) => s + r.credit, 0));
  return {
    rows,
    totalDebit,
    totalCredit,
    drift: r2(totalDebit - totalCredit),
    orphans: [...orphans],
  };
}

/**
 * Every entry that touched one account, oldest first, with a running balance.
 *
 * A trial balance without this is a set of assertions: "Accounts Receivable is
 * 4,12,300" and nothing to do about it but believe. The first question anyone
 * asks of a figure they doubt is "made up of what?", and an accountant asks it
 * about every figure. `docKind` and `docId` have been on every entry since the
 * ledger was built precisely so this could exist.
 */
export function accountLedger(
  entries: JournalEntry[],
  accountId: string,
): { rows: AccountLedgerRow[]; debit: number; credit: number; closing: number } {
  const rows: AccountLedgerRow[] = [];
  let running = 0;
  let debit = 0;
  let credit = 0;
  // Oldest first: a running balance read from the bottom up is not a running
  // balance. The trial balance itself sorts the other way, so this is a
  // deliberate difference, not an oversight.
  const ordered = [...entries].sort((a, b) =>
    a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date),
  );
  for (const e of ordered) {
    for (const l of e.lines) {
      if (l.accountId !== accountId) continue;
      running = r2(running + l.debit - l.credit);
      debit = r2(debit + l.debit);
      credit = r2(credit + l.credit);
      rows.push({
        date: e.date,
        voucherType: e.voucherType,
        voucherNo: e.voucherNo,
        narration: e.narration,
        docKind: e.docKind,
        docId: e.docId,
        debit: l.debit,
        credit: l.credit,
        balance: running,
      });
    }
  }
  return { rows, debit, credit, closing: running };
}

export interface AccountLedgerRow {
  date: string;
  voucherType: string;
  voucherNo?: string;
  narration: string;
  docKind: string;
  docId: string;
  debit: number;
  credit: number;
  /** Running debit-minus-credit after this line. */
  balance: number;
}

/** Subtotal per group, for the trial balance's group rows. */
export function groupTotals(rows: AccountBalance[]): { group: AccountGroup; balance: number }[] {
  return GROUP_ORDER.map((group) => ({
    group,
    balance: r2(rows.filter((r) => r.group === group).reduce((s, r) => s + r.balance, 0)),
  })).filter((g) => g.balance !== 0);
}

/**
 * One signed position per party, read straight off the journal.
 *
 * Positive means they owe the shop, matching `netPartyPositions` and every
 * party statement. Both receivable and payable lines fold the same way —
 * a debit is always "they owe more", whether it lands in Receivable
 * (a sale) or in Payable (a bill of theirs settled) — which is why one sum
 * covers both sides.
 */
export function partyPositionsFromLedger(entries: JournalEntry[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of entries) {
    for (const l of e.lines) {
      if (!l.partyId) continue;
      if (l.accountId !== "ar" && l.accountId !== "ap") continue;
      map.set(l.partyId, r2((map.get(l.partyId) ?? 0) + l.debit - l.credit));
    }
  }
  return map;
}

export interface ReconRow {
  key: string;
  label: string;
  /**
   * A figure worth showing that has no right answer to be checked against.
   *
   * Inventory is the only one: the ledger carries stock at what each movement
   * actually cost, while the stock report values what is on the shelf at
   * today's purchase price. Those are two different questions, and they
   * separate whenever a purchase price moves — which is normal trading, not a
   * fault. Marking it informational keeps a real difference visible without
   * turning a screen that must only cry wolf into one that always does.
   */
  informational?: boolean;
  /** What the posting ledger says. */
  ledger: number;
  /** What the screens the shop uses today say. */
  app: number;
  diff: number;
  ok: boolean;
  /** What is being compared, and what a difference would mean. */
  why: string;
}

export interface Reconciliation {
  entries: JournalEntry[];
  accounts: Account[];
  rows: ReconRow[];
  /** Entries whose debits and credits disagree. Always a bug. */
  unbalanced: JournalEntry[];
  /** Parties where the two derivations disagree, worst first. */
  partyGaps: { partyId: string; name: string; ledger: number; app: number; diff: number }[];
  ok: boolean;
}

/**
 * The whole check, in one call.
 *
 * Every row compares the ledger with an INDEPENDENTLY written calculation —
 * `netPartyPositions`, `cashFlows`, `bankFlows`, the stored bank balances, and
 * the P&L the Reports screen prints. None of them share code with the posting
 * rules, so agreement is evidence and not a tautology.
 */
export function reconcile(book: Book): Reconciliation {
  const entries = buildJournal(book);
  // The ledger sees everything, including what was cancelled — it reverses a
  // void rather than forgetting it. Every other calculation in the app sees
  // only live records. Each side of the comparison below is therefore given
  // the book it actually reads; handing both the same one made a voided
  // document count in full on one side and net to nothing on the other.
  const app = liveOnly(book);
  const accounts = accountsFor(book.banks, book.expenses);
  const tb = trialBalance(entries, accounts);
  const rows: ReconRow[] = [];
  const add = (
    key: string,
    label: string,
    ledger: number,
    app: number,
    why: string,
    eps = 0.02,
    informational = false,
  ) => {
    const diff = r2(ledger - app);
    rows.push({
      key,
      label,
      ledger: r2(ledger),
      app: r2(app),
      diff,
      ok: informational || Math.abs(diff) <= eps,
      why,
      ...(informational ? { informational } : {}),
    });
  };

  /* 1. The ledger's own arithmetic. Nothing below means anything if this
        fails, so it is first. */
  add(
    "balanced",
    "Every entry balances",
    tb.totalDebit,
    tb.totalCredit,
    "Total debits against total credits across every entry. A difference is a posting rule that does not add up, not a data problem.",
  );

  /* 2. Parties. Compared one at a time and then summed, because two parties
        wrong in opposite directions would cancel out in a total — which is
        how the original double-count hid. */
  const appPositions = netPartyPositions(app.parties, {
    sales: app.sales,
    purchases: app.purchases,
    saleReturns: app.saleReturns,
    purchaseReturns: app.purchaseReturns,
    payments: app.payments,
  });
  const ledgerPositions = partyPositionsFromLedger(entries);
  const nameOf = new Map(book.parties.map((p) => [p.id, p.name] as const));
  const partyGaps: Reconciliation["partyGaps"] = [];
  const seen = new Set<string>([...ledgerPositions.keys(), ...appPositions.map((p) => p.partyId)]);
  for (const partyId of seen) {
    const ledger = ledgerPositions.get(partyId) ?? 0;
    const app = appPositions.find((p) => p.partyId === partyId)?.net ?? 0;
    const diff = r2(ledger - app);
    if (Math.abs(diff) > 0.02)
      partyGaps.push({
        partyId,
        name: nameOf.get(partyId) ?? partyId,
        ledger,
        app,
        diff,
      });
  }
  partyGaps.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  const appReceivable = r2(appPositions.reduce((s, p) => s + Math.max(0, p.net), 0));
  const appPayable = r2(appPositions.reduce((s, p) => s + Math.max(0, -p.net), 0));
  const ledgerReceivable = r2(
    [...ledgerPositions.values()].reduce((s, n) => s + Math.max(0, n), 0),
  );
  const ledgerPayable = r2([...ledgerPositions.values()].reduce((s, n) => s + Math.max(0, -n), 0));

  add(
    "receivable",
    "Total Receivable",
    ledgerReceivable,
    appReceivable,
    "Summed per party from the ledger's Receivable and Payable lines, against netPartyPositions — the figure the dashboard prints.",
  );
  add(
    "payable",
    "Total Payable",
    ledgerPayable,
    appPayable,
    "The other side of the same comparison. A party can land on one side or the other, never both.",
  );

  /* 3. Cash. `cashFlows` is the app's own answer, built from the payment
        modes on documents plus the manual adjustments. */
  const appCash = netFlow(
    cashFlows(app.sales, app.purchases, app.expenses, app.payments, app.cashAdjustments),
  );
  add(
    "cash",
    "Cash in Hand",
    balanceOf(entries, "cash"),
    appCash,
    "Against cashFlows — cash-mode bills, expenses and payments, plus every manual cash entry.",
  );

  /* 4. Banks, one account at a time against its own stored balance. This is
        the row most likely to move on real data: `BankAccount.balance` is one
        of only two stored running totals in the app, and lib/bankRepair.ts
        exists because it drifts. A gap here is that drift, measured. */
  for (const b of book.banks) {
    add(
      `bank:${b.id}`,
      b.name || "Bank Account",
      balanceOf(entries, bankAccountId(b.id)),
      r2(b.balance || 0),
      "The account's postings against its stored balance. A gap is drift in the stored figure — the same thing planBankRepair looks for.",
    );
  }
  add(
    "bank-unattributed",
    "Bank (account not recorded)",
    balanceOf(entries, "bank-unattributed"),
    netFlow(bankFlows(app.sales, app.purchases, app.expenses, app.payments)),
    "Bank, UPI and cheque money never tied to a specific account, against bankFlows. Anything here sits outside every stored bank balance.",
  );

  /* 4b. Inventory. Two honest answers to two different questions, shown
        side by side rather than left off because they do not tie out.

        The ledger carries stock at what each movement cost when it happened;
        the stock report values what is on the shelf at today's purchase
        price. A shop whose costs never moved would see these agree. A shop
        whose costs moved sees the difference, and the difference IS the
        price movement — which is worth knowing and is not an error.

        What WOULD be an error is the quantities disagreeing, and that has
        its own check: Settings → Fix Calculations rebuilds stock from the
        documents. This row is about value, not count. */
  const stockAtCurrentCost = r2(
    app.items.reduce((s, i) => s + (Number(i.stock) || 0) * (i.purchasePrice || 0), 0),
  );
  add(
    "inventory",
    "Inventory",
    balanceOf(entries, "inventory"),
    stockAtCurrentCost,
    "The ledger carries stock at what each movement cost at the time; the stock report values it at today's purchase price. They separate when purchase prices move, which is normal trading — shown for information, not as a fault. Quantities are checked separately by Fix Calculations.",
    0.02,
    true,
  );

  /* 5. Profit. The Reports screen's P&L, against income minus expenses in the
        ledger — with the accounts that P&L has never included named
        explicitly rather than absorbed to make the row match. */
  /* Read through profitAndLoss rather than off the trial balance, because a
     closed year has already had its income and expenses emptied into Retained
     Earnings. Summing the accounts as they stand would compare the open
     period against the app's all-time figure and report a gap the size of
     every closed year — a false alarm on the one screen that must not cry
     wolf. Closing entries are excluded; the documents behind them are not. */
  const ledgerProfit = profitAndLoss(entries, accounts, "", "").netProfit;

  const appProfit = r2(
    valueExTax(app.sales) -
      valueExTax(app.saleReturns) -
      computeCogs(app.sales, app.saleReturns, app.items) -
      app.expenses.reduce((s, e) => s + (e.amount || 0), 0) -
      totalSettlementDiscount(app.payments.filter((p) => p.type === "in")) +
      totalSettlementDiscount(app.payments.filter((p) => p.type === "out")),
  );
  /* Three accounts exist in the ledger that the app's P&L has never counted:
     stock written off, unexplained cash, and other income. Those are real
     costs and real income, so the honest comparison adds them back to the
     app's figure and says so — rather than dropping them from the ledger to
     make the two agree. */
  /* All three read as debit-minus-credit, which is why they add rather than
     subtract: an expense is a positive debit, and income earned is a negative
     one. */
  const missedByApp = r2(
    balanceOf(entries, "stock-written-off") +
      balanceOf(entries, "cash-short-over") +
      balanceOf(entries, "other-income"),
  );
  add(
    "profit",
    "Net Profit",
    ledgerProfit,
    r2(appProfit - missedByApp),
    missedByApp
      ? `Against the Reports P&L, less ${r2(missedByApp)} the app's P&L does not count: stock written off, unexplained cash and other income.`
      : "Against the Reports P&L — revenue less returns, cost of goods, expenses and settlement discounts.",
  );

  const unbalanced = unbalancedEntries(entries);
  return {
    entries,
    accounts,
    rows,
    unbalanced,
    partyGaps,
    ok:
      rows.every((r) => r.ok) &&
      unbalanced.length === 0 &&
      partyGaps.length === 0 &&
      tb.orphans.length === 0,
  };
}

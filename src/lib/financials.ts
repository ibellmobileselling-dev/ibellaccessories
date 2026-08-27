/**
 * The two statements every business is measured by, read off the one ledger —
 * and the entry that closes a year.
 *
 * Phase 2 built the ledger and proved it agrees with the app. This is what it
 * was for: a Profit & Loss and a Balance Sheet that cannot disagree with each
 * other, because they are two views of the same postings rather than two
 * independent calculations. The existing Reports P&L adds up its own figures a
 * different way; that one stays until the shop has been told what the new
 * number includes that the old one never did (see `plGaps` below).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE YEAR CLOSE, AND WHY IT IS THE FIRST THING THAT MUST BE STORED
 * ───────────────────────────────────────────────────────────────────────────
 * Every other entry in this ledger is derived from a document, so it never
 * needs saving. A closing entry has no document behind it: it is a decision
 * that a year is finished, taken on a date by a person. Nothing in the shop's
 * data implies it, so it has to be written down — and once written it must not
 * move, because next year's opening position is built on it.
 *
 * What it does is mechanical. On the last day of the year, every income and
 * expense account is emptied into Retained Earnings. After that the P&L for
 * the new year starts from zero while the balance sheet carries the profit
 * forward as equity, which is exactly what "closing the books" means.
 *
 * The one subtlety worth stating, because getting it backwards makes every
 * statement wrong:
 *
 *   - The **P&L excludes** closing entries. It must: a P&L for the year that
 *     included the entry emptying its own accounts would read zero.
 *   - The **balance sheet and trial balance include** them. They must: that is
 *     how the profit reaches equity and how a closed year stops being counted
 *     twice.
 *   - The **close itself includes** every earlier close. That is what makes it
 *     work at all — last year's close already removed last year's income, so
 *     whatever is left in those accounts is this year's and nothing else.
 */

import type { Account, AccountGroup } from "@/lib/accounts";
import { NORMAL_BALANCE } from "@/lib/accounts";
import type { JournalEntry, PostingLine } from "@/lib/posting";
import { entryCredits, entryDebits } from "@/lib/posting";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** `docKind` on a closing entry. The one value both statements branch on. */
export const YEAR_CLOSE = "year-close";

/**
 * A closing entry, or the reversal of one.
 *
 * Both are outside the P&L for the same reason: a year whose statement
 * counted the entry that emptied its own accounts would report zero, and one
 * that counted the reversal of that entry would report double.
 */
export const isClosingEntry = (e: { docKind: string }) =>
  e.docKind === YEAR_CLOSE || e.docKind === `${YEAR_CLOSE}-void`;

/** India's financial year runs April to March. Configurable so the code does
 *  not lie about being universal, but nothing in this shop will change it. */
export const FY_START_MONTH = 4;

export interface FinancialYear {
  /** First day, inclusive. */
  start: string;
  /** Last day, inclusive. */
  end: string;
  /** How a shop says it: "2025-26". */
  label: string;
}

/** The financial year a date falls inside. */
export function financialYear(date: string, startMonth = FY_START_MONTH): FinancialYear {
  const [y, m] = (date || "").split("-").map(Number);
  const year = Number.isFinite(y) ? y : new Date().getFullYear();
  const month = Number.isFinite(m) ? m : 1;
  // Before April, the year belongs to the one that started last April.
  const startYear = month >= startMonth ? year : year - 1;
  const endYear = startYear + 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  // The last day of the month before the start month, a year on.
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endDay = new Date(startMonth === 1 ? endYear + 1 : endYear, endMonth, 0).getDate();
  return {
    start: `${startYear}-${pad(startMonth)}-01`,
    end: `${startMonth === 1 ? startYear : endYear}-${pad(endMonth)}-${pad(endDay)}`,
    label: `${startYear}-${String(endYear).slice(-2)}`,
  };
}

/* ── Reading account balances out of a set of entries ─────────────────── */

export interface StatementLine {
  accountId: string;
  code: string;
  name: string;
  note?: string;
  /** Read the way the account is read: an expense positive when spent, a
   *  liability positive when owed. */
  amount: number;
}

function linesFor(
  entries: JournalEntry[],
  accounts: Account[],
  group: AccountGroup,
): StatementLine[] {
  const inGroup = new Map(accounts.filter((a) => a.group === group).map((a) => [a.id, a] as const));
  const totals = new Map<string, number>();
  for (const e of entries) {
    for (const l of e.lines) {
      if (!inGroup.has(l.accountId)) continue;
      totals.set(l.accountId, (totals.get(l.accountId) ?? 0) + l.debit - l.credit);
    }
  }
  return [...totals.entries()]
    .map(([accountId, net]) => {
      const a = inGroup.get(accountId)!;
      return {
        accountId,
        code: a.code,
        name: a.name,
        note: a.note,
        amount: r2(net * NORMAL_BALANCE[group]),
      };
    })
    .filter((l) => l.amount !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));
}

const sum = (lines: StatementLine[]) => r2(lines.reduce((s, l) => s + l.amount, 0));

/* ── Profit & Loss ────────────────────────────────────────────────────── */

export interface ProfitAndLoss {
  from: string;
  to: string;
  income: StatementLine[];
  expense: StatementLine[];
  totalIncome: number;
  totalExpense: number;
  netProfit: number;
}

/**
 * What the shop earned and spent between two dates.
 *
 * Closing entries are excluded — see the header. A P&L that included the entry
 * emptying its own accounts would report zero for every closed year, which is
 * the most confidently wrong number a report can print.
 */
export function profitAndLoss(
  entries: JournalEntry[],
  accounts: Account[],
  from: string,
  to: string,
): ProfitAndLoss {
  const inRange = entries.filter(
    (e) => !isClosingEntry(e) && (!from || e.date >= from) && (!to || e.date <= to),
  );
  const income = linesFor(inRange, accounts, "income");
  const expense = linesFor(inRange, accounts, "expense");
  const totalIncome = sum(income);
  const totalExpense = sum(expense);
  return {
    from,
    to,
    income,
    expense,
    totalIncome,
    totalExpense,
    netProfit: r2(totalIncome - totalExpense),
  };
}

/**
 * The accounts the app's own P&L has never counted.
 *
 * Standing rule 5 of the plan: a behaviour change gets flagged before it
 * reaches the shop. Switching the Reports P&L to the ledger would move the
 * profit figure the owner has been reading for months, and this is by exactly
 * how much and exactly why — shown on the statement rather than explained in a
 * commit message nobody will read.
 */
export function plGaps(pl: ProfitAndLoss): StatementLine[] {
  const keys = new Set(["stock-written-off", "cash-short-over", "other-income"]);
  return [...pl.income, ...pl.expense].filter((l) => keys.has(l.accountId));
}

/* ── Balance Sheet ────────────────────────────────────────────────────── */

export interface BalanceSheet {
  asAt: string;
  assets: StatementLine[];
  liabilities: StatementLine[];
  equity: StatementLine[];
  /** Profit since the last year close, shown as equity because that is what
   *  it is until the year is closed and it becomes Retained Earnings. */
  currentEarnings: number;
  totalAssets: number;
  totalLiabilities: number;
  /** Including `currentEarnings`. */
  totalEquity: number;
  /** Assets less liabilities and equity. Zero, or the ledger does not balance. */
  drift: number;
}

/**
 * What the shop owns, owes, and is worth, on a day.
 *
 * Closing entries are INCLUDED — they are how a finished year's profit becomes
 * equity. Anything not yet closed shows as "Profit for the period", so the
 * statement balances whether or not the year has been closed. It has to: a
 * balance sheet that only balances on 31 March is not a balance sheet.
 */
export function balanceSheet(
  entries: JournalEntry[],
  accounts: Account[],
  asAt: string,
): BalanceSheet {
  const upto = entries.filter((e) => !asAt || e.date <= asAt);
  const assets = linesFor(upto, accounts, "asset");
  const liabilities = linesFor(upto, accounts, "liability");
  const equity = linesFor(upto, accounts, "equity");

  // Over the SAME set, closing entries included: a closed year's income is
  // already in Retained Earnings, so what is left in these accounts is the
  // open period's and nothing else.
  const currentEarnings = r2(
    sum(linesFor(upto, accounts, "income")) - sum(linesFor(upto, accounts, "expense")),
  );

  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const totalEquity = r2(sum(equity) + currentEarnings);
  return {
    asAt,
    assets,
    liabilities,
    equity,
    currentEarnings,
    totalAssets,
    totalLiabilities,
    totalEquity,
    drift: r2(totalAssets - totalLiabilities - totalEquity),
  };
}

/* ── The year close ───────────────────────────────────────────────────── */

export interface ClosingPlan {
  fy: FinancialYear;
  /** What will be posted. Empty when there is nothing left to close. */
  lines: PostingLine[];
  totalIncome: number;
  totalExpense: number;
  netProfit: number;
  /** An existing closing entry for this year, if there is one. */
  existingId?: string;
  /** Why this cannot be posted, in the words to show the owner. */
  blocked?: string;
}

/**
 * What closing a year would post, worked out before anything is written.
 *
 * The same shape as `planStockRepair` and `planBankRepair`: show the owner the
 * exact entry, then let them post it. A year close is the least reversible
 * thing in this application — next year's opening position is built on it — so
 * it does not happen behind a single button press.
 */
export function planYearClose(
  entries: JournalEntry[],
  accounts: Account[],
  fyEnd: string,
  todayDate: string,
  startMonth = FY_START_MONTH,
): ClosingPlan {
  const fy = financialYear(fyEnd, startMonth);
  // Everything up to the year end, earlier closes included — that is what
  // leaves only this year's income and expenses standing.
  const upto = entries.filter((e) => e.date <= fy.end);
  const income = linesFor(upto, accounts, "income");
  const expense = linesFor(upto, accounts, "expense");
  const totalIncome = sum(income);
  const totalExpense = sum(expense);
  const netProfit = r2(totalIncome - totalExpense);

  /* A close that has since been reversed is not a close. Both entries are
     still in the ledger — that is what append-only means — but the year is
     open again, and must be closable again. Recognised by its reversal rather
     than by the original being gone, because the original never goes. */
  const reversed = new Set(
    entries.filter((e) => e.docKind === `${YEAR_CLOSE}-void`).map((e) => e.docId),
  );
  const existing = entries.find(
    (e) => e.docKind === YEAR_CLOSE && e.date === fy.end && !reversed.has(e.docId),
  );

  const lines: PostingLine[] = [];
  // Empty each account into Retained Earnings: income carries a credit
  // balance, so it is debited to clear it, and expenses the other way. An
  // account that is somehow the wrong way round still clears correctly,
  // because the amount goes in signed and the sign decides the side.
  for (const l of income)
    lines.push(
      l.amount >= 0
        ? { accountId: l.accountId, debit: l.amount, credit: 0 }
        : { accountId: l.accountId, debit: 0, credit: -l.amount },
    );
  for (const l of expense)
    lines.push(
      l.amount >= 0
        ? { accountId: l.accountId, debit: 0, credit: l.amount }
        : { accountId: l.accountId, debit: -l.amount, credit: 0 },
    );
  if (netProfit)
    lines.push(
      netProfit > 0
        ? { accountId: "retained", debit: 0, credit: netProfit }
        : { accountId: "retained", debit: -netProfit, credit: 0 },
    );

  let blocked: string | undefined;
  if (existing) blocked = `${fy.label} has already been closed.`;
  else if (todayDate <= fy.end)
    blocked = `${fy.label} has not finished yet — it can be closed from ${fy.end}.`;
  else if (!lines.length) blocked = `Nothing was earned or spent in ${fy.label}.`;

  return {
    fy,
    lines,
    totalIncome,
    totalExpense,
    netProfit,
    existingId: existing?.docId,
    blocked,
  };
}

/** The entry a plan would post. Balanced by construction — the profit line is
 *  the difference between the two sides, so it cannot be anything else. */
export function closingEntry(plan: ClosingPlan): JournalEntry {
  return {
    id: `je-close-${plan.fy.label}`,
    date: plan.fy.end,
    voucherType: "Closing Entry",
    voucherNo: `YC-${plan.fy.label}`,
    docKind: YEAR_CLOSE,
    docId: `close-${plan.fy.label}`,
    narration: `Year close ${plan.fy.label} — ${
      plan.netProfit >= 0 ? "profit" : "loss"
    } of ${Math.abs(plan.netProfit)} to Retained Earnings`,
    periodKey: plan.fy.end.slice(0, 7),
    lines: plan.lines,
  };
}

/** A closing entry that does not balance must never be written. Checked here
 *  as well as in the test, because this is the one entry a person creates. */
export function closingEntryBalances(entry: JournalEntry): boolean {
  return Math.abs(r2(entryDebits(entry) - entryCredits(entry))) < 0.005;
}

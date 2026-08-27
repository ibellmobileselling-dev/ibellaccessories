/**
 * The chart of accounts.
 *
 * Every figure in an ERP is read off one ledger, and a ledger needs somewhere
 * for each side of a movement to land. This is that list: the smallest set of
 * accounts that can express everything this shop actually does, with a stable
 * `id` (referenced by every posting line) and a `code` (what accountants sort
 * and speak by).
 *
 * Two kinds of account:
 *   - **System** — fixed, listed here, never deleted. Cash, receivables, GST…
 *   - **Derived** — one per bank account and one per expense category, built
 *     from the shop's own data by `accountsFor()`. The shop names these by
 *     opening a bank account or typing a category, so hardcoding them would
 *     mean the chart went stale the moment they added one.
 *
 * Three accounts here exist to expose gaps rather than to hide them, and they
 * are the reason a trial balance is worth reading:
 *   - **Bank (account not recorded)** — money the app knows arrived by bank
 *     transfer, UPI or cheque but that was never tied to WHICH bank account.
 *     Today those amounts float outside every stored bank balance.
 *   - **Suspense** — money recorded as paid on a bill whose payment mode is
 *     "credit", i.e. settled with something the app never named. It reduces
 *     what the party owes but reaches no cash or bank position anywhere.
 *   - **Cash Short/Over** — cash movements whose stated reason is a counting
 *     difference or "something else".
 *
 * A real balance would show all three at or near zero. Whatever they hold is
 * the amount of the shop's money the software currently cannot place, which
 * is a number worth putting on screen instead of leaving spread across four
 * different derivations.
 */

export type AccountGroup = "asset" | "liability" | "equity" | "income" | "expense";

export interface Account {
  /** Stable key used by every posting line. Never renumber these. */
  id: string;
  /** Accountants' code — sorts the trial balance and is what they ask for. */
  code: string;
  name: string;
  group: AccountGroup;
  /** Fixed accounts that always exist, as opposed to one built per bank
   *  account or expense category. */
  system: boolean;
  /** Why this account exists, when that is not obvious from the name. Shown
   *  as the hint on the trial balance. */
  note?: string;
}

/**
 * Which way each group naturally leans: debit-positive or credit-positive.
 *
 * A trial balance that showed every account as a raw debit-minus-credit
 * number would print liabilities, income and equity as negatives, which is
 * the opposite of how the shop reads them. This is what turns the arithmetic
 * back into "what the account is worth".
 */
export const NORMAL_BALANCE: Record<AccountGroup, 1 | -1> = {
  asset: 1,
  expense: 1,
  liability: -1,
  equity: -1,
  income: -1,
};

/** Accounts that always exist. Order is display order. */
export const SYSTEM_ACCOUNTS: Account[] = [
  // ── Assets ────────────────────────────────────────────────────────────
  { id: "cash", code: "1000", name: "Cash in Hand", group: "asset", system: true },
  {
    id: "bank-unattributed",
    code: "1150",
    name: "Bank (account not recorded)",
    group: "asset",
    system: true,
    note: "Bank, UPI or cheque money that was never tied to a specific bank account. Anything here is outside every stored bank balance.",
  },
  { id: "ar", code: "1200", name: "Accounts Receivable", group: "asset", system: true },
  { id: "inventory", code: "1300", name: "Inventory", group: "asset", system: true },
  {
    id: "input-gst",
    code: "1400",
    name: "Input GST",
    group: "asset",
    system: true,
    note: "GST paid to suppliers, recoverable against Output GST.",
  },

  // ── Liabilities ───────────────────────────────────────────────────────
  { id: "ap", code: "2000", name: "Accounts Payable", group: "liability", system: true },
  {
    id: "output-gst",
    code: "2100",
    name: "Output GST",
    group: "liability",
    system: true,
    note: "GST collected from customers. Held on behalf of the government — never revenue.",
  },
  {
    id: "suspense",
    code: "1900",
    // An unidentified receipt is an unidentified ASSET: the bill says money
    // arrived, so something the shop owns went up — it is which thing that is
    // missing. Grouped with the assets so the usual case reads as a positive
    // figure; a negative one means money recorded as going out with no
    // account named, which is the same problem pointing the other way.
    group: "asset",
    name: "Suspense",
    system: true,
    note: "Recorded as paid on a bill whose payment mode is Credit — it moved what the party owes but reached no cash or bank account. Each amount here needs its real mode set.",
  },

  // ── Equity ────────────────────────────────────────────────────────────
  { id: "capital", code: "3000", name: "Owner's Capital", group: "equity", system: true },
  { id: "drawings", code: "3100", name: "Owner's Drawings", group: "equity", system: true },
  { id: "retained", code: "3200", name: "Retained Earnings", group: "equity", system: true },
  {
    id: "opening-equity",
    code: "3300",
    name: "Opening Balance Equity",
    group: "equity",
    system: true,
    note: "Where every opening figure lands — party balances, bank balances and opening stock carried in from before the app.",
  },

  // ── Income ────────────────────────────────────────────────────────────
  { id: "sales", code: "4000", name: "Sales", group: "income", system: true },
  {
    id: "freight-income",
    code: "4100",
    name: "Freight Charged",
    group: "income",
    system: true,
    note: "Shipping added to a sale bill.",
  },
  {
    id: "round-off",
    code: "4200",
    name: "Round-off",
    group: "income",
    system: true,
    note: "The paise dropped or added to reach a whole-rupee bill total. Small either way, and real.",
  },
  {
    id: "discount-received",
    code: "4300",
    name: "Discount Received",
    group: "income",
    system: true,
  },
  { id: "other-income", code: "4900", name: "Other Income", group: "income", system: true },

  // ── Expenses ──────────────────────────────────────────────────────────
  { id: "cogs", code: "5000", name: "Cost of Goods Sold", group: "expense", system: true },
  {
    id: "discount-allowed",
    code: "5100",
    name: "Discount Allowed",
    group: "expense",
    system: true,
    note: "Waived when settling a bill. The sale was booked at full value, so the waived part is a real cost.",
  },
  {
    id: "cash-short-over",
    code: "5200",
    name: "Cash Short/Over",
    group: "expense",
    system: true,
    note: "Counting differences and cash movements with no stated reason.",
  },
  {
    id: "stock-written-off",
    code: "5300",
    name: "Stock Written Off",
    group: "expense",
    system: true,
  },
];

/** The bank account's own ledger account. */
export const bankAccountId = (bankId: string) => `bank:${bankId}`;

/**
 * The ledger account for an expense category.
 *
 * Categories are free text the shop types, so "Shop Rent", "shop rent " and
 * "SHOP RENT" are the same expense to a human and would otherwise be three
 * accounts in the chart. Folded to a slug for the id; the first spelling seen
 * is kept for the name.
 */
export const expenseAccountId = (category: string) =>
  `expense:${(category || "Uncategorised").trim().toLowerCase().replace(/\s+/g, "-")}`;

const bankCode = (i: number) => String(1100 + Math.min(i, 48));
const expenseCode = (i: number) => String(5500 + Math.min(i, 480));

/**
 * The full chart for this shop: the fixed accounts plus one per bank account
 * and one per expense category actually used.
 *
 * Categories come from the expenses themselves rather than from a master
 * list, because the expense form lets a category be typed in — an account
 * built only from the master list would leave those postings pointing at an
 * account that is not in the chart.
 */
export function accountsFor(
  banks: { id: string; name: string }[],
  expenses: { category: string }[],
): Account[] {
  const list = [...SYSTEM_ACCOUNTS];

  banks.forEach((b, i) =>
    list.push({
      id: bankAccountId(b.id),
      code: bankCode(i),
      name: b.name || "Bank Account",
      group: "asset",
      system: false,
    }),
  );

  const seen = new Map<string, string>();
  for (const e of expenses) {
    const id = expenseAccountId(e.category);
    if (!seen.has(id)) seen.set(id, (e.category || "Uncategorised").trim() || "Uncategorised");
  }
  [...seen.entries()].forEach(([id, name], i) =>
    list.push({ id, code: expenseCode(i), name, group: "expense", system: false }),
  );

  return list;
}

/** Look-up by id, with a readable fallback so an unknown account can never
 *  render as a blank row — a posting rule pointing at an account that is not
 *  in the chart is a bug, and it should be visible as one. */
export function accountLabel(id: string, accounts: Account[]): string {
  const found = accounts.find((a) => a.id === id);
  if (found) return found.name;
  return `Unknown account (${id})`;
}

export function accountGroup(id: string, accounts: Account[]): AccountGroup {
  return accounts.find((a) => a.id === id)?.group ?? "asset";
}

export const GROUP_LABEL: Record<AccountGroup, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};

/** Balance-sheet groups first, then the P&L ones — the order a trial balance
 *  is always printed in. */
export const GROUP_ORDER: AccountGroup[] = ["asset", "liability", "equity", "income", "expense"];

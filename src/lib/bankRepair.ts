import { buildBankLedger, paidViaPayments } from "@/lib/ledger";
import type { Invoice, Payment, BankAccount, BankTxn, Expense } from "@/types";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The amount a bill actually moved on its bank account AT BILLING.
 *
 * This is the single definition the app must agree on. `invoice.paid` is NOT
 * it: once a Payment record is allocated to the bill, `paid` also contains
 * money that arrived by a different route (commonly cash) and already moved
 * under its own mode. Subtracting the payment-supplied part leaves the
 * "direct portion" — the same formula modeFlows() uses for cash.
 *
 * Kept here rather than inline in InvoiceForm so the save path, the repair
 * planner below and the audit harness can never drift apart. */
export function correctBankPaidAmount(inv: Invoice, payments: Payment[]): number | undefined {
  if (inv.paymentMode !== "bank" || !inv.bankId) return undefined;
  const viaPayments = paidViaPayments(payments).get(inv.id) ?? 0;
  return Math.max(0, r2((inv.paid || 0) - viaPayments));
}

export interface BillCorrection {
  id: string;
  kind: "sale" | "purchase";
  number: string;
  partyName: string;
  bankId: string;
  stored: number;
  correct: number;
}

export interface AccountCorrection {
  id: string;
  name: string;
  stored: number;
  correct: number;
  delta: number;
}

export interface BankRepairPlan {
  bills: BillCorrection[];
  accounts: AccountCorrection[];
  hasWork: boolean;
}

export interface BankRepairData {
  sales: Invoice[];
  purchases: Invoice[];
  payments: Payment[];
  banks: BankAccount[];
  bankTxns: BankTxn[];
  expenses: Expense[];
}

/**
 * Dry-run reconciliation of every bank account against the documents.
 *
 * Two independent things can be wrong, and the second depends on the first:
 *  1. A bill's stored `bankPaidAmount` snapshot (inflated by the edit bug —
 *     re-saving a part-bank-paid bill after a Payment landed on it credited
 *     the account with that payment's money too).
 *  2. An account's stored `balance`, which those inflated snapshots pushed up
 *     and which nothing recomputes, since it's only ever nudged by deltas.
 *
 * So bill snapshots are corrected FIRST, then each account's true balance is
 * re-derived from the corrected documents via buildBankLedger — the same
 * engine the passbook page already uses, which covers every way money reaches
 * an account (bills, payments, expenses, deposits/withdrawals, opening
 * balance). Pure and side-effect free: callers show this to the user and only
 * then decide to write.
 */
export function planBankRepair(data: BankRepairData): BankRepairPlan {
  const bills: BillCorrection[] = [];

  const scan = (list: Invoice[], kind: "sale" | "purchase") => {
    for (const inv of list) {
      const correct = correctBankPaidAmount(inv, data.payments);
      if (correct === undefined) continue;
      const stored = inv.bankPaidAmount ?? 0;
      // Tolerance of half a paisa — never rewrite a document over float dust.
      if (Math.abs(stored - correct) < 0.005) continue;
      bills.push({
        id: inv.id,
        kind,
        number: inv.number,
        partyName: inv.partyName,
        bankId: inv.bankId!,
        stored,
        correct,
      });
    }
  };
  scan(data.sales, "sale");
  scan(data.purchases, "purchase");

  // Re-derive balances from the CORRECTED bills, not the stored ones.
  const fixedById = new Map(bills.map((b) => [b.id, b.correct]));
  const withFixes = (list: Invoice[]) =>
    list.map((inv) =>
      fixedById.has(inv.id) ? { ...inv, bankPaidAmount: fixedById.get(inv.id) } : inv,
    );
  const correctedSales = withFixes(data.sales);
  const correctedPurchases = withFixes(data.purchases);

  const accounts: AccountCorrection[] = [];
  for (const bank of data.banks) {
    const correct = buildBankLedger(bank, {
      sales: correctedSales,
      purchases: correctedPurchases,
      payments: data.payments,
      bankTxns: data.bankTxns,
      expenses: data.expenses,
    }).fullBalance;
    const stored = bank.balance ?? bank.openingBalance ?? 0;
    const delta = r2(correct - stored);
    if (Math.abs(delta) < 0.005) continue;
    accounts.push({ id: bank.id, name: bank.name, stored, correct, delta });
  }

  return { bills, accounts, hasWork: bills.length > 0 || accounts.length > 0 };
}

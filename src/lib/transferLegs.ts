import type { BankTxn, CashAdjustment } from "@/types";

/**
 * The bank side(s) of a cash entry that is really one leg of a transfer.
 *
 * A transfer writes two records — one on each account — and they must be
 * edited and deleted as one thing. Newer ones carry a shared `transferId`, so
 * that is simply a lookup.
 *
 * Older ones do not, and they are the dangerous case: without recognising
 * them, the Cash page treats the cash side as an ordinary manual entry and
 * offers to EDIT it. Changing the amount there would move the cash and leave
 * the bank account saying something else — the books silently disagreeing
 * with themselves, which is worse than refusing the edit.
 *
 * They can still be recognised, because the transfer dialog wrote the SAME
 * note on both sides, on the same date, for the same amount — and the two
 * legs always point opposite ways: cash out pairs with money into a bank,
 * cash in with money out of one. All four have to agree before a record is
 * treated as a partner, and a partner has to actually be found: a manual
 * entry that merely happens to have "Transfer" in its note stays editable,
 * because there is nothing it could be out of step with.
 */
export function transferLegsFor(adj: CashAdjustment, bankTxns: BankTxn[]): BankTxn[] {
  if (adj.transferId) return bankTxns.filter((t) => t.transferId === adj.transferId);

  const note = (adj.reason ?? "").trim();
  if (!/^transfer\b/i.test(note)) return [];
  const wantBankSide = adj.type === "reduce" ? "deposit" : "withdraw";
  return bankTxns.filter(
    (t) =>
      (t.notes ?? "").trim() === note &&
      t.date === adj.date &&
      Math.abs(t.amount - adj.amount) < 0.005 &&
      t.type === wantBankSide,
  );
}

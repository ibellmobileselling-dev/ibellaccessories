/**
 * Why cash moved, when no bill or payment explains it.
 *
 * A cash entry reading "CASH ADD TILL TODAY FROM VYAPAR ₹29,000" is money from
 * nowhere. It is real money, so it lands in cash in hand — but nothing says
 * whether the shop earned it, the owner put it in, or it is an opening figure
 * carried over from the old system. The P&L then quietly absorbs it and the
 * profit for that month is wrong by ₹29,000, with nothing on any screen to
 * say so.
 *
 * Every accounting system answers this the same way: the movement has a second
 * side, and the second side is an account. This is that second side, named in
 * the words a shopkeeper uses rather than in the words a ledger uses — the
 * mapping to real accounts arrives with the posting ledger (see
 * docs/ERP-PLAN.md §4.4), and `account` below is where each one will land, so
 * the two cannot drift apart in the meantime.
 */
export type CashPurpose =
  | "opening"
  | "owner-in"
  | "owner-out"
  | "short-over"
  | "transfer"
  | "other";

export interface CashPurposeSpec {
  key: CashPurpose;
  /** What the shopkeeper picks. */
  label: string;
  /** One line of why they would pick it. */
  hint: string;
  /**
   * The direction this purpose implies, if it only makes sense one way.
   * Picking "owner took out" and then having to say "cash out" separately is
   * asking the same question twice — so the purpose sets the direction, and
   * the two-way ones leave it alone.
   */
  direction?: "add" | "reduce";
  /** The account this will post against once there is a ledger. */
  account: string;
  /** Set by the app, never offered in the picker. */
  automatic?: boolean;
}

export const CASH_PURPOSES: CashPurposeSpec[] = [
  {
    key: "opening",
    label: "Opening balance",
    hint: "Cash the shop already had when it started using this app",
    direction: "add",
    account: "Opening Balance Equity",
  },
  {
    key: "owner-in",
    label: "Owner put in",
    hint: "Money the owner brought into the business",
    direction: "add",
    account: "Owner's Capital",
  },
  {
    key: "owner-out",
    label: "Owner took out",
    hint: "Money the owner took for personal use",
    direction: "reduce",
    account: "Owner's Drawings",
  },
  {
    key: "short-over",
    label: "Counting difference",
    hint: "The drawer counted more or less than the books say",
    account: "Cash Short/Over",
  },
  {
    key: "other",
    label: "Something else",
    hint: "Anything the choices above do not cover — say what in the note",
    account: "Cash Short/Over",
  },
  {
    key: "transfer",
    label: "Transfer",
    hint: "One leg of a move between cash and a bank account",
    account: "(the other account)",
    automatic: true,
  },
];

/** The ones a person may choose. `transfer` is written by the transfer screen
 *  and would be a lie coming from anywhere else. */
export const CHOOSABLE_PURPOSES = CASH_PURPOSES.filter((p) => !p.automatic);

export function purposeSpec(key: string | undefined): CashPurposeSpec | undefined {
  return CASH_PURPOSES.find((p) => p.key === key);
}

/** What to show on a row. Entries made before purposes existed say so plainly
 *  rather than being guessed at — a wrong reason is worse than a missing one. */
export function purposeLabel(key: string | undefined): string {
  return purposeSpec(key)?.label ?? "Uncategorised";
}

/** Totals per purpose over a set of entries, for the summary on the Cash page.
 *  Signed: money in is positive, money out negative, so the figures read the
 *  way the drawer moved. */
export function totalsByPurpose(
  entries: { purpose?: string; type: "add" | "reduce"; amount: number }[],
): { key: string; label: string; net: number; count: number }[] {
  const acc = new Map<string, { net: number; count: number }>();
  for (const e of entries) {
    const key = e.purpose ?? "uncategorised";
    const cur = acc.get(key) ?? { net: 0, count: 0 };
    cur.net = Math.round((cur.net + (e.type === "add" ? e.amount : -e.amount)) * 100) / 100;
    cur.count += 1;
    acc.set(key, cur);
  }
  return [...acc.entries()]
    .map(([key, v]) => ({
      key,
      label: purposeLabel(key === "uncategorised" ? undefined : key),
      ...v,
    }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
}

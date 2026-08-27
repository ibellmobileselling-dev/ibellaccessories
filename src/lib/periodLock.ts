/**
 * A date before which the books do not change any more.
 *
 * Once GSTR-1 and 3B are filed for a month, that month is a statement made to
 * the tax authority. If a bill inside it can still be edited — or deleted —
 * the books stop matching the filed return, and nobody finds out until a
 * notice arrives. This is the one lock in the app that exists for an outside
 * party rather than for the shop's own convenience.
 *
 * Deliberately a plain predicate with no UI in it, so the rule can be tested
 * on its own and so the same rule answers for a save, an edit and a delete
 * rather than three near-copies drifting apart.
 */

/** Is `date` inside a closed period? Dates are ISO `yyyy-mm-dd`, which sort
 *  lexically, so a string compare is the whole comparison. */
export function isLocked(date: string | undefined, lockedUpto: string | undefined): boolean {
  if (!lockedUpto || !date) return false;
  return date <= lockedUpto;
}

/**
 * Whether a change is allowed, given every date it touches.
 *
 * An EDIT has two dates that matter: where the record is now, and where it is
 * being moved to. Checking only the new one would let a bill be dragged out of
 * a closed month — which changes that month's totals just as surely as editing
 * it in place. Checking only the old one would let a new bill be posted into a
 * closed month. Both, always.
 */
export function blockedDate(
  dates: (string | undefined)[],
  lockedUpto: string | undefined,
): string | null {
  for (const d of dates) if (isLocked(d, lockedUpto)) return d ?? null;
  return null;
}

/** Human wording for the refusal, in the terms the shopkeeper thinks in. */
export function lockMessage(date: string, lockedUpto: string): string {
  return `${date} is in a closed period — the books are locked up to ${lockedUpto}. Unlock them in Settings if this really needs to change.`;
}

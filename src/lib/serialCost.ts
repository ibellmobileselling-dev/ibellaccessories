/**
 * What a line of goods actually cost, when the units are known individually.
 *
 * An ordinary item can only be costed on an average or a snapshot: twelve
 * identical cables came in at three different prices and nobody can say which
 * one went out. A serial-tracked item has no such excuse — the unit that left
 * is named on the bill, and what THAT unit cost was stamped on it the day it
 * arrived. Using an average there throws away an exact answer the shop
 * already has, and gets the profit on every adapter slightly wrong in a way
 * that never nets out.
 *
 * Pure, and importing nothing but types, because both the posting ledger and
 * the older P&L have to call it. Those two are cross-checked against each
 * other by Reports → Ledger Reconciliation, so a change of basis in one and
 * not the other would not be a rounding difference — it would be a permanent
 * gap the size of the shop's whole serial-tracked margin.
 */

import type { Serial } from "@/types";

/** Units that carry a real recorded cost. A unit with none is not a unit
 *  costing zero — it is a unit we cannot cost, which is a different thing and
 *  handled by the caller below. */
export function serialCostIndex(serials: Serial[] | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of serials ?? []) {
    if (typeof s.cost === "number" && Number.isFinite(s.cost)) out.set(s.id, s.cost);
  }
  return out;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface LineCostBasis {
  amount: number;
  /** True when every unit on the line was costed from its own record. */
  exact: boolean;
}

/**
 * One basis per line, never a mixture.
 *
 * If a line names units and EVERY one of them has a recorded cost, the line
 * costs the sum of those. If even one is missing — a unit received before
 * costs were stamped, or adopted from the old system — the whole line falls
 * back to the snapshot. Half-exact would produce a figure that is neither,
 * and nobody could later say which lines it applied to.
 */
export function lineCostBasis(
  line: { itemId: string; qty: number; costPrice?: number; serialIds?: string[] },
  serialCosts: Map<string, number>,
  fallbackUnitCost: (itemId: string) => number,
): LineCostBasis {
  const ids = line.serialIds ?? [];
  if (ids.length) {
    let total = 0;
    let all = true;
    for (const id of ids) {
      const c = serialCosts.get(id);
      if (c === undefined) {
        all = false;
        break;
      }
      total += c;
    }
    if (all) return { amount: r2(total), exact: true };
  }
  const snapshot = line.costPrice ?? fallbackUnitCost(line.itemId) ?? 0;
  return { amount: r2(snapshot * (line.qty || 0)), exact: false };
}

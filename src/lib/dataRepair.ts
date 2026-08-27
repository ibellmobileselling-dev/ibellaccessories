import { planBankRepair, type BankRepairData, type BankRepairPlan } from "@/lib/bankRepair";
import type { Invoice, Item, Return, StockAdjustment } from "@/types";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Coerce a stored figure that TypeScript believes is a number but Firestore
 * may be holding as a string ("5") or not at all. Everything below does
 * arithmetic on these, and `+` on a string concatenates. */
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface StockCorrection {
  id: string;
  name: string;
  stored: number;
  correct: number;
  delta: number;
  unit: string;
}

/**
 * Recompute every item's stock from the documents that moved it.
 *
 * `Item.stock` is one of only two running totals this app keeps (the other
 * is a bank balance) — everything else is derived at render time and cannot
 * go stale. A running total CAN go stale: a bill that failed to commit
 * halfway, an edit whose reversal didn't land, an older build's bug. This
 * rebuilds the number from first principles:
 *
 *   opening + purchases + sale returns − sales − purchase returns ± adjustments
 *
 * which is the same arithmetic every write path performs incrementally.
 * Anything that disagrees is drift.
 */
export function planStockRepair(data: {
  items: Item[];
  sales: Invoice[];
  purchases: Invoice[];
  saleReturns: Return[];
  purchaseReturns: Return[];
  stockAdjustments: StockAdjustment[];
}): StockCorrection[] {
  const movement = new Map<string, number>();
  const add = (itemId: string, qty: number) =>
    movement.set(itemId, (movement.get(itemId) ?? 0) + qty);

  for (const s of data.sales) for (const l of s.lineItems) add(l.itemId, -num(l.qty));
  for (const p of data.purchases) for (const l of p.lineItems) add(l.itemId, num(l.qty));
  // A sale return brings goods back in; a purchase return sends them out.
  for (const r of data.saleReturns) for (const l of r.lineItems) add(l.itemId, num(l.qty));
  for (const r of data.purchaseReturns) for (const l of r.lineItems) add(l.itemId, -num(l.qty));
  for (const a of data.stockAdjustments) {
    add(a.itemId, a.type === "add" ? num(a.qty) : -num(a.qty));
  }

  const out: StockCorrection[] = [];
  for (const it of data.items) {
    const correct = r2(num(it.openingStock) + (movement.get(it.id) ?? 0));
    // A stock that is not actually a NUMBER always needs rebuilding, even when
    // it reads as the right figure. Firestore will happily hold "5", every
    // screen renders it fine, and then the first atomic adjustment concatenates
    // instead of adding — see Repository.adjustBase. Repairing it rewrites the
    // field as a real number, so include it whatever the arithmetic says.
    const malformed = typeof it.stock !== "number" || !Number.isFinite(it.stock);
    const stored = r2(num(it.stock));
    const delta = r2(correct - stored);
    // Half a unit of float dust is not drift.
    if (!malformed && Math.abs(delta) < 0.005) continue;
    out.push({ id: it.id, name: it.name, stored, correct, delta, unit: it.unit });
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

export interface DataRepairPlan extends BankRepairPlan {
  items: StockCorrection[];
}

export interface DataRepairData extends BankRepairData {
  items: Item[];
  saleReturns: Return[];
  purchaseReturns: Return[];
  stockAdjustments: StockAdjustment[];
}

/**
 * Everything this app stores as a running total, checked against the
 * documents behind it — bank balances, the bank portion recorded on a bill,
 * and item stock.
 *
 * This is deliberately the ONLY kind of thing a "fix calculations" button
 * can honestly repair. Party opening balances are NOT included: which side
 * an opening belongs on is a statement of intent, not arithmetic, so no
 * amount of recomputation can tell whether a number was meant as
 * receivable or payable. Balances, ledgers, statements, P&L and GST are all
 * derived at render time and self-heal the moment the underlying documents
 * are right — there is nothing stored for them to repair.
 */
export function planDataRepair(data: DataRepairData): DataRepairPlan {
  const bank = planBankRepair(data);
  const items = planStockRepair({
    items: data.items,
    sales: data.sales,
    purchases: data.purchases,
    saleReturns: data.saleReturns,
    purchaseReturns: data.purchaseReturns,
    stockAdjustments: data.stockAdjustments,
  });
  return {
    ...bank,
    items,
    hasWork: bank.hasWork || items.length > 0,
  };
}

import { ItemRepo } from "@/repositories";
import type { LineItem } from "@/types";

/**
 * Aggregates quantity needed per item across `lines` and checks it against
 * current stock. `reverseLines` (an existing sale/bill's original line
 * items, when editing) are added back first, since that qty is about to be
 * un-deducted in the same save. Returns one readable message per item that
 * would go negative — empty when nothing would.
 */
export function stockShortfalls(lines: LineItem[], reverseLines: LineItem[] = []): string[] {
  const needed = new Map<string, number>();
  for (const l of lines) needed.set(l.itemId, (needed.get(l.itemId) ?? 0) + l.qty);
  const reversed = new Map<string, number>();
  for (const l of reverseLines) reversed.set(l.itemId, (reversed.get(l.itemId) ?? 0) + l.qty);

  const out: string[] = [];
  for (const [itemId, qty] of needed) {
    const it = ItemRepo.get(itemId);
    if (!it) continue;
    const available = it.stock + (reversed.get(itemId) ?? 0);
    if (available - qty < 0) {
      out.push(`${it.name} (have ${available} ${it.unit}, need ${qty})`);
    }
  }
  return out;
}

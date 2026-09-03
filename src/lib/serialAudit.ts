/**
 * Does the unit list still agree with the documents?
 *
 * Every other check in this app rebuilds a number from the documents that
 * caused it. This one cannot: a serial's status is not derived, it is moved,
 * one document at a time. If a move is ever missed — a partial write, a bug
 * in a path nobody exercised, a record edited by hand in the console — the
 * unit and the paperwork start disagreeing and nothing else notices. The
 * shelf count comes from the units, so the shop keeps trading on a figure
 * that has quietly stopped being true.
 *
 * So this reports rather than repairs. Every finding here has two possible
 * fixes — move the unit, or correct the document — and which one is right
 * depends on what physically happened in the shop. Guessing would turn a
 * visible disagreement into an invisible wrong answer, which is worse.
 */

import type { Invoice, Item, Return, Serial } from "@/types";
import { normaliseSerial } from "@/lib/serials";

export type SerialIssueKind =
  | "sold-but-no-bill"
  | "in-stock-but-still-sold"
  | "returned-but-no-note"
  | "on-two-bills"
  | "line-count-mismatch"
  | "unknown-item"
  | "duplicate-serial";

export interface SerialIssue {
  kind: SerialIssueKind;
  /** Written to be read by the shop, not by a developer. */
  message: string;
  serial?: string;
  itemName?: string;
}

export interface SerialAuditResult {
  issues: SerialIssue[];
  /** Units checked — so a clean result says how much it covered. */
  checked: number;
  /**
   * Lines on serial-tracked items that carry no units at all.
   *
   * NOT an error. Items are opt-in, so every bill written before an item was
   * switched on legitimately has none, and there is no way to invent them
   * afterwards. Reported as a figure because it is the honest answer to "is
   * my unit history complete" — which is a fair question and a different one
   * from "is my unit history wrong".
   */
  untrackedLines: number;
}

interface Holder {
  kind: "sale" | "purchase" | "sale-return" | "purchase-return";
  number: string;
}

/**
 * Every document is passed in, live ones only — the caller decides that by
 * using all() rather than allWithVoided(). A cancelled bill has stopped
 * counting, so a unit it names is not evidence of anything.
 */
export function checkSerialIntegrity(data: {
  serials: Serial[];
  items: Item[];
  sales: Invoice[];
  purchases: Invoice[];
  saleReturns: Return[];
  purchaseReturns: Return[];
}): SerialAuditResult {
  const itemById = new Map(data.items.map((i) => [i.id, i]));
  const holders = new Map<string, Holder[]>();
  const issues: SerialIssue[] = [];
  let untrackedLines = 0;

  const walk = (
    docs: { number: string; lineItems: { itemId: string; qty: number; serialIds?: string[] }[] }[],
    kind: Holder["kind"],
  ) => {
    for (const doc of docs) {
      for (const l of doc.lineItems) {
        if (!itemById.get(l.itemId)?.trackSerials) continue;
        const ids = l.serialIds ?? [];
        if (!ids.length) {
          untrackedLines++;
          continue;
        }
        // A line that names SOME of its units is the broken one. Naming none
        // is the legacy case above; naming all is correct.
        if (ids.length !== l.qty) {
          issues.push({
            kind: "line-count-mismatch",
            itemName: itemById.get(l.itemId)?.name,
            message: `${doc.number} lists ${l.qty} × ${itemById.get(l.itemId)?.name ?? "item"} but names ${ids.length} unit${ids.length === 1 ? "" : "s"}`,
          });
        }
        for (const id of ids) {
          const list = holders.get(id) ?? [];
          list.push({ kind, number: doc.number });
          holders.set(id, list);
        }
      }
    }
  };

  walk(data.sales, "sale");
  walk(data.purchases, "purchase");
  walk(data.saleReturns, "sale-return");
  walk(data.purchaseReturns, "purchase-return");

  // Uniqueness is per item, not global: two makers can legitimately stamp the
  // same string, so the key is the pair.
  const seen = new Map<string, string>();

  for (const s of data.serials) {
    const item = itemById.get(s.itemId);
    if (!item) {
      issues.push({
        kind: "unknown-item",
        serial: s.serial,
        message: `${s.serial} belongs to an item that no longer exists`,
      });
      continue;
    }

    // Delimited, not concatenated: item "AB" with serial "1" must not key the
    // same as item "A" with serial "B1". A newline cannot occur in either.
    const key = `${s.itemId}\n${normaliseSerial(s.serial)}`;
    const twin = seen.get(key);
    if (twin) {
      issues.push({
        kind: "duplicate-serial",
        serial: s.serial,
        itemName: item.name,
        message: `${item.name} has two units both numbered ${s.serial} — one of them is a mis-scan`,
      });
    } else {
      seen.set(key, s.id);
    }

    const on = holders.get(s.id) ?? [];
    const sales = on.filter((h) => h.kind === "sale");
    const saleReturns = on.filter((h) => h.kind === "sale-return");
    const purchaseReturns = on.filter((h) => h.kind === "purchase-return");

    if (sales.length > 1) {
      issues.push({
        kind: "on-two-bills",
        serial: s.serial,
        itemName: item.name,
        message: `${s.serial} is sold on ${sales.length} bills at once — ${sales.map((h) => h.number).join(", ")}`,
      });
    }

    if (s.status === "sold" && !sales.length) {
      issues.push({
        kind: "sold-but-no-bill",
        serial: s.serial,
        itemName: item.name,
        message: `${s.serial} says it is with a customer, but no live bill sold it — the shelf count is one short`,
      });
    }

    // Sold and then returned is the normal way to be back in stock, so a
    // sale return excuses the sale that is still named on the unit.
    if (s.status === "in_stock" && sales.length && !saleReturns.length) {
      issues.push({
        kind: "in-stock-but-still-sold",
        serial: s.serial,
        itemName: item.name,
        message: `${s.serial} is counted as on the shelf, but ${sales[0].number} sold it and was never cancelled or returned — the shelf count is one over`,
      });
    }

    if (s.status === "returned_to_vendor" && !purchaseReturns.length) {
      issues.push({
        kind: "returned-but-no-note",
        serial: s.serial,
        itemName: item.name,
        message: `${s.serial} says it went back to the vendor, but no live debit note sent it`,
      });
    }
  }

  return { issues, checked: data.serials.length, untrackedLines };
}

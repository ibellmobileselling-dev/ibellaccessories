/**
 * What saving a bill does to the individual units on it.
 *
 * Worked out as a plan first and applied second, for the same reason
 * planStockRepair and planYearClose are: these writes are not reversible by
 * looking at them afterwards, and a function that decides and writes in one
 * pass can only be tested by writing.
 *
 * The state machine, in full — only a document moves a serial, and nothing
 * edits `status` directly:
 *
 *     (new) ──purchase──► in_stock ──sale──► sold
 *                            ▲  │              │
 *          purchase return   │  │ damage       │ sale return
 *                            │  ▼              │
 *               returned_to_vendor  damaged    │
 *                            ▲                 │
 *                            └─────────────────┘
 */

import type { Invoice, Item, Return, Serial } from "@/types";
import { warrantyEnd, isDraftSerial, draftSerialText } from "@/lib/serials";

/** A serial to bring into existence, because a purchase received it. */
export interface SerialCreate {
  /** The draft id it had on the form, so the saved line can be rewritten to
   *  point at the real record. */
  draftId: string;
  serial: string;
  itemId: string;
}

/** A change to a serial that already exists. */
export interface SerialUpdate {
  id: string;
  patch: Partial<Serial>;
}

export interface SerialPlan {
  create: SerialCreate[];
  update: SerialUpdate[];
  /** Units that were on the bill before this save and are not on it now. */
  release: SerialUpdate[];
}

const emptyPlan = (): SerialPlan => ({ create: [], update: [], release: [] });

/**
 * Everything a purchase does to its units.
 *
 * Receiving stamps where the unit came from — vendor, date, and what THIS one
 * cost. That last field is why profit becomes exact rather than averaged, and
 * it is also the shop's evidence when claiming a faulty unit back.
 */
export function planPurchaseSerials(
  inv: Invoice,
  previous: Invoice | null | undefined,
  itemOf: (id: string) => Item | undefined,
): SerialPlan {
  const plan = emptyPlan();
  const nowOn = new Set<string>();

  for (const l of inv.lineItems) {
    const item = itemOf(l.itemId);
    if (!item?.trackSerials) continue;
    const costEach = l.qty > 0 ? Math.round((l.price || 0) * 100) / 100 : 0;

    for (const id of l.serialIds ?? []) {
      nowOn.add(id);
      const stamp: Partial<Serial> = {
        status: "in_stock",
        purchaseId: inv.id,
        purchaseDate: inv.date,
        vendorId: inv.partyId,
        vendorName: inv.partyName,
        cost: costEach,
        vendorWarrantyEnd: warrantyEnd(inv.date, item.vendorWarrantyMonths),
      };
      if (isDraftSerial(id)) {
        plan.create.push({ draftId: id, serial: draftSerialText(id), itemId: l.itemId });
      } else {
        // An existing record still on the bill: restamp it, because the date,
        // the vendor or the price may all have been corrected on this edit.
        plan.update.push({ id, patch: stamp });
      }
    }
  }

  /* Units that were received on this bill and have been taken off it. They
     never arrived, so they stop existing as stock — but only if nobody has
     sold them in the meantime. The caller refuses the save in that case; this
     just reports what would move. */
  for (const l of previous?.lineItems ?? []) {
    for (const id of l.serialIds ?? []) {
      if (nowOn.has(id) || isDraftSerial(id)) continue;
      plan.release.push({ id, patch: { voidedAt: new Date().toISOString() } as Partial<Serial> });
    }
  }
  return plan;
}

/**
 * Everything a sale does to its units.
 *
 * The warranty months are copied onto the serial HERE, at the moment of sale,
 * and never read from the item again. Changing an item's policy tomorrow must
 * not rewrite a promise already made to a customer holding a bill.
 */
export function planSaleSerials(
  inv: Invoice,
  previous: Invoice | null | undefined,
  itemOf: (id: string) => Item | undefined,
): SerialPlan {
  const plan = emptyPlan();
  const nowOn = new Set<string>();

  for (const l of inv.lineItems) {
    const item = itemOf(l.itemId);
    if (!item?.trackSerials) continue;
    for (const id of l.serialIds ?? []) {
      nowOn.add(id);
      plan.update.push({
        id,
        patch: {
          status: "sold",
          saleId: inv.id,
          saleDate: inv.date,
          customerId: inv.partyId,
          customerName: inv.partyName,
          warrantyMonths: item.warrantyMonths,
          warrantyEnd: warrantyEnd(inv.date, item.warrantyMonths),
        },
      });
    }
  }

  // Taken off the bill on an edit: back on the shelf, and the customer's
  // details cleared — they never had it.
  for (const l of previous?.lineItems ?? []) {
    for (const id of l.serialIds ?? []) {
      if (nowOn.has(id)) continue;
      plan.release.push({ id, patch: releaseToStock() });
    }
  }
  return plan;
}

/**
 * Everything a sale return does to its units.
 *
 * Note what it does NOT do: erase the sale. The unit really was sold to that
 * customer on that day and really did come back, and both halves are the
 * record. Readers decide what to SHOW from the status — a unit that is not
 * sold has no warranty running and no current holder, which is exactly what
 * warrantyState answers and what the screens print. Erasing instead would
 * make undoing this return impossible to get right, because nothing left on
 * the unit would say which sale to put back.
 */
export function planSaleReturnSerials(
  ret: Return,
  previous: Return | null | undefined,
  itemOf: (id: string) => Item | undefined,
): SerialPlan {
  const plan = emptyPlan();
  const nowOn = new Set<string>();
  // A warranty failure is the commonest return there is, and putting that
  // unit back on the sellable shelf hands it to the next customer.
  const back: Serial["status"] = ret.unitsDamaged ? "damaged" : "in_stock";

  for (const l of ret.lineItems) {
    if (!itemOf(l.itemId)?.trackSerials) continue;
    for (const id of l.serialIds ?? []) {
      nowOn.add(id);
      plan.update.push({ id, patch: { status: back, returnId: ret.id, returnDate: ret.date } });
    }
  }

  // Taken off the note on an edit: it did not come back after all, so it is
  // with the customer again.
  for (const l of previous?.lineItems ?? []) {
    for (const id of l.serialIds ?? []) {
      if (nowOn.has(id)) continue;
      plan.release.push({ id, patch: backWithCustomer() });
    }
  }
  return plan;
}

/**
 * Everything a purchase return does to its units.
 *
 * These leave the shop for good, which is why they stop counting as stock
 * without being deleted: the shop still needs to be able to say where a unit
 * went when the vendor asks about it.
 */
export function planPurchaseReturnSerials(
  ret: Return,
  previous: Return | null | undefined,
  itemOf: (id: string) => Item | undefined,
): SerialPlan {
  const plan = emptyPlan();
  const nowOn = new Set<string>();

  for (const l of ret.lineItems) {
    if (!itemOf(l.itemId)?.trackSerials) continue;
    for (const id of l.serialIds ?? []) {
      nowOn.add(id);
      plan.update.push({
        id,
        patch: { status: "returned_to_vendor", returnId: ret.id, returnDate: ret.date },
      });
    }
  }

  for (const l of previous?.lineItems ?? []) {
    for (const id of l.serialIds ?? []) {
      if (nowOn.has(id)) continue;
      plan.release.push({ id, patch: backOnShelf() });
    }
  }
  return plan;
}

/** Undoing a sale return: the unit is with the customer again, and the note
 *  that said otherwise is forgotten. The key must be PRESENT and undefined —
 *  a key merely absent leaves the stored value where it was. */
export function backWithCustomer(): Partial<Serial> {
  return { status: "sold", returnId: undefined, returnDate: undefined };
}

/** Undoing a purchase return: it was never sent back to the vendor. */
export function backOnShelf(): Partial<Serial> {
  return { status: "in_stock", returnId: undefined, returnDate: undefined };
}

/**
 * Put a unit back on the shelf, forgetting who had it.
 *
 * Written once and shared by the sale edit path and the sale void path,
 * because "this customer never had it" has to mean the same thing in both.
 *
 * Sale RETURNS deliberately do not use this: there the customer did have the
 * unit, and erasing that would lose the trail and make the return impossible
 * to undo. See planSaleReturnSerials.
 */
export function releaseToStock(): Partial<Serial> {
  return {
    status: "in_stock",
    saleId: undefined,
    saleDate: undefined,
    customerId: undefined,
    customerName: undefined,
    warrantyMonths: undefined,
    warrantyEnd: undefined,
  };
}

/**
 * What removing a document does to the units on it.
 *
 * Deleting and voiding need exactly the same serial movements — the document
 * stops counting either way — so they share one answer. Two copies would
 * drift, and the drift would be silent until a shelf count went wrong.
 */
export function undoSerialsOf(
  inv: { lineItems: { itemId: string; serialIds?: string[] }[] },
  kind: "sale" | "purchase" | "sale-return" | "purchase-return",
  itemOf: (id: string) => Item | undefined,
): SerialUpdate[] {
  const out: SerialUpdate[] = [];
  for (const l of inv.lineItems) {
    if (!itemOf(l.itemId)?.trackSerials) continue;
    for (const id of l.serialIds ?? []) {
      switch (kind) {
        case "sale":
          // The customer never had it: back on the shelf, and forgotten.
          out.push({ id, patch: releaseToStock() });
          break;
        case "purchase":
          // It never arrived. Marked rather than deleted, like every other
          // cancellation here — and refused outright by the caller if it has
          // since been sold.
          out.push({ id, patch: { voidedAt: new Date().toISOString() } as Partial<Serial> });
          break;
        case "sale-return":
          // The unit did NOT come back after all, so it is with the customer
          // again — and every sale field is still on the record, because the
          // return never erased them.
          out.push({ id, patch: backWithCustomer() });
          break;
        case "purchase-return":
          // It was not sent back to the vendor after all.
          out.push({ id, patch: backOnShelf() });
          break;
      }
    }
  }
  return out;
}

/**
 * Units received on a purchase that have since been sold.
 *
 * A purchase cannot be removed or edited out from under them: the unit is in
 * a customer's hands, and the shop's record of where it came from is the only
 * thing that lets them claim it back from the vendor.
 */
export function soldSerialsOf(inv: Invoice, serials: Serial[], onlyIds?: Set<string>): Serial[] {
  const ids = new Set(inv.lineItems.flatMap((l) => l.serialIds ?? []));
  return serials.filter(
    (s) => ids.has(s.id) && s.status === "sold" && (!onlyIds || onlyIds.has(s.id)),
  );
}

/**
 * Individual physical units of an item, tracked by their serial number.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ONE ITEM, MANY SERIALS
 * ───────────────────────────────────────────────────────────────────────────
 * The shop buys adapters by the box and sells them one at a time, and every
 * unit carries a serial the customer's warranty is written against. The
 * tempting shape — one catalogue item per adapter — is the wrong one, and the
 * reason is worth keeping next to the code rather than only in the plan:
 * every item's stock would be 1 or 0, so a reorder level would mean nothing,
 * and the shop could never again be told it is running low.
 *
 * So: one item, and a Serial record per physical unit under it.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ───────────────────────────────────────────────────────────────────────────
 * For a serialised item, stock is NOT the stored `item.stock` number. It is
 * the count of serials on hand:
 *
 *     stock = COUNT(serials WHERE itemId = X AND status = "in_stock")
 *
 * `item.stock` is one of only two stored running totals in this application,
 * and lib/dataRepair.ts exists because it drifts. For serialised items that
 * whole class of bug disappears, because there is only one source and nothing
 * for it to disagree with.
 *
 * Ten files read `item.stock`. They all go through `stockOf()` rather than
 * each remembering the rule — the same lesson Repository.all() taught when
 * voiding arrived: filtering at the source made 216 call sites correct at
 * once, and "remember to check" is not a mechanism.
 */

import type { Item, Serial } from "@/types";
import { SerialRepo } from "@/repositories";

/** Whether this item's stock is counted in serials rather than stored. */
export const isSerialised = (item: { trackSerials?: boolean } | undefined | null): boolean =>
  !!item?.trackSerials;

/**
 * itemId → how many of its serials are on the shelf.
 *
 * Built once and passed down by any screen that renders a list. Without it a
 * list of 2,000 items would scan every serial 2,000 times; with it the whole
 * page costs one pass.
 */
export function inStockCounts(serials: Serial[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of serials) {
    if (s.status !== "in_stock") continue;
    counts.set(s.itemId, (counts.get(s.itemId) ?? 0) + 1);
  }
  return counts;
}

/**
 * What this item's stock actually is.
 *
 * Pass `counts` when rendering a list (see `inStockCounts`); leave it off for
 * a single item and it reads the repository directly.
 *
 * A serialised item with no serials is 0 — not `item.stock`. Falling back to
 * the stored number would be the worst of both: a figure nothing maintains,
 * shown as though something did.
 */
export function stockOf(item: Item, counts?: Map<string, number>): number {
  if (!isSerialised(item)) return Number(item.stock) || 0;
  if (counts) return counts.get(item.id) ?? 0;
  return SerialRepo.all().filter((s) => s.itemId === item.id && s.status === "in_stock").length;
}

/** Every serial of one item, newest first. */
export function serialsOf(itemId: string, serials?: Serial[]): Serial[] {
  const all = serials ?? SerialRepo.all();
  return all
    .filter((s) => s.itemId === itemId)
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/**
 * Find a serial by the string printed on the unit.
 *
 * Scoped to the item, because uniqueness is per item and not global: two
 * manufacturers can legitimately stamp the same string, and a global rule
 * would refuse a genuine unit with no way to explain why. Matching ignores
 * case and surrounding space — a scanner sometimes adds one, and "f2lx9k3"
 * and "F2LX9K3 " are the same adapter to everyone except a string compare.
 */
export const normaliseSerial = (s: string) => (s ?? "").trim().toUpperCase();

export function findSerial(itemId: string, serial: string, serials?: Serial[]): Serial | undefined {
  const want = normaliseSerial(serial);
  if (!want) return undefined;
  return (serials ?? SerialRepo.all()).find(
    (s) => s.itemId === itemId && normaliseSerial(s.serial) === want,
  );
}

export const SERIAL_STATUS_LABEL: Record<Serial["status"], string> = {
  in_stock: "In stock",
  sold: "Sold",
  returned_to_vendor: "Returned to vendor",
  damaged: "Damaged",
};

/**
 * When a warranty given on `soldOn` runs out.
 *
 * Months are copied onto the serial at the moment of sale rather than read
 * from the item later: changing an item's warranty policy must not silently
 * rewrite a promise already made to a customer who is holding a bill.
 */
export function warrantyEnd(soldOn: string, months: number | undefined): string | undefined {
  if (!soldOn || !months || months <= 0) return undefined;
  const [y, m, d] = soldOn.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  // Day-of-month clamped by construction: 31 Jan + 1 month is 28/29 Feb, not
  // 2 or 3 March, which is what a naive setMonth would give and what a
  // customer would rightly argue about.
  const target = new Date(y, m - 1 + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d, lastDay));
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${target.getFullYear()}-${p2(target.getMonth() + 1)}-${p2(target.getDate())}`;
}

/** Days left on a warranty; negative once it has run out. */
export function warrantyDaysLeft(end: string | undefined, today: string): number | undefined {
  if (!end) return undefined;
  const a = new Date(end).getTime();
  const b = new Date(today).getTime();
  if (isNaN(a) || isNaN(b)) return undefined;
  return Math.round((a - b) / 86400000);
}

/**
 * Find a unit by what is printed on it, without being told which item it is.
 *
 * This is the counter's question, not the accountant's: someone is holding an
 * adapter and wants to know whether the shop still owes them a warranty on
 * it. They do not know the item id, and half the time they are reading the
 * last few characters down a phone line rather than scanning the whole thing.
 *
 * So: exact matches first, and only if there are none, units whose serial
 * ENDS WITH what was typed. Ends-with rather than contains, because serial
 * numbers are read out from the end — and because a two-character "contains"
 * search would return the whole shelf and be worse than no answer. Partial
 * matches are capped and reported as partial, so nobody mistakes "one of
 * forty units ending 9K3" for "the unit".
 *
 * Voided units are excluded by all(): a purchase that never happened cannot
 * be carrying a warranty.
 */
export interface SerialMatches {
  /** What was searched for, normalised. */
  query: string;
  hits: Serial[];
  /** True when nothing matched exactly and these are ends-with guesses. */
  partial: boolean;
  /** More existed than are listed — the search was too loose to be useful. */
  truncated: boolean;
}

export const SERIAL_MATCH_LIMIT = 25;
/** Below this, an ends-with search matches too much to mean anything. */
export const SERIAL_PARTIAL_MIN = 3;

export function lookupSerials(query: string, serials?: Serial[]): SerialMatches {
  const want = normaliseSerial(query);
  const all = serials ?? SerialRepo.all();
  const empty = { query: want, hits: [] as Serial[], partial: false, truncated: false };
  if (!want) return empty;

  const exact = all.filter((s) => normaliseSerial(s.serial) === want);
  // An exact hit on more than one item is not an error to hide: two makers
  // stamping the same string is legitimate, and the counter needs to see both
  // rather than be handed whichever the array happened to hold first.
  if (exact.length) return { query: want, hits: exact, partial: false, truncated: false };

  if (want.length < SERIAL_PARTIAL_MIN) return empty;
  const ends = all.filter((s) => normaliseSerial(s.serial).endsWith(want));
  return {
    query: want,
    hits: ends.slice(0, SERIAL_MATCH_LIMIT),
    partial: ends.length > 0,
    truncated: ends.length > SERIAL_MATCH_LIMIT,
  };
}

/**
 * The answer to "is this still under warranty?", in the form the counter
 * needs to say it out loud.
 *
 * Deliberately distinguishes "no warranty was given" from "the warranty has
 * run out". They lead to different conversations, and collapsing them into a
 * single "not covered" is how a shop ends up refusing a repair it had in fact
 * promised.
 */
export type WarrantyTone = "none" | "ok" | "expiring" | "expired";

export interface WarrantyState {
  tone: WarrantyTone;
  /** Plain words, ready to be read to a customer. */
  label: string;
  end?: string;
  daysLeft?: number;
}

/** Inside this many days, the counter should be told before being asked. */
export const WARRANTY_EXPIRING_DAYS = 30;

export function warrantyState(
  s: Pick<Serial, "status" | "warrantyEnd">,
  today: string,
): WarrantyState {
  // A unit that is not with a customer has no promise running against it.
  // Its warranty only begins when it is sold, and a returned unit's is
  // cleared, so an end date sitting here would be a leftover, not a promise.
  if (s.status !== "sold") return { tone: "none", label: "Not sold — no warranty running" };
  if (!s.warrantyEnd) return { tone: "none", label: "Sold with no warranty recorded" };

  const days = warrantyDaysLeft(s.warrantyEnd, today);
  if (days === undefined) return { tone: "none", label: "Sold with no warranty recorded" };
  // Zero is the last covered day, not the first uncovered one — a warranty
  // "until the 31st" is honoured on the 31st, which is exactly the day the
  // customer will turn up.
  if (days < 0)
    return {
      tone: "expired",
      label: `Warranty ended ${-days} ${-days === 1 ? "day" : "days"} ago`,
      end: s.warrantyEnd,
      daysLeft: days,
    };
  const word = days === 1 ? "day" : "days";
  return {
    tone: days <= WARRANTY_EXPIRING_DAYS ? "expiring" : "ok",
    label: days === 0 ? "Warranty ends today" : `Under warranty — ${days} ${word} left`,
    end: s.warrantyEnd,
    daysLeft: days,
  };
}

/**
 * The shop's own claim window against the vendor.
 *
 * Kept separate from the customer's warranty because they expire at different
 * times and only one of them is the customer's business. This is the half
 * that quietly costs money: a unit fails, the shop replaces it, and nobody
 * checks whether the vendor would still have taken it back.
 */
export function vendorClaimState(
  s: Pick<Serial, "vendorWarrantyEnd">,
  today: string,
): WarrantyState {
  if (!s.vendorWarrantyEnd) return { tone: "none", label: "No vendor claim window recorded" };
  const days = warrantyDaysLeft(s.vendorWarrantyEnd, today);
  if (days === undefined) return { tone: "none", label: "No vendor claim window recorded" };
  if (days < 0)
    return {
      tone: "expired",
      label: `Vendor claim closed ${-days} ${-days === 1 ? "day" : "days"} ago`,
      end: s.vendorWarrantyEnd,
      daysLeft: days,
    };
  return {
    tone: days <= WARRANTY_EXPIRING_DAYS ? "expiring" : "ok",
    label: `Claimable from vendor — ${days} ${days === 1 ? "day" : "days"} left`,
    end: s.vendorWarrantyEnd,
    daysLeft: days,
  };
}

/**
 * Units added while receiving do not exist as records yet — the bill has not
 * been saved. They are held as drafts keyed by a temporary id, and turned
 * into Serial records on save. The alternative, writing them immediately,
 * would leave orphan stock behind every time someone opened a purchase and
 * changed their mind.
 */
export const DRAFT_PREFIX = "draft:";
export const isDraftSerial = (id: string) => id.startsWith(DRAFT_PREFIX);
export const draftSerialText = (id: string) => id.slice(DRAFT_PREFIX.length);

/**
 * Which lines do not have the right number of serials.
 *
 * The rule the whole feature rests on: serial count equals line quantity, and
 * the document will not save otherwise. Without it the data rots inside a
 * month, and a warranty screen that is confidently wrong is worse than no
 * warranty screen.
 */
export function serialShortfalls(
  lines: { itemId: string; name: string; qty: number; serialIds?: string[] }[],
  itemOf: (id: string) => { trackSerials?: boolean } | undefined,
): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (!itemOf(l.itemId)?.trackSerials) continue;
    const have = l.serialIds?.length ?? 0;
    if (have === l.qty) continue;
    out.push(
      have < l.qty
        ? `${l.name}: ${l.qty - have} serial${l.qty - have > 1 ? "s" : ""} still to scan`
        : `${l.name}: ${have - l.qty} more serials than quantity`,
    );
  }
  return out;
}

/** Every serial id named anywhere on a set of lines. */
/**
 * The serials on a document, ready to print.
 *
 * Built from allWithVoided(), not all(). A bill printed today must show the
 * units that were on it, and a unit whose purchase was cancelled afterwards
 * is still one of them — the document is a record of what happened, not a
 * view of what is currently on the shelf. Dropping those would silently
 * reprint an old bill with fewer units than the customer was handed.
 *
 * An index rather than a lookup per line, because a bill with twenty lines
 * would otherwise walk the whole collection twenty times.
 */
export function serialTextIndex(serials?: Serial[]): Map<string, string> {
  const all = serials ?? SerialRepo.allWithVoided();
  return new Map(all.map((s) => [s.id, s.serial]));
}

export function serialTextsOn(
  line: { serialIds?: string[] },
  index?: Map<string, string>,
): string[] {
  const ids = line.serialIds ?? [];
  if (!ids.length) return [];
  const idx = index ?? serialTextIndex();
  // Scan order is kept: it is the order the counter picked them up in, and on
  // a warranty claim that is the only thing tying a row of identical adapters
  // to the one in the customer's hand.
  //
  // Draft ids resolve to the text that was scanned. A purchase being entered
  // holds its units as drafts until the bill is saved, so without this the
  // form's own print preview would show an adapter bill with no numbers on
  // it — the one document where the numbers are the point.
  return ids
    .map((id) => (isDraftSerial(id) ? draftSerialText(id) : idx.get(id)))
    .filter((s): s is string => !!s);
}

export const serialIdsOn = (lines: { serialIds?: string[] }[]): string[] =>
  lines.flatMap((l) => l.serialIds ?? []);

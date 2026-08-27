/**
 * When a document may still be destroyed, and when it may only be cancelled.
 *
 * The rule the shop will notice: **anything dated before today is voided, not
 * deleted.** It stays on its list, greyed out and marked, stops counting
 * everywhere, and the ledger posts a reversal dated the day it was cancelled.
 *
 * Why the line falls at today rather than at "anything ever saved": a bill
 * entered wrongly two minutes ago has been reported to nobody, appears in no
 * filed return, and keeping it would leave a permanent mark on the shop's
 * records for a mis-tap. A bill from last month is different in kind — its
 * month has been counted, quite possibly filed, and removing it silently
 * makes that month a different month with nothing on any screen saying so.
 *
 * The period lock (Phase 0b) is a stricter version of the same idea and still
 * applies on top: inside a closed period, neither is allowed.
 */

import { today } from "@/lib/format";

/** True while a document may still be deleted outright. */
export function canDeleteOutright(date: string, now: string = today()): boolean {
  // Dated today or later — a future-dated document has certainly not been
  // reported on either.
  return !!date && date >= now;
}

/** What the action is called on this document, for buttons and confirms. */
export function removalWord(date: string, now: string = today()): "Delete" | "Void" {
  return canDeleteOutright(date, now) ? "Delete" : "Void";
}

/** Whether a record has been cancelled. Written as a function so the check
 *  reads the same everywhere and cannot drift into `=== true`. */
export const isVoided = (r: { voidedAt?: string } | undefined | null): boolean => !!r?.voidedAt;

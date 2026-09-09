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
import { isLocked } from "@/lib/periodLock";

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

/**
 * Whether a document may still be CHANGED in place.
 *
 * Governed by the period lock the owner sets, NOT by whether it is today.
 *
 * This used to be the same "today only" line as deletion, and the reasoning
 * was that an edit leaves no record of itself. That stopped being true when
 * the audit trail landed: every record now carries who changed it and when.
 * What remained was a rule that refused to let a shop fix a rate they typed
 * wrongly yesterday — with no way to say "yes, but this month is not filed
 * yet" — and the honest answer to that is not "void it and re-issue", it is
 * that the shop, not the calendar, knows which months are closed.
 *
 * So: closed months are protected exactly as before, by Settings → Books
 * locked upto. Everything after that line can be corrected, and the change is
 * attributable. A shop that files GST monthly locks the month when it files
 * and gets the old behaviour; a shop that has not locked anything can work.
 *
 * Deletion is deliberately NOT relaxed with it. An edit is recorded; a
 * deletion removes the record, so anything older than today is still voided
 * rather than destroyed.
 */
export function canEditInPlace(date: string, lockedUpto?: string): boolean {
  return !!date && !isLocked(date, lockedUpto);
}

/** Why a document cannot be edited, in the words to show the shop. Only ever
 *  reachable when a lock is set, since that is now the only thing that
 *  refuses. */
export function editRefusalMessage(what: string, lockedUpto?: string): string {
  return lockedUpto
    ? `The books are closed up to ${lockedUpto}, so this ${what} can no longer be changed. Void it and issue a new one instead — both stay on record.`
    : `This ${what} can no longer be changed.`;
}

/** Whether a record has been cancelled. Written as a function so the check
 *  reads the same everywhere and cannot drift into `=== true`. */
export const isVoided = (r: { voidedAt?: string } | undefined | null): boolean => !!r?.voidedAt;

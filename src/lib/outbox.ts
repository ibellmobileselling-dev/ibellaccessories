/**
 * The rules for a bill that did not send.
 *
 * Everything the header dot does makes a broken WhatsApp link *visible*. This
 * is the part that stops it *costing* anything: a send that fails is kept, and
 * goes out on its own when the link comes back, instead of being a toast that
 * scrolls away while the customer walks out.
 *
 * Pure, and separate from the queue itself, because the interesting decisions
 * here are all judgement calls about somebody else's money and reputation:
 *
 *  - **What may be retried at all.** A bill for a party with no phone number
 *    will fail identically forever. Queueing it is not resilience, it is a
 *    permanent red badge the shop learns to ignore.
 *  - **What must never be retried automatically.** If we cannot tell whether
 *    the message went out, sending it again may deliver the customer a second
 *    copy of their invoice. That is a person's decision, not a timer's.
 */

/** What a failed send turned out to be. */
export type FailureKind =
  /** Will fail the same way forever. Tell the person now; queue nothing. */
  | "permanent"
  /** The link was down. The message certainly did not go — safe to retry. */
  | "offline"
  /** We cannot tell whether it went. Keep it, but a person must decide. */
  | "uncertain";

/**
 * Faults in the request itself, not in the link.
 *
 * Matched on the messages this app actually throws — every one of them is
 * raised before the bridge is contacted, so nothing was sent and nothing will
 * be until somebody changes something.
 */
const PERMANENT = [
  "no phone number saved",
  /* The bridge asked WhatsApp and WhatsApp said no such account. A landline
     or a mistyped digit in a party record — common, and until the bridge
     started checking, a send that "succeeded" into nothing. No amount of
     retrying makes a number exist, so this belongs in front of a person. */
  "is not on WhatsApp",
  "Not signed in",
  "Not authenticated",
  "isn't configured",
  "Only the business owner",
  "account isn't active",
  "pdfBase64 is required",
];

/**
 * Faults that prove the message did not go out.
 *
 * Either the app already knew the link was down, or the service said so. Both
 * mean nothing reached WhatsApp, which is what makes an automatic retry safe
 * rather than a way of sending someone two invoices.
 */
const DEFINITELY_NOT_SENT = [
  "Could not reach the WhatsApp service",
  "not connected",
  "disconnected",
  "no session",
  "logged out",
];

/**
 * Failures where an automatic retry is the dangerous move.
 *
 * Checked BEFORE the "the link was down, so nothing was sent" shortcut,
 * because both of these can happen while the app believes the link is down and
 * both mean a message may already be on its way. A timer must not be the thing
 * that decides to send a customer a second invoice.
 */
const NEVER_AUTOMATIC = [
  // The bridge is mid-send on this very bill under the same id. Whatever it
  // is doing, adding a second attempt to it cannot help.
  "already being sent",
  // Our own request timed out. The bridge waits for WhatsApp to acknowledge
  // before it answers, so no answer means precisely that: unknown.
  "may or may not have been sent",
];

export function classifySendFailure(message: string, linkWasConnected: boolean): FailureKind {
  const m = message || "";
  if (PERMANENT.some((p) => m.toLowerCase().includes(p.toLowerCase()))) return "permanent";
  if (NEVER_AUTOMATIC.some((p) => m.toLowerCase().includes(p.toLowerCase()))) return "uncertain";
  if (!linkWasConnected) return "offline";
  if (DEFINITELY_NOT_SENT.some((p) => m.toLowerCase().includes(p.toLowerCase()))) return "offline";
  return "uncertain";
}

export interface OutboxItem {
  id: string;
  /** What the shop will recognise this by — an invoice number, or a party. */
  label: string;
  phone: string;
  message: string;
  fileName: string;
  /** The printable HTML, not the rendered PDF: it is a fraction of the size,
   *  and the PDF is re-rendered at send time anyway. */
  html: string;
  landscape: boolean;
  pageWidthMm?: number;
  queuedAt: string;
  /** When it was last tried, which is what the backoff counts from. Counting
   *  from queuedAt instead would make every retry after the first one due
   *  immediately, and the backoff purely decorative. */
  lastAttemptAt?: string;
  attempts: number;
  lastError?: string;
  /**
   * Whether the queue may send this by itself.
   *
   * False for anything we could not prove failed, and for anything that has
   * exhausted its attempts. A false here is never a dead end — it means the
   * row waits in Settings with a Send now button, which is a person choosing
   * to risk a duplicate rather than a timer choosing for them.
   */
  auto: boolean;
  /** Epoch ms, set by whichever tab is currently attempting it. */
  sendingSince?: number;
}

/** Attempts before it stops trying on its own and asks for a person.
 *  Never deleted — a bill the shop believes was sent must not evaporate. */
export const MAX_ATTEMPTS = 8;

/** A cap, so a shop that leaves WhatsApp broken for a month does not fill
 *  the browser's storage and start failing at something else entirely. */
export const MAX_QUEUE = 50;

/** How long another tab's claim is respected before it is assumed dead.
 *  Two tills flushing the same row is the other way to send a duplicate. */
export const CLAIM_STALE_MS = 120_000;

/**
 * Backoff between attempts: 30s doubling to a half-hour ceiling.
 *
 * Gentle on purpose. The queue is normally woken by the link coming back, not
 * by this timer — the delay exists so a bridge that is up but refusing is not
 * hammered, not to schedule the real retry.
 */
export function retryDelayMs(attempts: number): number {
  const n = Math.max(0, attempts);
  return Math.min(30_000 * 2 ** n, 1_800_000);
}

/** Whether this row may be attempted right now. */
export function isDue(item: OutboxItem, now: number): boolean {
  if (!item.auto) return false;
  if (item.attempts >= MAX_ATTEMPTS) return false;
  // Somebody else is already on it, unless their claim has gone stale.
  if (item.sendingSince && now - item.sendingSince < CLAIM_STALE_MS) return false;
  const last = Date.parse(item.lastAttemptAt ?? item.queuedAt);
  const readyAt = (Number.isFinite(last) ? last : now) + retryDelayMs(item.attempts);
  return now >= readyAt;
}

/** Rows a person still has to deal with, because nothing else will. */
export function needsAttention(item: OutboxItem): boolean {
  return !item.auto || item.attempts >= MAX_ATTEMPTS;
}

/** What to say at the counter the moment a send does not go through. */
export function queuedMessage(kind: Exclude<FailureKind, "permanent">, what: string): string {
  return kind === "offline"
    ? `WhatsApp is disconnected — ${what} is queued and will send on its own once it's back.`
    : `Couldn't confirm ${what} was sent. It's saved in Settings → WhatsApp, so you can check and send it yourself.`;
}

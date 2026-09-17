/**
 * What the WhatsApp link is actually doing, said in a way a shop can act on.
 *
 * The bridge service reports three states — `waiting`, `qr`, `connected` — and
 * a shop needs six. The missing four are not absent from the wire because the
 * service is withholding them; they are simply not facts about a single
 * reading. "Booting" and "logged out three days ago" send byte-identical
 * responses, and what separates them is *time* and *history*, both of which
 * live here rather than there.
 *
 * That is the whole reason this file exists as a pure function: the difference
 * between "give it a moment" and "somebody must pick up the phone and scan"
 * is the entire value of the feature, it is decided from three inputs and a
 * clock, and it is the kind of logic that is quietly wrong for a month if it
 * is spread across a component.
 *
 * No React, no fetch, no clock of its own — `now` is a parameter so the
 * boundary cases can be asserted instead of waited for.
 */

/** Exactly what the bridge's /qr endpoint reports. */
export type BridgeStatus = "waiting" | "qr" | "connected";

/** One poll. `status: null` means the service could not be reached at all —
 *  a different fault from anything the service itself would say. */
export interface BridgeReading {
  status: BridgeStatus | null;
  phone?: string;
}

export interface LinkHistory {
  /**
   * Has this shop ever had a live link? The single most useful bit here: it
   * turns an identical `waiting` into either "not set up yet" or "it broke",
   * which are opposite messages to put in front of somebody.
   */
  everConnected: boolean;
  /**
   * When the current unbroken run of not-connected readings began (epoch ms),
   * or undefined if the last reading was connected. Held by the caller because
   * it survives longer than any one poll.
   */
  unsettledSince?: number;
}

export type LinkState =
  /** Connected. The only state in which a bill will actually go out. */
  | "connected"
  /** Not connected yet, but too recently to be worth mentioning. */
  | "starting"
  /** A QR is waiting to be scanned. */
  | "scan_needed"
  /** Was working, now isn't, and no QR has appeared to fix it with. */
  | "dropped"
  /** Never linked on this service, and nothing is offering a QR. */
  | "never_linked"
  /** The bridge service itself did not answer. */
  | "unreachable";

/**
 * How long a not-connected reading is given before it is called a fault.
 *
 * A cold bridge genuinely takes tens of seconds to boot and re-establish its
 * socket, and a red light during a normal start would train the shop to ignore
 * the red light — which costs more than the honest wait does.
 */
export const LINK_GRACE_MS = 30_000;

/**
 * One reading plus what came before it, resolved to one thing to show.
 *
 * Order matters: `connected` short-circuits, then the grace period, and only
 * then the split by history. Checking history first would let a 2-second blip
 * on a working shop render "Disconnected".
 */
export function deriveLinkState(
  reading: BridgeReading,
  history: LinkHistory,
  now: number,
): LinkState {
  if (reading.status === "connected") return "connected";

  // A QR is never a "wait and see" — it is a thing somebody can do right now,
  // so it outranks the grace period. The distinction between a first link and
  // a relink is left to the copy, because the action is the same either way.
  if (reading.status === "qr") return "scan_needed";

  const since = history.unsettledSince ?? now;
  if (now - since < LINK_GRACE_MS) return "starting";

  if (reading.status === null) return "unreachable";
  return history.everConnected ? "dropped" : "never_linked";
}

/** Green / grey / red, and nothing in between: the header dot is read at a
 *  glance from across a counter, not studied. */
export type LinkSeverity = "ok" | "busy" | "bad";

export function linkSeverity(state: LinkState): LinkSeverity {
  if (state === "connected") return "ok";
  if (state === "starting") return "busy";
  return "bad";
}

/** True when scanning a QR is the thing that will fix this. Owner-only work,
 *  so the caller pairs it with a permission check before promising it. */
export function needsScan(state: LinkState): boolean {
  return state === "scan_needed" || state === "dropped" || state === "never_linked";
}

/**
 * The shop's wording, in one place.
 *
 * Kept out of the components on purpose: the same state is described in the
 * header tooltip, the reconnect dialog and the Settings card, and three
 * hand-written versions of "disconnected" drift apart within a month — at
 * which point the shop is being told two different things about one fact.
 */
export function linkHeadline(state: LinkState, history: LinkHistory): string {
  switch (state) {
    case "connected":
      return "WhatsApp connected";
    case "starting":
      return "Connecting to WhatsApp…";
    case "scan_needed":
      return history.everConnected ? "WhatsApp needs relinking" : "WhatsApp isn't set up yet";
    case "dropped":
      return "WhatsApp is disconnected";
    case "never_linked":
      return "WhatsApp isn't set up yet";
    case "unreachable":
      return "Can't reach the WhatsApp service";
  }
}

/**
 * What to do about it — addressed to whoever is actually reading.
 *
 * Staff get told to fetch the owner rather than given instructions they cannot
 * follow: only an owner can see the QR, and a counter clerk left staring at a
 * dead end mid-sale is the complaint this whole change exists to remove.
 */
export function linkAdvice(state: LinkState, history: LinkHistory, isOwner: boolean): string {
  if (state === "connected") return "Bills and statements will send straight away.";
  if (state === "starting") return "This usually takes a few seconds after a quiet spell.";

  if (state === "unreachable") {
    return isOwner
      ? "The service didn't answer. It may be restarting — if this doesn't clear in a few minutes, the WhatsApp service needs looking at."
      : "The service didn't answer. Let the owner know if it doesn't come back shortly.";
  }

  if (!isOwner) {
    return "Bills won't send until it's linked again. Ask the owner to reconnect it from Settings.";
  }

  if (state === "scan_needed") {
    return history.everConnected
      ? "Open WhatsApp on the shop's phone → Linked Devices → Link a Device, and scan the code."
      : "Scan the code with the shop's phone to start sending bills on WhatsApp.";
  }
  return "Waiting for a fresh QR code. If none appears, restart the WhatsApp service and try again.";
}

/**
 * "Disconnected since Tuesday" — the phrase that turns a status into a
 * reprimand the shop can act on, because it says how many bills went unsent.
 *
 * Deliberately vague past a week: an exact timestamp implies a precision this
 * does not have, since the record is only as old as this device's memory of it.
 */
export function sinceLabel(lastConnectedAt: string | undefined, now: number): string | undefined {
  if (!lastConnectedAt) return undefined;
  const then = Date.parse(lastConnectedAt);
  if (!Number.isFinite(then) || then > now) return undefined;

  const mins = Math.floor((now - then) / 60_000);
  if (mins < 2) return "Last connected just now";
  if (mins < 60) return `Last connected ${mins} minutes ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Last connected ${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `Last connected ${days} day${days === 1 ? "" : "s"} ago`;
  return "Last connected more than a week ago";
}

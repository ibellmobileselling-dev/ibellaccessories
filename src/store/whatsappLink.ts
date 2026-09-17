/**
 * One poll of the WhatsApp link, shared by the whole app.
 *
 * The status indicator lives in the header, which means it is mounted on every
 * page for every user for the whole day. A `useEffect` polling inside the
 * component would multiply by tabs and by tills, and the shop would be asking
 * a service that is already struggling a few thousand extra times a day for an
 * answer that changes about twice a week.
 *
 * So: one store, one timer, however many subscribers. The cadence is set by
 * what is actually happening rather than by a constant — fast while somebody
 * is watching a QR code, slow while everything works, and nothing at all while
 * the tab is in the background.
 */

import { create } from "zustand";
import { useEffect } from "react";
import { auth, isBrowser } from "@/lib/firebase";
import {
  getWhatsAppLinkStateServerFn,
  getWhatsAppStatusServerFn,
  type WhatsAppStatus,
} from "@/lib/whatsappAdmin";
import {
  deriveLinkState,
  type BridgeReading,
  type LinkHistory,
  type LinkState,
} from "@/lib/whatsappLink";

/* ── Cadence ──────────────────────────────────────────────────────────────
   Every one of these is "how long until the answer could reasonably have
   changed", not a round number. */

/** Working. Nothing is changing; asking more often buys nothing. */
const POLL_CONNECTED = 60_000;
/** Broken. Somebody is probably fixing it right now and wants the dot to
 *  turn green the moment it does. */
const POLL_BROKEN = 15_000;
/** Still inside the grace period — poll faster than the grace itself, so the
 *  moment it expires is reported within seconds rather than at the next
 *  minute. */
const POLL_STARTING = 5_000;
/** A QR on screen goes stale and has to look live while it is being scanned. */
const POLL_SCANNING = 3_000;

/** Remembering that this shop once had a working link is what turns an
 *  identical `waiting` into "it broke" rather than "not set up yet". Local to
 *  the device, which is enough: it is a hint for the wording, never a fact
 *  anything is calculated from. */
const HISTORY_KEY = "bizdesk.whatsapp.link.v1";

interface StoredHistory {
  everConnected: boolean;
  lastConnectedAt?: string;
}

function loadHistory(): StoredHistory {
  if (!isBrowser) return { everConnected: false };
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return { everConnected: false };
    const p = JSON.parse(raw) as Partial<StoredHistory>;
    return { everConnected: p.everConnected === true, lastConnectedAt: p.lastConnectedAt };
  } catch {
    // A browser with storage blocked still gets a working indicator; it just
    // says "not set up yet" instead of "disconnected". Never a reason to fail.
    return { everConnected: false };
  }
}

function saveHistory(h: StoredHistory) {
  if (!isBrowser) return;
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
  } catch {
    /* storage full or blocked — the indicator degrades, nothing breaks */
  }
}

interface LinkStore {
  /** False until the first reading lands, so nothing renders a guess. */
  ready: boolean;
  /** False when this deployment has no WhatsApp service at all. The whole
   *  indicator hides rather than showing a red light for a feature that was
   *  never bought. */
  configured: boolean;
  reading: BridgeReading;
  history: LinkHistory & StoredHistory;
  state: LinkState;
  phone?: string;
  /** Only ever populated for an owner with the dialog open. */
  qr?: string;
  /**
   * Why the last reading failed, when it did.
   *
   * Kept because the alternative was proven worse: the first version threw
   * this away, and a perfectly healthy service was reported as unreachable
   * with nothing on screen to contradict it. An error nobody can read is an
   * error nobody can fix.
   */
  lastError?: string;
  /** True when the app could not even ask — a rejected sign-in, our own
   *  server erroring — as opposed to the bridge not answering. Different
   *  fault, different person fixes it, different sentence on screen. */
  askFailed: boolean;
  /** True while a dialog is showing, which makes the poll fast and lets the
   *  owner's reading include the QR. */
  watching: boolean;
  setWatching: (v: boolean) => void;
  /** Ground truth from an actual send, which outranks any polled status. */
  noteSendResult: (ok: boolean) => void;
  refresh: () => Promise<void>;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let subscribers = 0;
/** Guards against two refreshes overlapping — a slow poll plus a manual one
 *  would otherwise apply their readings out of order and flicker the dot. */
let inFlight = false;

const initialHistory = loadHistory();

export const useWhatsAppLinkStore = create<LinkStore>((set, get) => ({
  ready: false,
  configured: true,
  reading: { status: null },
  history: { ...initialHistory, unsettledSince: undefined },
  state: "starting",
  askFailed: false,
  watching: false,

  setWatching: (v) => {
    set({ watching: v, qr: v ? get().qr : undefined });
    if (v) void get().refresh();
    schedule();
  },

  /**
   * A send that succeeded proves the socket was alive a second ago; one that
   * failed proves it was not. Both beat the polled status, which a sleeping
   * bridge will happily answer with `connected` long after WhatsApp has gone.
   * This is what makes the green dot mean something.
   */
  noteSendResult: (ok) => {
    const now = Date.now();
    if (ok) {
      const history = { everConnected: true, lastConnectedAt: new Date(now).toISOString() };
      saveHistory(history);
      set({
        ready: true,
        reading: { status: "connected" },
        history: { ...history, unsettledSince: undefined },
        state: "connected",
      });
    } else {
      // Not marked broken outright: the failure may have been this one bill
      // (no phone number, a bad PDF). Re-read instead of guessing, but stop
      // trusting the last green reading in the meantime.
      void get().refresh();
    }
    schedule();
  },

  refresh: async () => {
    if (!isBrowser || inFlight) return;
    inFlight = true;
    try {
      const callerIdToken = await auth.currentUser?.getIdToken();
      // Signed out: not a WhatsApp fault, and nothing to show anybody.
      if (!callerIdToken) return;

      const { watching } = get();
      let reading: BridgeReading;
      let qr: string | undefined;
      let configured = true;
      let lastError: string | undefined;
      let askFailed = false;

      // The owner's reader carries the QR but is owner-only, so it is tried
      // first and only when a code is actually wanted. A staff user simply
      // falls through to the one everybody may call.
      if (watching) {
        try {
          const full: WhatsAppStatus = await getWhatsAppStatusServerFn({ data: { callerIdToken } });
          qr = full.qr;
        } catch {
          // Not an owner, or the bridge is down. Either way the lean reader
          // below decides what to show; this only ever adds the picture.
        }
      }

      try {
        const lean = await getWhatsAppLinkStateServerFn({ data: { callerIdToken } });
        configured = lean.configured;
        lastError = lean.error;
        // A bridge that did not answer is a null reading — the state machine
        // turns that into "unreachable" once it has persisted past the grace
        // period. A bridge that answered is never called unreachable again,
        // whatever else is wrong.
        reading = lean.reachable ? { status: lean.status, phone: lean.phone } : { status: null };
      } catch (err) {
        // We could not even ask. That is our fault, not the service's, and
        // it must not be reported as the service being down.
        askFailed = true;
        lastError = err instanceof Error ? err.message : "Could not check WhatsApp";
        reading = { status: null };
      }

      const now = Date.now();
      const prev = get().history;

      const history: LinkHistory & StoredHistory =
        reading.status === "connected"
          ? { everConnected: true, lastConnectedAt: new Date(now).toISOString() }
          : {
              everConnected: prev.everConnected,
              lastConnectedAt: prev.lastConnectedAt,
              // Started when the run of bad readings began, not now — so the
              // grace period measures the outage, not this poll.
              unsettledSince: prev.unsettledSince ?? now,
            };

      if (reading.status === "connected") {
        saveHistory({ everConnected: true, lastConnectedAt: history.lastConnectedAt });
      }

      set({
        ready: true,
        configured,
        reading,
        history,
        qr,
        lastError,
        askFailed,
        phone: reading.phone,
        // Derived even when unconfigured — the indicator hides on `configured`
        // rather than on a state we invented, so nothing downstream is ever
        // handed a cheerful "connected" for a service that does not exist.
        state: deriveLinkState(reading, history, now),
      });
    } finally {
      inFlight = false;
      schedule();
    }
  },
}));

/** Next poll, chosen by what is on screen and what the link is doing. */
function nextDelay(): number {
  const { state, watching } = useWhatsAppLinkStore.getState();
  if (watching) return POLL_SCANNING;
  if (state === "connected") return POLL_CONNECTED;
  if (state === "starting") return POLL_STARTING;
  return POLL_BROKEN;
}

function schedule() {
  clearTimeout(timer);
  if (!isBrowser || subscribers === 0) return;
  // A background tab is nobody looking. It re-reads on focus instead, which
  // is also the moment the answer actually matters again.
  if (document.visibilityState === "hidden") return;
  timer = setTimeout(() => void useWhatsAppLinkStore.getState().refresh(), nextDelay());
}

function onVisible() {
  if (document.visibilityState === "visible") void useWhatsAppLinkStore.getState().refresh();
  else clearTimeout(timer);
}

/**
 * Subscribe to the link status. Ref-counted, so the timer exists only while
 * something is actually rendering it.
 */
export function useWhatsAppLink() {
  const store = useWhatsAppLinkStore();

  useEffect(() => {
    if (!isBrowser) return;
    subscribers++;
    if (subscribers === 1) {
      document.addEventListener("visibilitychange", onVisible);
      void useWhatsAppLinkStore.getState().refresh();
    }
    return () => {
      subscribers--;
      if (subscribers === 0) {
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, []);

  return store;
}

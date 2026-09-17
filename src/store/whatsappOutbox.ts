/**
 * The queue of bills that did not send, and the loop that gets them out.
 *
 * The rules it obeys are all in `lib/outbox` — what may be retried, when, and
 * what must wait for a person. This file is the moving parts: read the store,
 * claim a row, transmit it, write back what happened.
 *
 * One flush at a time, one row at a time. A queue that fires everything at
 * once at the moment a link recovers would hand a just-revived bridge twenty
 * simultaneous PDF renders, which is a good way to knock it over again.
 */

import { create } from "zustand";
import { isBrowser } from "@/lib/firebase";
import { transmit } from "@/lib/whatsappTransmit";
import { allQueued, putQueued, removeQueued, queueIsMemoryOnly } from "@/lib/outboxDb";
import { isDue, MAX_QUEUE, type OutboxItem } from "@/lib/outbox";
import { useWhatsAppLinkStore } from "@/store/whatsappLink";

interface OutboxStore {
  items: OutboxItem[];
  loaded: boolean;
  flushing: boolean;
  /** True when storage fell back to memory and the queue dies with the tab. */
  memoryOnly: boolean;
  load: () => Promise<void>;
  enqueue: (item: OutboxItem) => Promise<void>;
  /** Try everything that is due. Safe to call often; it no-ops if busy. */
  flush: () => Promise<void>;
  /** A person pressing Send now — bypasses `auto` and the backoff, because
   *  they have decided to accept the risk of a duplicate. */
  sendNow: (id: string) => Promise<void>;
  discard: (id: string) => Promise<void>;
}

/** Module-level, not store state: two flushes must not interleave even for
 *  the instant it takes React to apply a `set`. */
let flushing = false;

export const useOutboxStore = create<OutboxStore>((set, get) => ({
  items: [],
  loaded: false,
  flushing: false,
  memoryOnly: false,

  load: async () => {
    if (!isBrowser) return;
    const items = await allQueued();
    set({ items: sortOldestFirst(items), loaded: true, memoryOnly: queueIsMemoryOnly() });
  },

  enqueue: async (item) => {
    const { items } = get();
    // The cap drops the OLDEST, which is the one most likely already resolved
    // some other way — and it is only reachable after fifty consecutive
    // failures, by which point the shop has a much larger problem on show.
    const trimmed = items.length >= MAX_QUEUE ? items.slice(items.length - MAX_QUEUE + 1) : items;
    for (const gone of items.filter((i) => !trimmed.includes(i))) await removeQueued(gone.id);

    await putQueued(item);
    set({ items: sortOldestFirst([...trimmed, item]), memoryOnly: queueIsMemoryOnly() });
  },

  flush: async () => {
    if (!isBrowser || flushing) return;
    if (!get().loaded) await get().load();

    const due = get().items.filter((i) => isDue(i, Date.now()));
    if (!due.length) return;

    flushing = true;
    set({ flushing: true });
    try {
      for (let i = 0; i < due.length; i++) {
        // Re-read the link between rows: if it died again on the row before,
        // there is no point marching the rest of the queue into the same wall
        // and burning an attempt on each of them.
        if (i > 0 && useWhatsAppLinkStore.getState().state !== "connected") break;
        await attempt(due[i], set, get);
      }
    } finally {
      flushing = false;
      set({ flushing: false });
    }
  },

  sendNow: async (id) => {
    const item = get().items.find((i) => i.id === id);
    if (!item || flushing) return;
    flushing = true;
    set({ flushing: true });
    try {
      await attempt(item, set, get, { manual: true });
    } finally {
      flushing = false;
      set({ flushing: false });
    }
  },

  discard: async (id) => {
    await removeQueued(id);
    set({ items: get().items.filter((i) => i.id !== id) });
  },
}));

/**
 * One row, once.
 *
 * Claimed before the attempt and released after, so a second tab looking at
 * the same IndexedDB does not send the same invoice again. The claim is a
 * timestamp rather than a flag for the obvious reason: a tab closed mid-send
 * would otherwise lock the row out forever.
 */
async function attempt(
  item: OutboxItem,
  set: (p: Partial<OutboxStore>) => void,
  get: () => OutboxStore,
  opts?: { manual: boolean },
) {
  const claimed: OutboxItem = { ...item, sendingSince: Date.now() };
  await putQueued(claimed);
  set({ items: replace(get().items, claimed) });

  try {
    await transmit({
      html: item.html,
      phone: item.phone,
      message: item.message,
      fileName: item.fileName,
      landscape: item.landscape,
      pageWidthMm: item.pageWidthMm,
      // The row id IS the id the service deduplicates on — which is what
      // makes a retry of something that already went out safe.
      clientMessageId: item.id,
    });
    // Gone from the queue only once it is genuinely out.
    await removeQueued(item.id);
    set({ items: get().items.filter((i) => i.id !== item.id) });
  } catch (err) {
    const failed: OutboxItem = {
      ...item,
      attempts: item.attempts + 1,
      lastAttemptAt: new Date().toISOString(),
      lastError: err instanceof Error ? err.message : "Could not send",
      sendingSince: undefined,
      // A manual attempt that fails does not silently re-arm the timer: the
      // person is watching, and is the one who should decide to try again.
      auto: opts?.manual ? false : item.auto,
    };
    await putQueued(failed);
    set({ items: replace(get().items, failed) });
  }
}

const replace = (items: OutboxItem[], next: OutboxItem) =>
  items.map((i) => (i.id === next.id ? next : i));

/** Oldest first, so a shop that queued twenty bills sees them go out in the
 *  order it made them rather than backwards. */
const sortOldestFirst = (items: OutboxItem[]) =>
  [...items].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));

/**
 * How often the queue looks at itself.
 *
 * The link coming back is the interesting trigger, but it cannot be the only
 * one: a row that fails while the link is up is held by its backoff, and if
 * nothing ever looks again it waits for a state change that may never happen.
 * A minute is well under the shortest backoff, so no row waits meaningfully
 * longer than its own rule says.
 */
const TICK_MS = 60_000;

/**
 * Wake the queue: at startup, whenever the link comes back, and on a slow
 * tick for anything whose own backoff has since expired.
 *
 * Subscribed outside React, because a recovery happens while nobody is
 * looking at Settings — which is exactly the case this whole phase exists
 * for. `flush` is a no-op when nothing is due, so an idle shop pays nothing
 * for the tick beyond an array filter a minute.
 */
let started = false;
export function startOutbox() {
  if (!isBrowser || started) return;
  started = true;

  void useOutboxStore
    .getState()
    .load()
    .then(() => void useOutboxStore.getState().flush());

  let wasConnected = useWhatsAppLinkStore.getState().state === "connected";
  useWhatsAppLinkStore.subscribe((s) => {
    const now = s.state === "connected";
    if (now && !wasConnected) void useOutboxStore.getState().flush();
    wasConnected = now;
  });

  setInterval(() => {
    // A background tab is nobody waiting on a bill, and a PDF render is
    // expensive enough not to spend on one.
    if (document.visibilityState === "hidden") return;
    if (!useOutboxStore.getState().items.length) return;
    void useOutboxStore.getState().flush();
  }, TICK_MS);
}

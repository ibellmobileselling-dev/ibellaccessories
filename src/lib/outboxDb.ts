/**
 * Where a queued bill actually sits.
 *
 * IndexedDB rather than localStorage: each row carries the printable HTML of a
 * whole invoice, which with the app's stylesheet is well over a hundred
 * kilobytes. A handful of those would exhaust localStorage's ~5MB and start
 * throwing on write — and the one moment this queue must not fail is the
 * moment WhatsApp is already broken.
 *
 * Hand-rolled rather than pulling in a wrapper library: this is four
 * operations on one object store, and a dependency added to a production
 * billing app should buy more than that.
 */

import type { OutboxItem } from "@/lib/outbox";

const DB_NAME = "bizdesk-whatsapp-outbox";
const STORE = "queue";
const VERSION = 1;

/**
 * Used when IndexedDB is unavailable — a private window, a locked-down
 * browser, or SSR.
 *
 * Deliberately still a working queue for the length of the session rather than
 * a thrown error: a shop in a private window should still be told its bill is
 * waiting, even if closing the tab loses it. Failing the send outright would
 * be strictly worse than the behaviour this whole feature replaces.
 */
const memory = new Map<string, OutboxItem>();
let useMemory = false;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("no indexedDB"));
      return;
    }
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    // A version change blocked by another tab would otherwise hang forever.
    req.onblocked = () => reject(new Error("indexedDB blocked"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
    tx.oncomplete = () => db.close();
  });
}

export async function allQueued(): Promise<OutboxItem[]> {
  if (useMemory) return [...memory.values()];
  try {
    const rows = await withStore<OutboxItem[]>("readonly", (s) => s.getAll() as IDBRequest);
    return rows ?? [];
  } catch {
    useMemory = true;
    return [...memory.values()];
  }
}

export async function putQueued(item: OutboxItem): Promise<void> {
  if (useMemory) {
    memory.set(item.id, item);
    return;
  }
  try {
    await withStore("readwrite", (s) => s.put(item) as IDBRequest);
  } catch {
    useMemory = true;
    memory.set(item.id, item);
  }
}

export async function removeQueued(id: string): Promise<void> {
  if (useMemory) {
    memory.delete(id);
    return;
  }
  try {
    await withStore("readwrite", (s) => s.delete(id) as IDBRequest);
  } catch {
    useMemory = true;
    memory.delete(id);
  }
}

/** True once storage has fallen back — the UI says so, because a queue that
 *  will not survive a refresh is a different promise from one that will. */
export function queueIsMemoryOnly(): boolean {
  return useMemory;
}

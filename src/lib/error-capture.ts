// Captures the original Error out-of-band so server.ts can recover the stack
// when h3 has already swallowed the throw into a generic 500 Response.
//
// Scoped per-request via AsyncLocalStorage (see withCapturedErrorScope in
// server.ts) — a single shared module-level slot would let two concurrent
// SSR requests erroring within the TTL window consume/clobber each other's
// captured error, misattributing it in production logs.

import { AsyncLocalStorage } from "node:async_hooks";

type Slot = { error: unknown; at: number } | undefined;

const TTL_MS = 5_000;
const als = new AsyncLocalStorage<{ current: Slot }>();
// Fallback for errors captured outside any tracked request scope (e.g.
// during module init) — better to keep these than drop them silently.
const fallbackSlot: { current: Slot } = { current: undefined };

function currentSlot(): { current: Slot } {
  return als.getStore() ?? fallbackSlot;
}

function record(error: unknown) {
  currentSlot().current = { error, at: Date.now() };
}

if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("error", (event) => record((event as ErrorEvent).error ?? event));
  globalThis.addEventListener("unhandledrejection", (event) =>
    record((event as PromiseRejectionEvent).reason),
  );
}

/** Run `fn` with an error-capture slot isolated to this call (one SSR
 * request) so concurrent requests can't see/consume each other's error. */
export function withCapturedErrorScope<T>(fn: () => Promise<T>): Promise<T> {
  return als.run({ current: undefined }, fn);
}

export function consumeLastCapturedError(): unknown {
  const slot = currentSlot();
  const captured = slot.current;
  if (!captured) return undefined;
  if (Date.now() - captured.at > TTL_MS) {
    slot.current = undefined;
    return undefined;
  }
  slot.current = undefined;
  return captured.error;
}

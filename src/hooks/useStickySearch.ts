import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/**
 * Session memory for a screen's search box, keyed by screen.
 *
 * Searching a long list, opening one of the results and pressing back used to
 * land on an unfiltered list — the search was component state and died with
 * the unmount, so the shopkeeper retyped it every single time. The bill lists
 * already solved this with their own `filterCache`; this is the same idea
 * without a bespoke cache per page.
 *
 * Deliberately module-level rather than sessionStorage: it should survive
 * navigation, not a reload. A reload is how you say "start again", and a
 * filter that outlives it becomes a list that is mysteriously missing rows.
 *
 * The restored text is always VISIBLE in the box, so this is remembered
 * state, never hidden state — one look tells you why the list is short, and
 * clearing it is one click.
 */
const memory = new Map<string, unknown>();

/** Forget everything remembered — for tests, and for sign-out, where the
 *  next person at the counter must not inherit the last one's filters. */
export function clearStickyState() {
  memory.clear();
}

export function useStickyState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => (memory.has(key) ? (memory.get(key) as T) : initial));
  // Mirror on every change, however it was set (direct or functional update),
  // so the memory can never drift from what is on screen.
  useEffect(() => {
    memory.set(key, value);
  }, [key, value]);
  return [value, setValue];
}

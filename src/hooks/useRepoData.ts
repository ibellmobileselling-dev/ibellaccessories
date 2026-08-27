import { useMemo, useSyncExternalStore } from "react";
import { subscribeRepos, repoStoreVersion } from "@/repositories/base";

/**
 * Re-render the calling component whenever ANY repository's data changes —
 * first load, live cloud sync, or a local write. Read whatever repos you need
 * directly in render (e.g. `ItemRepo.all()`, ledger helpers) — this hook only
 * drives the re-render; it returns a version number you can otherwise ignore.
 *
 * This is what makes the app safe to open before all data has loaded: a screen
 * that mounts with empty repos will re-render and fill in the moment its
 * collection's snapshot arrives, instead of showing stale/empty data forever.
 */
export function useRepoData(): number {
  return useSyncExternalStore(subscribeRepos, repoStoreVersion, () => 0);
}

/**
 * useMemo that ALSO recomputes whenever repository data changes — the safe
 * way to derive anything from a repo.
 *
 * Prefer this over `useMemo(() => Repo.all(), [useRepoData()])`. That works,
 * but react-hooks/exhaustive-deps flags the version token as an "unnecessary
 * dependency" (the callback never names it), so an `eslint --fix` or anyone
 * taking the lint advice at face value silently deletes it — and the memo
 * freezes on whatever the cache held at mount, which on a cold open is
 * nothing. That is exactly how the party/item/bank pickers in the billing
 * forms ended up permanently empty, and how save-time party dedup ran against
 * an empty list and created duplicate customers.
 *
 * Wrapping it here means call sites carry no suppression and cannot forget
 * the version at all.
 */
export function useRepoMemo<T>(read: () => T, deps: readonly unknown[] = []): T {
  const version = useRepoData();
  // The caller's own deps plus the repo version. `read` is intentionally not
  // a dependency: it's a fresh closure every render, which would defeat the
  // memo entirely.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(read, [version, ...deps]);
}

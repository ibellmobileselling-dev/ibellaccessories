/**
 * Deploy-safety: recover from stale JS chunk imports.
 *
 * The app is code-split into hash-named chunks (index-ABC123.js). Every deploy
 * changes those hashes and the old files are purged. If a browser (Safari is
 * the worst offender) is holding an old HTML document — or had the tab open
 * across a deploy — a dynamic import() can point at a chunk hash that no longer
 * exists on the server → the browser throws "Importing a module script failed"
 * / "Failed to fetch dynamically imported module", and the whole page dies.
 *
 * The cure is simply to reload: a fresh HTML document references the new chunk
 * hashes (the server sends the document with no-cache so this always works).
 * We reload AT MOST once per short window so a genuinely broken deploy can't
 * spin in an infinite reload loop — after that we let the error surface.
 */

const RELOAD_KEY = "bz.chunkReloadAt";
const RELOAD_COOLDOWN_MS = 15_000;

/** True for the various ways browsers word a failed dynamic-import of a chunk. */
export function isModuleLoadError(error: unknown): boolean {
  const msg = (
    error instanceof Error ? error.message : typeof error === "string" ? error : ""
  ).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("importing a module script failed") ||
    msg.includes("failed to fetch dynamically imported module") ||
    msg.includes("error loading dynamically imported module") ||
    msg.includes("module script failed") ||
    msg.includes("unable to preload") ||
    // Chrome/Firefox wording
    msg.includes("dynamically imported module")
  );
}

/**
 * Hard-reload once to pick up the current deploy's chunks. Returns true if a
 * reload was triggered, false if we're still in the cooldown (so the caller can
 * fall back to showing the error instead of looping).
 */
export function reloadOnceForChunkError(): boolean {
  if (typeof window === "undefined") return false;
  let last = 0;
  try {
    last = Number(window.sessionStorage.getItem(RELOAD_KEY) || 0);
  } catch {
    // sessionStorage can throw in private mode / blocked storage — treat as 0.
  }
  const now = Date.now();
  if (now - last < RELOAD_COOLDOWN_MS) return false;
  try {
    window.sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    /* ignore */
  }
  window.location.reload();
  return true;
}

/**
 * Register global listeners so a chunk import that fails OUTSIDE a React error
 * boundary (e.g. during a route navigation's preload) also self-heals. Safe to
 * call once on the client; a no-op on the server.
 */
export function installChunkErrorAutoReload(): void {
  if (typeof window === "undefined") return;
  // Vite fires this specific event when a preloaded dynamic import 404s.
  window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    reloadOnceForChunkError();
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (isModuleLoadError(event.reason)) {
      reloadOnceForChunkError();
    }
  });
}

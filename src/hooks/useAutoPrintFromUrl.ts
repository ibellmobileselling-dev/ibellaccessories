import { useEffect } from "react";
import { printWithName } from "@/lib/print";

/**
 * Reads the URL directly (not the route's typed search params) so this
 * drops into any print-capable page without needing its own validateSearch
 * schema changed — the `print=1` marker is only ever added by
 * printOrEscapeStandalone's window.open() escape from a standalone install,
 * never something a user constructs by hand.
 *
 * `ready` gates on this page's own async data actually being loaded before
 * firing — same reasoning as Sales/Purchase's existing "Save & Print" flow
 * this mirrors, which this hook does not replace there (they already handle
 * their own `print` search param) but standardizes for every other page.
 */
export function useAutoPrintFromUrl(name: string | null | undefined, ready: boolean) {
  useEffect(() => {
    if (!ready || !name) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("print") !== "1") return;
    const t = setTimeout(() => printWithName(name), 500);
    return () => clearTimeout(t);
  }, [ready, name]);
}

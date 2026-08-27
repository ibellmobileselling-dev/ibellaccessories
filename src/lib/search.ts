/**
 * One shared matcher for every search box in the app.
 *
 * The old behaviour was a plain `name.toLowerCase().includes(query)`, which
 * only ever matched a contiguous run of characters. At a counter nobody types
 * the catalogue name in order — searching "guard fan" for
 * "V-GUARD GLADO 1200MM FAN" found nothing, because those two words aren't
 * adjacent in the name. Every word the cashier types is now matched
 * independently, and anywhere in ANY of the fields the caller offers (name,
 * SKU, barcode, phone, bill number…), so partial recall from either end of
 * the name still finds the item.
 */

/** Split a query into the words that must all be found. */
function tokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * True when EVERY word in `query` appears somewhere in `fields`.
 *
 * Empty/whitespace query matches everything — callers decide whether an empty
 * box means "show the whole list" or "show nothing" (the item pickers
 * deliberately show nothing, so Enter can't act on an invisible list).
 */
export function matchesQuery(query: string, ...fields: (string | number | undefined | null)[]) {
  const words = tokens(query);
  if (!words.length) return true;
  const hay = fields
    .filter((f) => f !== undefined && f !== null && f !== "")
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * Rank matches so the most obvious answer is first — the row the cashier
 * meant is usually the one that STARTS with what they typed, not merely the
 * one that contains it somewhere. Lower score sorts first.
 */
export function matchRank(query: string, primary: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const name = primary.toLowerCase();
  if (name === q) return 0; // exact
  if (name.startsWith(q)) return 1; // prefix
  // A word inside the name starting with the query, e.g. "fan" in "GLADO FAN"
  if (name.split(/\s+/).some((w) => w.startsWith(q))) return 2;
  return 3; // matched only via the loose all-words rule
}

/** Sort a matched list by rank, then by the primary field. */
export function byRelevance<T>(query: string, primaryOf: (row: T) => string) {
  return (a: T, b: T) => {
    const ra = matchRank(query, primaryOf(a));
    const rb = matchRank(query, primaryOf(b));
    return ra - rb || primaryOf(a).localeCompare(primaryOf(b));
  };
}

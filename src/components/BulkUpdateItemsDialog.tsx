import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NumInput } from "@/components/NumInput";
import { ComboInput } from "@/components/ComboInput";
import { Search, Loader2, Filter } from "lucide-react";
import { toast } from "sonner";
import { ItemRepo, StockAdjustmentRepo } from "@/repositories";
import { newBatch, commitBatch } from "@/repositories/base";
import { useRepoMemo } from "@/hooks/useRepoData";
import { useWindowedRows } from "@/hooks/useWindowedRows";
import { usePeriodLock } from "@/hooks/usePeriodLock";
import { matchesQuery, byRelevance } from "@/lib/search";
import { today } from "@/lib/format";
import type { Item } from "@/types";

type Mode = "pricing" | "stock" | "info";

const MODES: { key: Mode; label: string }[] = [
  { key: "pricing", label: "Pricing" },
  { key: "stock", label: "Stock" },
  { key: "info", label: "Item Information" },
];

/** Which fields each tab owns. Update counts are reported per tab, so a field
 * must belong to exactly one of them. */
const MODE_FIELDS: Record<Mode, (keyof Item)[]> = {
  pricing: ["purchasePrice", "salePrice", "wholesalePrice", "gstRate"],
  stock: ["stock", "minStock"],
  info: ["name", "category", "unit", "sku", "hsn", "barcode"],
};

/** Only the fields actually changed, per item. */
type Draft = Record<string, Partial<Item>>;

/**
 * Spreadsheet-style bulk editor for the whole catalogue — Pricing, Stock and
 * Item Information on three tabs, every row editable in place, one Update
 * that commits the lot.
 *
 * Replaces the old "apply one operation to every selected item" dialog, which
 * could only do the same thing to all of them (raise every price 10%) and
 * never let a shopkeeper correct twenty different items in one sitting.
 *
 * Two things this is careful about:
 *  - STOCK is never written as an absolute value. It is the one field that
 *    every bill, return and adjustment also moves, so it goes through an
 *    atomic increment of the DIFFERENCE, exactly like the single-item stock
 *    dialog — otherwise saving this screen would silently undo any sale made
 *    while it was open. Each stock change also writes a StockAdjustment, so
 *    the movement has the same audit trail as any other correction.
 *  - Everything else merges as a patch rather than a whole-document write,
 *    so a concurrent stock change on the same item can't be clobbered.
 */
export function BulkUpdateItemsDialog({
  open,
  onOpenChange,
  onSaved,
  itemIds,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
  /** Restrict the screen to these items. Empty/undefined = the whole
   * catalogue, which is the normal way in; ticking rows on the Items page
   * first is the shortcut for "just correct these few". */
  itemIds?: string[];
}) {
  const all = useRepoMemo(() => ItemRepo.all());
  const scoped = useMemo(() => {
    if (!itemIds?.length) return all;
    const set = new Set(itemIds);
    return all.filter((i) => set.has(i.id));
  }, [all, itemIds]);
  const items = scoped;
  // Suggest from the WHOLE catalogue, not the filtered view — searching for
  // one item must not shrink the list of shelves it can be put on.
  const knownCategories = useMemo(() => all.map((i) => i.category ?? "").filter(Boolean), [all]);
  const [mode, setMode] = useState<Mode>("pricing");
  const [draft, setDraft] = useState<Draft>({});
  const [q, setQ] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const { canPost } = usePeriodLock();

  useEffect(() => {
    if (open) {
      setDraft({});
      setQ("");
      setChangedOnly(false);
      setMode("pricing");
      setSaving(false);
      savingRef.current = false;
    }
  }, [open]);

  /** Current value for a cell: the edited one if touched, else the stored one. */
  const valueOf = <K extends keyof Item>(it: Item, field: K): Item[K] => {
    const d = draft[it.id];
    return d && field in d ? (d[field] as Item[K]) : it[field];
  };

  const isDirty = (it: Item, field: keyof Item) => {
    const d = draft[it.id];
    if (!d || !(field in d)) return false;
    const next = d[field];
    const cur = it[field];
    // Treat blank/undefined and 0 as the same for optional numerics, so
    // tabbing through a field without changing it isn't counted as an edit.
    if (typeof cur === "number" || typeof next === "number") {
      return Math.abs(Number(next ?? 0) - Number(cur ?? 0)) > 0.0001;
    }
    return String(next ?? "") !== String(cur ?? "");
  };

  const setField = <K extends keyof Item>(it: Item, field: K, value: Item[K]) => {
    setDraft((prev) => {
      const next = { ...prev, [it.id]: { ...(prev[it.id] ?? {}), [field]: value } };
      return next;
    });
  };

  /** Per-tab count of items with at least one changed field on that tab. */
  const counts = useMemo(() => {
    const out: Record<Mode, number> = { pricing: 0, stock: 0, info: 0 };
    for (const it of items) {
      for (const m of MODES) {
        if (MODE_FIELDS[m.key].some((f) => isDirty(it, f))) out[m.key]++;
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, draft]);

  const totalChanged = useMemo(
    () =>
      items.filter((it) =>
        (Object.keys(MODE_FIELDS) as Mode[]).some((m) =>
          MODE_FIELDS[m].some((f) => isDirty(it, f)),
        ),
      ).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, draft],
  );

  const rows = useMemo(() => {
    let list = q.trim()
      ? items
          .filter((i) => matchesQuery(q, i.name, i.sku, i.barcode))
          .sort(byRelevance(q, (i) => i.name))
      : items;
    if (changedOnly) {
      list = list.filter((it) =>
        (Object.keys(MODE_FIELDS) as Mode[]).some((m) =>
          MODE_FIELDS[m].some((f) => isDirty(it, f)),
        ),
      );
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, q, changedOnly, draft]);

  // The whole catalogue is scrollable — no paging — but only the rows on
  // screen are mounted. Every row carries several live inputs, so mounting
  // 1,400 of them at once (~5,800 controls) is what froze this screen.
  // Windowing keeps the full scrollbar and the full list while holding only
  // ~30 rows in the DOM.
  const ROW_H = 41;
  const CARD_H = 168;
  const win = useWindowedRows(rows.length, ROW_H);
  const winMobile = useWindowedRows(rows.length, CARD_H);

  /**
   * The same two name rules the single-item form enforces, applied to a whole
   * screenful of renames.
   *
   * Renaming in bulk was added with no guard at all, which let this screen
   * blank a name or produce two items called the same thing. Duplicates are
   * the worse of the two: the item picker, the "last sale price" lookup and
   * every report then match by a name that no longer identifies one item, so
   * the list and the item's own page can genuinely disagree about it. Checked
   * against the OTHER drafts too, not just the stored catalogue — two rows
   * renamed to the same thing in one sitting collide only after saving.
   */
  const nameProblem = (): string | null => {
    const seen = new Map<string, string>();
    for (const it of items) {
      const name = String(valueOf(it, "name") ?? "").trim();
      if (!name) return `"${it.name}" — a name cannot be blank`;
      const key = name.toLowerCase();
      const other = seen.get(key);
      if (other) return `Two items would both be called "${name}" (${other} and ${it.name})`;
      seen.set(key, it.name);
    }
    return null;
  };

  const save = async () => {
    if (savingRef.current) return;
    if (!totalChanged) {
      toast.info("Nothing changed yet");
      return;
    }
    // These land as StockAdjustments dated today, which feed the stock a
    // filed return was computed from — same lock as every other movement.
    if (!canPost(today())) return;
    const bad = nameProblem();
    if (bad) {
      toast.error(`Repeat items cannot be added — ${bad}`);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const edited = items.filter((it) => draft[it.id]);
      // Firestore caps a batch at 500 operations, and a stock change costs
      // two (the item plus its audit record) — so commit in chunks rather
      // than letting a big catalogue silently blow the limit.
      const CHUNK = 200;
      let itemCount = 0;
      let stockCount = 0;
      let allCommitted = true;

      for (let i = 0; i < edited.length; i += CHUNK) {
        const batch = newBatch();
        for (const it of edited.slice(i, i + CHUNK)) {
          const patch: Partial<Item> = {};
          let touched = false;
          for (const m of Object.keys(MODE_FIELDS) as Mode[]) {
            for (const f of MODE_FIELDS[m]) {
              if (f === "stock") continue; // handled as a delta below
              if (!isDirty(it, f)) continue;
              (patch as Record<string, unknown>)[f] = draft[it.id]![f];
              touched = true;
            }
          }

          const stockDelta = isDirty(it, "stock")
            ? Math.round((Number(valueOf(it, "stock") ?? 0) - Number(it.stock ?? 0)) * 100) / 100
            : 0;
          if (!touched && stockDelta === 0) continue;

          // increment(0) is a no-op, so this same call covers "patch only",
          // "stock only" and "both" without ever writing stock absolutely.
          ItemRepo.adjustFieldBatched(batch, it.id, "stock", stockDelta, patch);
          itemCount++;

          if (stockDelta !== 0) {
            StockAdjustmentRepo.addBatched(batch, {
              itemId: it.id,
              // The EDITED name, not the stored one — renaming an item and
              // correcting its stock in the same save used to file the audit
              // row under the old name, so the item's history showed a
              // movement that no longer matched the item it belonged to.
              itemName: String(valueOf(it, "name") ?? it.name).trim() || it.name,
              date: today(),
              type: stockDelta > 0 ? "add" : "reduce",
              qty: Math.abs(stockDelta),
              reason: "Bulk update",
            });
            stockCount++;
          }
        }
        if (!(await commitBatch(batch, "bulk update items"))) allCommitted = false;
      }

      // Never claim success for writes the cloud rejected. The cache is
      // updated as each write is staged, so the screen behind this dialog
      // would show the new numbers for a moment and then snap back when
      // Firestore's rollback arrives — which reads as "the app changed my
      // stock and then lost it".
      if (!allCommitted) {
        toast.error(
          "Some changes did not reach the cloud — reload the app and check those items before trying again",
        );
        return;
      }

      toast.success(
        `Updated ${itemCount} item${itemCount === 1 ? "" : "s"}` +
          (stockCount
            ? ` · ${stockCount} stock adjustment${stockCount === 1 ? "" : "s"} recorded`
            : ""),
      );
      onSaved();
      onOpenChange(false);
    } catch (err) {
      console.error("Bulk update failed", err);
      toast.error("Could not save the changes — check your connection and try again");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const cellCls = (dirty: boolean) =>
    `w-full h-8 px-2 text-sm border rounded bg-background outline-none focus:border-primary ${
      dirty ? "border-primary ring-1 ring-primary/30 font-semibold" : "border-input"
    }`;

  /** The editable cells for one item, per tab — shared by the desktop table
   * and the phone card list so the two can't drift apart. */
  const numCell = (it: Item, field: keyof Item, align = "text-right") => (
    <NumInput
      value={Number(valueOf(it, field) ?? 0)}
      onValue={(n) => setField(it, field, n as Item[keyof Item])}
      className={`${cellCls(isDirty(it, field))} ${align} tabular-nums`}
    />
  );
  /** Category gets the same searchable picker the item form has — this grid
   *  is where a whole catalogue gets re-shelved, so it is the likeliest place
   *  to invent a third spelling of a category that already exists. */
  const comboCell = (it: Item, field: keyof Item, options: string[], placeholder = "") => (
    <ComboInput
      value={String(valueOf(it, field) ?? "")}
      onValue={(v) => setField(it, field, v as Item[keyof Item])}
      options={options}
      placeholder={placeholder}
      ariaLabel={`${String(field)} for ${it.name}`}
      className={cellCls(isDirty(it, field))}
    />
  );

  const textCell = (it: Item, field: keyof Item, placeholder = "") => (
    <input
      value={String(valueOf(it, field) ?? "")}
      placeholder={placeholder}
      onChange={(e) => setField(it, field, e.target.value as Item[keyof Item])}
      className={cellCls(isDirty(it, field))}
    />
  );

  const COLUMNS: Record<
    Mode,
    { label: string; width?: string; cell: (it: Item) => ReactElement }[]
  > = {
    pricing: [
      { label: "Purchase Price", width: "w-32", cell: (it) => numCell(it, "purchasePrice") },
      { label: "Sale Price", width: "w-32", cell: (it) => numCell(it, "salePrice") },
      { label: "Wholesale Price", width: "w-32", cell: (it) => numCell(it, "wholesalePrice") },
      { label: "GST %", width: "w-24", cell: (it) => numCell(it, "gstRate") },
    ],
    stock: [
      { label: "Stock", width: "w-28", cell: (it) => numCell(it, "stock") },
      { label: "Min Stock", width: "w-28", cell: (it) => numCell(it, "minStock") },
    ],
    info: [
      {
        label: "Category",
        width: "w-40",
        cell: (it) => comboCell(it, "category", knownCategories, "Search or add…"),
      },
      { label: "Unit", width: "w-24", cell: (it) => textCell(it, "unit", "pcs") },
      { label: "SKU", width: "w-32", cell: (it) => textCell(it, "sku", "—") },
      { label: "HSN", width: "w-28", cell: (it) => textCell(it, "hsn", "—") },
      { label: "Barcode", width: "w-36", cell: (it) => textCell(it, "barcode", "—") },
    ],
  };

  const cols = COLUMNS[mode];

  return (
    <Dialog open={open} onOpenChange={(v) => !saving && onOpenChange(v)}>
      <DialogContent className="max-w-[min(1200px,96vw)] h-[92vh] p-0 flex flex-col gap-0">
        {/* The dialog's own close button is absolutely positioned at
            right-4/top-4, so the header must leave room for it — the tab
            group ran straight underneath the X. Padding is asymmetric on
            purpose: on a phone the tabs sit on their own row below the
            title and need the full width, so only the wider layout, where
            the tabs are inline and reach the corner, gets the clearance. */}
        <DialogHeader className="pl-4 sm:pl-5 pr-4 sm:pr-14 py-3 border-b">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <DialogTitle className="text-[15px] sm:text-[17px]">Bulk Update Items</DialogTitle>
            {/* Tabs sit top-right on desktop and stack full-width on a phone,
                where a 3-up radio row would be too small to hit reliably. */}
            <div
              role="radiogroup"
              aria-label="What to update"
              className="grid grid-cols-3 sm:flex rounded-md border border-input overflow-hidden shrink-0"
            >
              {MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.key}
                  onClick={() => setMode(m.key)}
                  className={`h-8 px-3 text-xs font-semibold transition whitespace-nowrap ${
                    mode === m.key
                      ? "bg-primary text-primary-foreground"
                      : "bg-background text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {m.label}
                  {counts[m.key] > 0 && (
                    <span
                      className={`ml-1.5 rounded px-1 text-[10px] ${
                        mode === m.key ? "bg-white/25" : "bg-primary/10 text-primary"
                      }`}
                    >
                      {counts[m.key]}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </DialogHeader>

        <div className="px-4 sm:px-5 py-2 border-b flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search items…"
              className="w-full h-8 pl-8 pr-3 border border-input rounded-md text-base md:text-[13px] bg-background outline-none focus:border-primary"
            />
          </div>
          <button
            type="button"
            onClick={() => setChangedOnly((v) => !v)}
            className={`h-8 px-3 rounded-md border text-xs font-semibold inline-flex items-center gap-1.5 transition ${
              changedOnly
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-input hover:bg-accent"
            }`}
          >
            <Filter className="h-3.5 w-3.5" />
            Changed only
          </button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {rows.length} item{rows.length === 1 ? "" : "s"}
            {itemIds?.length ? " (selected only)" : ""}
          </span>
        </div>

        {/* Desktop grid */}
        <div ref={win.ref} onScroll={win.onScroll} className="hidden md:block flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-muted/95 backdrop-blur text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-10 py-2 px-3 text-left font-semibold">#</th>
                <th className="py-2 px-3 text-left font-semibold">Item Name</th>
                {cols.map((c) => (
                  <th
                    key={c.label}
                    className={`py-2 px-2 text-left font-semibold ${c.width ?? ""}`}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {win.padTop > 0 && (
                <tr style={{ height: win.padTop }} aria-hidden>
                  <td colSpan={cols.length + 2} />
                </tr>
              )}
              {rows.slice(win.start, win.end).map((it, i) => (
                <tr key={it.id} className="border-t hover:bg-accent/30" style={{ height: ROW_H }}>
                  <td className="px-3 py-1.5 text-[11px] text-muted-foreground tabular-nums">
                    {win.start + i + 1}
                  </td>
                  <td className="px-2 py-1.5">
                    {/* Editable: renaming in bulk is the whole point of a
                        spreadsheet view, and it was read-only before. */}
                    <input
                      value={String(valueOf(it, "name") ?? "")}
                      onChange={(e) => setField(it, "name", e.target.value)}
                      className={cellCls(isDirty(it, "name"))}
                    />
                  </td>
                  {cols.map((c) => (
                    <td key={c.label} className="px-2 py-1.5">
                      {c.cell(it)}
                    </td>
                  ))}
                </tr>
              ))}
              {win.padBottom > 0 && (
                <tr style={{ height: win.padBottom }} aria-hidden>
                  <td colSpan={cols.length + 2} />
                </tr>
              )}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={cols.length + 2} className="py-16 text-center text-muted-foreground">
                    No items match
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Phone: a card per item — a 7-column grid is unusable on a phone,
            and this screen has to feel like the rest of the mobile app. */}
        <div
          ref={winMobile.ref}
          onScroll={winMobile.onScroll}
          className="md:hidden flex-1 overflow-auto divide-y"
        >
          {winMobile.padTop > 0 && <div style={{ height: winMobile.padTop }} aria-hidden />}
          {rows.slice(winMobile.start, winMobile.end).map((it, i) => (
            <div key={it.id} className="p-3" style={{ height: CARD_H }}>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {winMobile.start + i + 1}
                </span>
                <input
                  value={String(valueOf(it, "name") ?? "")}
                  onChange={(e) => setField(it, "name", e.target.value)}
                  className={`${cellCls(isDirty(it, "name"))} font-semibold`}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                {cols.map((c) => (
                  <label key={c.label} className="block">
                    <span className="block text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                      {c.label}
                    </span>
                    {c.cell(it)}
                  </label>
                ))}
              </div>
            </div>
          ))}
          {winMobile.padBottom > 0 && <div style={{ height: winMobile.padBottom }} aria-hidden />}
          {rows.length === 0 && (
            <div className="py-16 text-center text-muted-foreground">No items match</div>
          )}
        </div>

        <div className="border-t px-4 sm:px-5 py-3 flex flex-col sm:flex-row sm:items-center gap-3 bg-muted/40">
          <p className="text-xs text-muted-foreground flex-1">
            {MODES.map((m, i) => (
              <span key={m.key}>
                {i > 0 && " · "}
                <span className="font-semibold text-foreground">{m.label}</span> — {counts[m.key]}{" "}
                update{counts[m.key] === 1 ? "" : "s"}
              </span>
            ))}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDraft({})}
              disabled={saving || !totalChanged}
            >
              Reset
            </Button>
            <Button type="button" onClick={save} disabled={saving || !totalChanged}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Update{totalChanged ? ` (${totalChanged})` : ""}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

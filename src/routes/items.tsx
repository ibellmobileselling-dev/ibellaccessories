import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { matchesQuery } from "@/lib/search";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
import { usePagination } from "@/hooks/usePagination";
import { usePeriodLock } from "@/hooks/usePeriodLock";
import { useAutoFocusOnDesktop } from "@/hooks/use-mobile";
import {
  ItemRepo,
  StockAdjustmentRepo,
  SalesRepo,
  PurchaseRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
} from "@/repositories";
import { useRepoData, useRepoMemo } from "@/hooks/useRepoData";
import { useStickyState } from "@/hooks/useStickySearch";
import { BulkUpdateItemsDialog } from "@/components/BulkUpdateItemsDialog";
import { newBatch, commitBatch } from "@/repositories/base";
import type { Item } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/Field";
import { ComboInput } from "@/components/ComboInput";
import { NumField } from "@/components/NumInput";
import { fmtMoney, today } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";
import { parseImportFile, normalizeHeader } from "@/lib/sheetImport";
import {
  Plus,
  Search,
  ArrowUpDown,
  Pencil,
  History,
  Download,
  Upload,
  Package,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { usePermissions } from "@/hooks/usePermissions";

/** Bulk import/export columns — kept in lockstep with the New/Edit Item form
 * fields (Name, Category, Purchase/Sale/Wholesale Price, Min/Opening Stock).
 * No SKU/Barcode/Unit/GST Rate/HSN — those aren't part of this client's
 * item data model anywhere else in the app. */
const BULK_COLUMNS = [
  "Name",
  "Category",
  "Purchase Price",
  "Sale Price",
  "Wholesale Price",
  "Min Stock",
  "Opening Stock",
] as const;

/** Full export adds read-only Current Stock — not in BULK_COLUMNS/the import
 * template since it's ignored on re-import (stock only changes via Opening
 * Stock for new items, or the audited Stock Adjustment flow). */
const EXPORT_COLUMNS = [...BULK_COLUMNS, "Current Stock"] as const;

function itemToBulkRow(it: Item): string[] {
  return [
    it.name,
    it.category ?? "",
    String(it.purchasePrice ?? 0),
    String(it.salePrice ?? 0),
    it.wholesalePrice != null ? String(it.wholesalePrice) : "",
    it.minStock != null ? String(it.minStock) : "",
    String(it.openingStock ?? 0),
    String(it.stock ?? 0),
  ];
}

export const Route = createFileRoute("/items")({ component: ItemsPage });

function ItemsPage() {
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  useAutoFocusOnDesktop(searchRef);
  const { isOwner, canEdit, canDelete } = usePermissions();
  const editAllowed = isOwner || canEdit("masterData");
  const deleteAllowed = isOwner || canDelete("masterData");
  const [rows, setRows] = useState<Item[]>([]);
  const [q, setQ] = useStickyState("items.search", "");
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Item | null>(null);
  const [adjustItem, setAdjustItem] = useState<Item | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);

  const refresh = () => setRows(ItemRepo.all());
  const _repoV = useRepoData();
  useEffect(refresh, [_repoV]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing =
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
      if (!typing && !adjustItem && e.key === "n") {
        e.preventDefault();
        setEdit(null);
        setOpen(true);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [adjustItem]);

  const filtered = rows.filter((r) => {
    const s = q.toLowerCase();
    return !s || matchesQuery(s, r.name, r.sku) || r.barcode?.includes(s);
  });

  const pg = usePagination(filtered, "items");

  const columns: Column<Item>[] = [
    {
      key: "name",
      label: "Name",
      render: (r) => <span className="font-medium">{r.name}</span>,
      sortValue: (r) => r.name,
    },
    { key: "category", label: "Category", width: "140px", render: (r) => r.category ?? "—" },
    {
      key: "purchase",
      label: "Purchase Price",
      width: "130px",
      align: "right",
      render: (r) => fmtMoney(r.purchasePrice),
    },
    {
      key: "sale",
      label: "Sale Price",
      width: "130px",
      align: "right",
      render: (r) => fmtMoney(r.salePrice),
      sortValue: (r) => r.salePrice,
    },
    {
      key: "stock",
      label: "Stock",
      width: "100px",
      align: "right",
      render: (r) => {
        // minStock=0 is a valid "alert exactly at zero" threshold — must not
        // be treated the same as "no threshold set" (which `&&` would do).
        const low = (r.minStock != null && r.stock <= r.minStock) || r.stock < 0;
        return (
          <span className={low ? "text-warning font-medium" : ""}>
            {r.stock} {r.unit}
          </span>
        );
      },
      sortValue: (r) => r.stock,
    },
    {
      key: "adjust",
      label: "Action",
      width: "110px",
      align: "center",
      render: (r) => (
        <span className="inline-flex items-center justify-center gap-0.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate({ to: "/items/$id", params: { id: r.id } });
            }}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-primary-soft hover:text-primary hover:border-primary/25"
            title="View details & history"
          >
            <History className="h-3.5 w-3.5" />
          </button>
          {editAllowed && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEdit(r);
                setOpen(true);
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-primary-soft hover:text-primary hover:border-primary/25"
              title="Edit item"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {editAllowed && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setAdjustItem(r);
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-primary-soft hover:text-primary hover:border-primary/25"
              title="Adjust stock (damage, counting correction…)"
            >
              <ArrowUpDown className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Items"
        subtitle={`${rows.length} items`}
        icon={<Package className="h-5 w-5" />}
        actions={
          <>
            <div className="relative w-full sm:w-44 lg:w-56">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                ref={searchRef}
                placeholder="Search items by name..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-full h-8 pl-8 pr-3 border border-gray-200 rounded-md text-base md:text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
              />
            </div>
            {/* Bulk import/export are desktop power-user actions — hidden
                entirely on mobile instead of just losing their label, so the
                header's one remaining button (New Item) gets a clean row of
                its own instead of three cramped icon buttons competing for
                space. */}
            <Button
              size="sm"
              variant="outline"
              onClick={() => downloadCsv("items", [...EXPORT_COLUMNS], rows.map(itemToBulkRow))}
              title="Export CSV"
              className="hidden sm:inline-flex"
            >
              <Download className="h-3.5 w-3.5" /> Export CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setBulkOpen(true)}
              title="Bulk Import"
              className="hidden sm:inline-flex"
            >
              <Upload className="h-3.5 w-3.5" /> Bulk Import
            </Button>
            {/* Reachable without ticking anything first — with no selection
                it opens on the whole catalogue, which is the usual way in. */}
            {editAllowed && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setBulkEditOpen(true)}
                title="Bulk Update Items"
                className="w-full sm:w-auto"
              >
                <Pencil className="h-3.5 w-3.5" /> Bulk Update
              </Button>
            )}
            {editAllowed && (
              <Button
                size="sm"
                onClick={() => {
                  setEdit(null);
                  setOpen(true);
                }}
                className="w-full sm:w-auto"
              >
                <Plus className="h-3.5 w-3.5" /> New Item
              </Button>
            )}
          </>
        }
      />
      {/* Mobile card list — a table of 6 columns doesn't fit a phone; this
          is the same data as one tappable card per item instead. */}
      <div className="md:hidden flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <Package className="h-10 w-10 mx-auto mb-3 text-gray-200" />
            <p className="font-medium">No items found</p>
            <p className="text-xs mt-1">Try adjusting your search or add a new item</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pg.paged.map((r) => {
              const low = (r.minStock != null && r.stock <= r.minStock) || r.stock < 0;
              return (
                <div
                  key={r.id}
                  onClick={() => navigate({ to: "/items/$id", params: { id: r.id } })}
                  className="bg-white p-4 active:bg-gray-50"
                >
                  <div className="flex items-start justify-between gap-3 mb-1.5">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-800 truncate">{r.name}</p>
                      <p className="text-xs text-gray-400 mt-0.5 truncate">
                        {r.category ?? "No category"}
                      </p>
                    </div>
                    <p className="font-bold text-gray-800 tabular-nums shrink-0">
                      {fmtMoney(r.salePrice)}
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className={`text-xs font-semibold ${low ? "text-warning" : "text-gray-500"}`}
                    >
                      {r.stock} {r.unit} in stock
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate({ to: "/items/$id", params: { id: r.id } });
                        }}
                        className="p-1.5 rounded hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition"
                        title="View details & history"
                      >
                        <History className="h-3.5 w-3.5" />
                      </button>
                      {editAllowed && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEdit(r);
                            setOpen(true);
                          }}
                          className="p-1.5 rounded hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition"
                          title="Edit item"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {editAllowed && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setAdjustItem(r);
                          }}
                          className="p-1.5 rounded hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition"
                          title="Adjust stock (damage, counting correction…)"
                        >
                          <ArrowUpDown className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Table (desktop) */}
      <div className="hidden md:flex flex-1 min-h-0 p-6">
        <DataTable
          storageKey="items"
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.id}
          activateOnClick
          onRowActivate={(r) => navigate({ to: "/items/$id", params: { id: r.id } })}
          onDelete={(r) => {
            if (!deleteAllowed) {
              toast.error("You don't have permission to delete items");
              return;
            }
            // An item that still appears on any bill/return can't be safely
            // removed: its stock movements would orphan (Inventory & Stock
            // reports drop it silently), its history page would 404, and
            // editing/deleting one of those old bills later would skip the
            // stock reversal for it entirely. Block it — same protection
            // parties and payees already have.
            const onDoc =
              // allWithVoided: a cancelled bill still names this item, and
              // its cost is still what the ledger reversed. Deleting the item
              // would break the stock and profit history of those records —
              // which is exactly what this guard exists to prevent.
              SalesRepo.allWithVoided().some((i) => i.lineItems.some((l) => l.itemId === r.id)) ||
              PurchaseRepo.allWithVoided().some((i) =>
                i.lineItems.some((l) => l.itemId === r.id),
              ) ||
              SaleReturnRepo.allWithVoided().some((i) =>
                i.lineItems.some((l) => l.itemId === r.id),
              ) ||
              PurchaseReturnRepo.allWithVoided().some((i) =>
                i.lineItems.some((l) => l.itemId === r.id),
              ) ||
              StockAdjustmentRepo.all().some((a) => a.itemId === r.id);
            if (onDoc) {
              toast.error(
                `Can't delete "${r.name}" — it's used on bills, returns or stock adjustments. Deleting it would break stock and profit reports for those records.`,
              );
              return;
            }
            if (confirm(`Delete ${r.name}?`)) {
              ItemRepo.remove(r.id);
              refresh();
              toast.success("Item deleted");
            }
          }}
        />
      </div>
      <ItemDialog open={open} onOpenChange={setOpen} item={edit} onSaved={refresh} />
      <BulkImportDialog open={bulkOpen} onOpenChange={setBulkOpen} onSaved={refresh} />
      <BulkUpdateItemsDialog open={bulkEditOpen} onOpenChange={setBulkEditOpen} onSaved={refresh} />
      <StockAdjustDialog
        item={adjustItem}
        onOpenChange={(v) => {
          if (!v) setAdjustItem(null);
        }}
        onSaved={refresh}
      />
    </div>
  );
}

export function StockAdjustDialog({
  item,
  onOpenChange,
  onSaved,
}: {
  item: Item | null;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<"add" | "reduce">("add");
  const { canPost } = usePeriodLock();
  const [qty, setQty] = useState(0);
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  // Synchronous double-submit guard — `saving` state doesn't update until the
  // next render, so two rapid submits in the same tick both see it false.
  const savingRef = useRef(false);

  useEffect(() => {
    if (item) {
      setType("add");
      setQty(0);
      setDate(today());
      setReason("");
      setSaving(false);
      savingRef.current = false;
    }
  }, [item]);

  if (!item) return null;
  const n = qty;
  const newStock = Math.round((item.stock + (type === "add" ? n : -n)) * 100) / 100;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (savingRef.current) return;
    if (n <= 0) {
      toast.error("Enter quantity to adjust");
      return;
    }
    if (!canPost(date)) return;
    savingRef.current = true;
    setSaving(true);
    // Stock change + its audit record commit together as one atomic batch —
    // otherwise a partial failure could move stock with no audit trail (or
    // vice versa).
    const batch = newBatch();
    ItemRepo.adjustFieldBatched(batch, item.id, "stock", type === "add" ? n : -n);
    StockAdjustmentRepo.addBatched(batch, {
      itemId: item.id,
      itemName: item.name,
      date,
      type,
      qty: n,
      reason: reason.trim() || undefined,
    });
    commitBatch(batch, "stock adjustment");
    toast.success(
      `${item.name}: stock ${type === "add" ? "increased" : "reduced"} by ${n} → now ${newStock} ${item.unit}`,
    );
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={!!item} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust Stock — {item.name}</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Current stock:{" "}
            <span className="font-bold text-foreground">
              {item.stock} {item.unit}
            </span>
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setType("add")}
              className={`flex-1 h-9 rounded-md border text-sm font-semibold transition ${type === "add" ? "bg-success-soft text-success border-success" : "bg-background text-muted-foreground"}`}
            >
              + Add Stock
            </button>
            <button
              type="button"
              onClick={() => setType("reduce")}
              className={`flex-1 h-9 rounded-md border text-sm font-semibold transition ${type === "reduce" ? "bg-destructive/10 text-destructive border-destructive" : "bg-background text-muted-foreground"}`}
            >
              − Reduce Stock
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <NumField label={`Quantity (${item.unit}) *`} value={qty} onValue={setQty} />
            <Field
              label="Date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <Field
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Damaged, counting correction, sample…"
          />
          {n > 0 && (
            <p className="text-sm">
              New stock will be:{" "}
              <span className={`font-bold ${newStock < 0 ? "text-destructive" : "text-success"}`}>
                {newStock} {item.unit}
              </span>
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Adjust Stock"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ItemDialog({
  open,
  onOpenChange,
  item,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  item: Item | null;
  onSaved: () => void;
}) {
  const firstRef = useRef<HTMLInputElement>(null);
  const [f, setF] = useState<Partial<Item>>({});
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [nameOpen, setNameOpen] = useState(false);
  // Every category already in use, so the shelf a shopkeeper means is one
  // keystroke away instead of being retyped — and re-typed differently.
  const knownCategories = useRepoMemo(() =>
    ItemRepo.all()
      .map((i) => i.category ?? "")
      .filter(Boolean),
  );

  useEffect(() => {
    if (open) {
      setF(
        item ?? {
          unit: "pcs",
          gstRate: 0,
          purchasePrice: 0,
          salePrice: 0,
          stock: 0,
          openingStock: 0,
        },
      );
      setSaving(false);
      savingRef.current = false;
      setNameOpen(false);
      setTimeout(() => firstRef.current?.focus(), 50);
    }
  }, [open, item]);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (savingRef.current) return;
    if (!f.name?.trim()) {
      toast.error("Name required");
      return;
    }
    // Repeat items cannot be added — block duplicate names (also when renaming)
    const dup = ItemRepo.all().find(
      (x) => x.name.trim().toLowerCase() === f.name!.trim().toLowerCase() && x.id !== item?.id,
    );
    if (dup) {
      toast.error(`Item "${dup.name}" already exists — repeat items cannot be added`);
      return;
    }
    if ((f.purchasePrice ?? 0) < 0 || (f.salePrice ?? 0) < 0 || (f.wholesalePrice ?? 0) < 0) {
      toast.error("Prices cannot be negative");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    if (item) {
      // Correcting opening stock shifts current stock by the same difference.
      // Apply the descriptive fields AND the opening-stock delta in ONE atomic
      // write via adjustField's `extra` merge: it increments stock rather than
      // full-doc-overwriting it, so a sale/return that changed this item's
      // stock while the dialog was open is preserved, not clobbered by a stale
      // snapshot. (A full-doc updateBatched would re-write the cached stock.)
      const openingDelta = (f.openingStock ?? 0) - (item.openingStock ?? 0);
      const patch: Partial<Item> = { ...f };
      delete patch.stock; // stock only changes via atomic increments
      ItemRepo.adjustField(item.id, "stock", openingDelta, patch);
      toast.success(
        openingDelta !== 0
          ? `Item updated — stock adjusted by ${openingDelta > 0 ? "+" : ""}${openingDelta}`
          : "Item updated",
      );
    } else {
      ItemRepo.add({
        ...f,
        name: f.name!,
        unit: f.unit ?? "pcs",
        gstRate: f.gstRate ?? 0,
        purchasePrice: f.purchasePrice ?? 0,
        salePrice: f.salePrice ?? 0,
        stock: f.openingStock ?? 0,
        openingStock: f.openingStock ?? 0,
      });
      toast.success("Item created");
    }
    onSaved();
    onOpenChange(false);
  };

  // Live "does this already exist?" hint — the exact-match case is hard
  // blocked on save, but a near-match (extra word, different spacing) isn't
  // an error, just something the client asked to be warned about before
  // they commit to a possible duplicate.
  const nameQ = (f.name ?? "").trim().toLowerCase();
  const similarItemsAll = nameQ
    ? ItemRepo.all().filter((x) => x.id !== item?.id && x.name.trim().toLowerCase().includes(nameQ))
    : [];
  const similarItems = similarItemsAll.slice(0, 5);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{item ? "Edit Item" : "New Item"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2 relative">
            <Field
              ref={firstRef}
              label="Name *"
              value={f.name ?? ""}
              onChange={(e) => {
                setF({ ...f, name: e.target.value });
                setNameOpen(true);
              }}
              onFocus={() => setNameOpen(true)}
              onBlur={() => setTimeout(() => setNameOpen(false), 150)}
              autoComplete="off"
            />
            {nameOpen && similarItems.length > 0 && (
              <div className="absolute z-30 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-elevated max-h-52 overflow-auto">
                <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 bg-amber-50 border-b flex items-center gap-1.5">
                  <AlertTriangle className="h-3 w-3" />
                  {similarItemsAll.length === 1 ? "Similar item exists" : "Similar items exist"} —
                  check before saving
                </div>
                {similarItems.map((x) => (
                  <div key={x.id} className="px-3 py-2 text-sm flex items-center justify-between">
                    <span className="font-medium">{x.name}</span>
                    <span className="text-[11px] text-muted-foreground">
                      Stock: {x.stock} {x.unit}
                    </span>
                  </div>
                ))}
                {similarItemsAll.length > similarItems.length && (
                  <div className="px-3 py-1.5 text-[11px] text-muted-foreground border-t">
                    +{similarItemsAll.length - similarItems.length} more match
                    {similarItemsAll.length - similarItems.length > 1 ? "es" : ""}
                  </div>
                )}
              </div>
            )}
          </div>
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="text-muted-foreground font-medium">Category</span>
            <ComboInput
              value={f.category ?? ""}
              onValue={(v) => setF({ ...f, category: v })}
              options={knownCategories}
              ariaLabel="Category"
              placeholder="Search or add…"
              className="h-8 px-2 border rounded bg-background outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </label>
          <NumField
            label="Purchase Price"
            value={f.purchasePrice ?? 0}
            onValue={(n) => setF({ ...f, purchasePrice: n })}
          />
          <NumField
            label="Sale Price *"
            value={f.salePrice ?? 0}
            onValue={(n) => setF({ ...f, salePrice: n })}
          />
          <NumField
            label="Wholesale Price"
            value={f.wholesalePrice ?? 0}
            onValue={(n) => setF({ ...f, wholesalePrice: n || undefined })}
          />
          <NumField
            label="Opening Stock"
            value={f.openingStock ?? 0}
            onValue={(n) => setF({ ...f, openingStock: n })}
          />
          <Field
            label="Min Stock (low-stock alert)"
            type="text"
            inputMode="decimal"
            value={f.minStock ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              // Digits + at most one dot, same filter NumInput uses — plain
              // type="number" has a known Safari bug where clearing the
              // field can leave it stuck showing 0 with backspace unable to
              // remove it, which is exactly why every other numeric field in
              // the app avoids it. Kept as its own Field (not NumField) since
              // "" || undefined here would also swallow a deliberately
              // entered 0 (alert exactly when stock runs out) — only an
              // empty field should mean "no threshold set".
              if (!/^\d*\.?\d*$/.test(v)) return;
              setF({ ...f, minStock: v === "" ? undefined : Math.max(0, parseFloat(v) || 0) });
            }}
          />
          <div className="sm:col-span-3 flex justify-end gap-2 mt-2">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface PreviewRow {
  rowNum: number;
  name: string;
  category?: string;
  purchasePrice: number;
  salePrice: number;
  wholesalePrice?: number;
  minStock?: number;
  openingStock: number;
  status: "new" | "update" | "error" | "duplicate";
  matchId?: string;
  error?: string;
}

const HEADER_ALIASES: Record<string, string[]> = {
  name: ["name", "itemname"],
  category: ["category"],
  purchasePrice: ["purchaseprice", "purchase"],
  salePrice: ["saleprice", "sale", "price"],
  wholesalePrice: ["wholesaleprice", "wholesale"],
  minStock: ["minstock", "min"],
  openingStock: ["openingstock", "opening", "stock"],
};

/** Turn a parsed bulk-import table (from CSV or an Excel sheet) into preview
 * rows, matching each against existing items by Name (same rule the New/Edit
 * Item form already uses to block duplicates), and flagging errors / in-file
 * duplicates. */
function buildPreview(table: string[][], existing: Item[]): PreviewRow[] {
  if (table.length < 2) return [];

  const header = table[0].map(normalizeHeader);
  const colIndex: Partial<Record<string, number>> = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx >= 0) colIndex[key] = idx;
  }
  const cell = (row: string[], key: string) => {
    const idx = colIndex[key];
    return idx != null ? (row[idx] ?? "").trim() : "";
  };
  const num = (s: string, fallback = 0) => {
    if (!s) return fallback;
    const n = parseFloat(s.replace(/,/g, ""));
    return isNaN(n) ? fallback : n;
  };

  const seenNew = new Map<string, number>(); // lower-case name -> rowNum
  const out: PreviewRow[] = [];

  for (let i = 1; i < table.length; i++) {
    const row = table[i];
    if (row.every((c) => !c.trim())) continue;
    const rowNum = i + 1; // 1-based, counting the header row
    const name = cell(row, "name");
    const wholesaleRaw = cell(row, "wholesalePrice");
    const minStockRaw = cell(row, "minStock");

    const rec: PreviewRow = {
      rowNum,
      name,
      category: cell(row, "category") || undefined,
      purchasePrice: num(cell(row, "purchasePrice"), 0),
      salePrice: num(cell(row, "salePrice"), 0),
      wholesalePrice: wholesaleRaw ? num(wholesaleRaw) : undefined,
      minStock: minStockRaw !== "" ? num(minStockRaw) : undefined,
      openingStock: num(cell(row, "openingStock"), 0),
      status: "new",
    };

    if (!name) {
      out.push({ ...rec, status: "error", error: "Name is required" });
      continue;
    }
    if (rec.purchasePrice < 0 || rec.salePrice < 0 || (rec.wholesalePrice ?? 0) < 0) {
      out.push({ ...rec, status: "error", error: "Prices cannot be negative" });
      continue;
    }

    // A name repeated within the file is a normal human slip, not something to
    // scold the user over — it's quietly marked "duplicate" and skipped (the
    // first occurrence is kept), so the rest of the file still imports. This is
    // distinct from a real "error" (missing name / negative price) that the
    // user actually needs to fix. Either way a name is never imported twice.
    const dupKey = name.toLowerCase();
    const dupRow = seenNew.get(dupKey);
    if (dupRow) {
      out.push({ ...rec, status: "duplicate", error: `Same name as row ${dupRow} — skipped` });
      continue;
    }
    seenNew.set(dupKey, rowNum);

    const match = existing.find((it) => it.name.trim().toLowerCase() === dupKey);
    if (match) {
      rec.status = "update";
      rec.matchId = match.id;
    } else {
      rec.status = "new";
    }
    out.push(rec);
  }
  return out;
}

function BulkImportDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (open) {
      setRows([]);
      setFileName("");
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [open]);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    // Shared parser — handles .xlsx (incl. the WPS truncated-range quirk) and
    // CSV/UTF-16 identically for both item and party import (see sheetImport).
    const table = await parseImportFile(file);
    if (!table.length) {
      toast.error("File looks empty or unreadable — export it as CSV/Excel and try again");
      setRows([]);
      return;
    }
    const header = table[0].map(normalizeHeader);
    if (!HEADER_ALIASES.name.some((a) => header.includes(a))) {
      toast.error(
        `No "Name" column found. First row of your file: "${table[0].join(", ").slice(0, 100)}" — download the Sample CSV to see the expected format`,
      );
      setRows([]);
      return;
    }
    setRows(buildPreview(table, ItemRepo.all()));
  };

  const newCount = rows.filter((r) => r.status === "new").length;
  const updateCount = rows.filter((r) => r.status === "update").length;
  const errorCount = rows.filter((r) => r.status === "error").length;
  const dupCount = rows.filter((r) => r.status === "duplicate").length;

  const doImport = async () => {
    // Only new/update rows import — "duplicate" and "error" rows are skipped.
    const valid = rows.filter((r) => r.status === "new" || r.status === "update");
    if (!valid.length || importing) return;
    setImporting(true);
    try {
      let committed = true;
      for (let i = 0; i < valid.length; i += 400) {
        const chunk = valid.slice(i, i + 400);
        const batch = newBatch();
        for (const r of chunk) {
          if (r.status === "update" && r.matchId) {
            // Descriptive/pricing fields only — bulk update never touches
            // stock, which stays governed by the audited adjustment flow.
            ItemRepo.updateBatched(batch, r.matchId, {
              name: r.name,
              category: r.category,
              purchasePrice: r.purchasePrice,
              salePrice: r.salePrice,
              wholesalePrice: r.wholesalePrice,
              minStock: r.minStock,
            });
          } else {
            ItemRepo.addBatched(batch, {
              name: r.name,
              category: r.category,
              unit: "pcs",
              gstRate: 0,
              purchasePrice: r.purchasePrice,
              salePrice: r.salePrice,
              wholesalePrice: r.wholesalePrice,
              minStock: r.minStock,
              stock: r.openingStock,
              openingStock: r.openingStock,
            } as Omit<Item, "id" | "createdAt">);
          }
        }
        if (!(await commitBatch(batch, "bulk import"))) committed = false;
      }
      // A rejected commit must not be reported as an import. The cache is
      // updated as each write is staged, so the screen would show rows the
      // cloud never accepted until the next snapshot took them away again.
      if (!committed) {
        toast.error(
          "Some rows did not reach the cloud — reload the app and check before importing again",
        );
        return;
      }
      toast.success(
        `Imported: ${newCount} new, ${updateCount} updated` +
          (errorCount ? `, ${errorCount} skipped (errors)` : ""),
      );
      onSaved();
      onOpenChange(false);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Bulk Import Items</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-muted-foreground max-w-lg">
              Matches by <b>Name</b> — matched rows update the existing item, unmatched rows create
              a new one. Stock is only set for new items; existing items' stock is never changed by
              bulk import.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => downloadCsv("items-template", [...BULK_COLUMNS], [])}
            >
              <Download className="h-3.5 w-3.5" /> Sample CSV
            </Button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,text/comma-separated-values,application/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain"
            onChange={onFile}
            className="text-sm file:mr-3 file:h-8 file:px-3 file:rounded-md file:border file:bg-background file:text-sm file:font-medium file:cursor-pointer"
          />
          {fileName && rows.length === 0 && (
            <p className="text-sm text-destructive">No valid rows found in {fileName}.</p>
          )}
          {rows.length > 0 && (
            <>
              <div className="flex gap-4 text-sm">
                <span className="text-success font-medium">{newCount} new</span>
                <span className="text-primary font-medium">{updateCount} update</span>
                {dupCount > 0 && (
                  <span className="text-amber-600 font-medium">
                    {dupCount} duplicate{dupCount > 1 ? "s" : ""} (skipped)
                  </span>
                )}
                {errorCount > 0 && (
                  <span className="text-destructive font-medium">
                    {errorCount} error{errorCount > 1 ? "s" : ""} (skipped)
                  </span>
                )}
              </div>
              <div className="border rounded max-h-80 overflow-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className="sticky top-0 z-10 bg-muted text-left p-1.5">Row</th>
                      <th className="sticky top-0 z-10 bg-muted text-left p-1.5">Name</th>
                      <th className="sticky top-0 z-10 bg-muted text-left p-1.5">Category</th>
                      <th className="sticky top-0 z-10 bg-muted text-right p-1.5">Sale Price</th>
                      <th className="sticky top-0 z-10 bg-muted text-right p-1.5">Opening Stock</th>
                      <th className="sticky top-0 z-10 bg-muted text-left p-1.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.rowNum} className="border-t">
                        <td className="p-1.5">{r.rowNum}</td>
                        <td className="p-1.5">{r.name || "—"}</td>
                        <td className="p-1.5">{r.category ?? "—"}</td>
                        <td className="p-1.5 text-right">{fmtMoney(r.salePrice)}</td>
                        <td className="p-1.5 text-right">{r.openingStock}</td>
                        <td className="p-1.5">
                          {r.status === "new" && (
                            <span className="text-success font-medium">New</span>
                          )}
                          {r.status === "update" && (
                            <span className="text-primary font-medium">Update</span>
                          )}
                          {r.status === "duplicate" && (
                            <span className="text-amber-600 font-medium">{r.error}</span>
                          )}
                          {r.status === "error" && (
                            <span className="text-destructive font-medium">{r.error}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              disabled={importing}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={importing || newCount + updateCount === 0}
              onClick={doImport}
            >
              {importing ? "Importing…" : `Import ${newCount + updateCount || ""}`.trim()}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

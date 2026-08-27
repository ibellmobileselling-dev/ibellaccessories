import { createFileRoute } from "@tanstack/react-router";
import { matchesQuery } from "@/lib/search";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
import { usePagination } from "@/hooks/usePagination";
import { useAutoFocusOnDesktop } from "@/hooks/use-mobile";
import {
  ItemRepo,
  SalesRepo,
  PurchaseRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  StockAdjustmentRepo,
} from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";
import { useStickyState } from "@/hooks/useStickySearch";
import type { Item } from "@/types";
import { fmtMoney } from "@/lib/format";
import { Boxes, Package, Search } from "lucide-react";

export const Route = createFileRoute("/inventory")({ component: InventoryPage });

function InventoryPage() {
  const _repoV = useRepoData();
  const searchRef = useRef<HTMLInputElement>(null);
  useAutoFocusOnDesktop(searchRef);
  const [rows, setRows] = useState<Item[]>([]);
  const [q, setQ] = useStickyState("inventory.search", "");
  const refresh = () => setRows(ItemRepo.all());
  useEffect(() => {
    refresh();
    // This is a read-only page with no local mutations to trigger a refresh
    // from, but stock genuinely changes elsewhere (another device/tab
    // billing a sale) while a user stays parked here — resync when they
    // come back to this tab/window instead of showing stale figures
    // indefinitely.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [_repoV]);

  // Stock In = purchases + sale returns + manual additions
  // Stock Out = sales + purchase returns + manual reductions
  const salesQty = new Map<string, number>();
  SalesRepo.all().forEach((s) =>
    s.lineItems.forEach((l) => salesQty.set(l.itemId, (salesQty.get(l.itemId) ?? 0) + l.qty)),
  );
  PurchaseReturnRepo.all().forEach((r) =>
    r.lineItems.forEach((l) => salesQty.set(l.itemId, (salesQty.get(l.itemId) ?? 0) + l.qty)),
  );
  const purchaseQty = new Map<string, number>();
  PurchaseRepo.all().forEach((s) =>
    s.lineItems.forEach((l) => purchaseQty.set(l.itemId, (purchaseQty.get(l.itemId) ?? 0) + l.qty)),
  );
  SaleReturnRepo.all().forEach((r) =>
    r.lineItems.forEach((l) => purchaseQty.set(l.itemId, (purchaseQty.get(l.itemId) ?? 0) + l.qty)),
  );
  StockAdjustmentRepo.all().forEach((a) => {
    const map = a.type === "add" ? purchaseQty : salesQty;
    map.set(a.itemId, (map.get(a.itemId) ?? 0) + a.qty);
  });

  const columns: Column<Item>[] = [
    {
      key: "name",
      label: "Item",
      render: (r) => r.name,
      sortValue: (r) => r.name,
    },
    {
      key: "sku",
      label: "SKU",
      width: "120px",
      render: (r) => <span className="font-mono text-xs">{r.sku ?? "—"}</span>,
    },
    {
      key: "opening",
      label: "Opening",
      align: "right",
      width: "90px",
      render: (r) => r.openingStock,
    },
    {
      key: "in",
      label: "Stock In",
      align: "right",
      width: "90px",
      render: (r) => `+${purchaseQty.get(r.id) ?? 0}`,
    },
    {
      key: "out",
      label: "Stock Out",
      align: "right",
      width: "90px",
      render: (r) => `-${salesQty.get(r.id) ?? 0}`,
    },
    {
      key: "stock",
      label: "Current",
      align: "right",
      width: "100px",
      render: (r) => {
        // minStock=0 is a valid "alert exactly at zero" threshold (must not
        // be treated as unset), and negative/oversold stock should always
        // stand out even when no threshold is configured at all — this is
        // the one genuine alert on this page, so it's the one place color
        // stays (same rule Items follows for its own low-stock warning).
        const low = (r.minStock != null && r.stock <= r.minStock) || r.stock < 0;
        return (
          <span className={low ? "text-warning font-medium" : ""}>
            {r.stock} {r.unit}
          </span>
        );
      },
      sortValue: (r) => r.stock,
    },
    { key: "min", label: "Min", align: "right", width: "70px", render: (r) => r.minStock ?? "—" },
    {
      key: "value",
      label: "Stock Value",
      align: "right",
      width: "120px",
      render: (r) => fmtMoney(r.stock * r.purchasePrice),
      sortValue: (r) => r.stock * r.purchasePrice,
    },
  ];

  const filtered = rows.filter((r) => {
    const s = q.toLowerCase();
    return matchesQuery(s, r.name, r.sku);
  });

  // Footer totals cover the filtered rows the table actually shows
  const totalValue = filtered.reduce((s, r) => s + r.stock * r.purchasePrice, 0);
  const lowCount = filtered.filter(
    (r) => (r.minStock != null && r.stock <= r.minStock) || r.stock < 0,
  ).length;

  const pg = usePagination(filtered, "inventory");

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Inventory"
        subtitle={`${rows.length} items`}
        icon={<Boxes className="h-5 w-5" />}
        actions={
          <div className="relative w-full sm:w-44 lg:w-56">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              ref={searchRef}
              placeholder="Search items by name or SKU..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="w-full h-8 pl-8 pr-3 border border-gray-200 rounded-md text-base md:text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
          </div>
        }
      />
      {/* Mobile card list — a table of 8 columns doesn't fit a phone; this is
          the same read-only stock data as one row-card per item instead (no
          click action here either, same as the desktop table). */}
      <div className="md:hidden flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <Package className="h-10 w-10 mx-auto mb-3 text-gray-200" />
            <p className="font-medium">No items found</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pg.paged.map((r) => {
              // minStock=0 is a valid "alert exactly at zero" threshold (must not
              // be treated as unset), and negative/oversold stock should always
              // stand out even when no threshold is configured at all — same
              // rule the desktop "Current" column uses.
              const low = (r.minStock != null && r.stock <= r.minStock) || r.stock < 0;
              return (
                <div key={r.id} className="bg-white p-4">
                  <div className="flex items-start justify-between gap-3 mb-1.5">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-800 truncate">{r.name}</p>
                      <p className="text-xs text-gray-400 mt-0.5 truncate font-mono">
                        {r.sku || "No SKU"}
                      </p>
                    </div>
                    <p
                      className={`font-bold tabular-nums shrink-0 ${low ? "text-warning" : "text-gray-800"}`}
                    >
                      {r.stock} {r.unit}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span>+{purchaseQty.get(r.id) ?? 0} in</span>
                    <span>-{salesQty.get(r.id) ?? 0} out</span>
                    <span>Min {r.minStock ?? "—"}</span>
                    <span className="ml-auto tabular-nums">
                      {fmtMoney(r.stock * r.purchasePrice)}
                    </span>
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
          storageKey="inventory"
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.id}
          footer={
            <tr>
              <td colSpan={4}>Total ({filtered.length} items)</td>
              <td colSpan={2}>{lowCount > 0 ? `${lowCount} low on stock` : "All stocked"}</td>
              <td colSpan={2} className="text-right tabular-nums">
                {fmtMoney(totalValue)}
              </td>
            </tr>
          }
        />
      </div>
    </div>
  );
}

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useGoBack } from "@/hooks/useGoBack";
import { useEffect, useMemo, useState } from "react";
import {
  ItemRepo,
  SalesRepo,
  PurchaseRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  StockAdjustmentRepo,
} from "@/repositories";
import { fmtMoney, fmtDate } from "@/lib/format";
import { PaginationBar } from "@/components/Pagination";
import { usePagination } from "@/hooks/usePagination";
import { ItemDialog, StockAdjustDialog } from "./items";
import { usePermissions } from "@/hooks/usePermissions";
import { useRepoData, useRepoMemo } from "@/hooks/useRepoData";
import type { Item, Invoice, Return } from "@/types";
import {
  ArrowLeft,
  Package,
  Pencil,
  ArrowUpDown,
  AlertCircle,
  TrendingUp,
  ArrowDownLeft,
  ArrowUpRight,
} from "lucide-react";

export const Route = createFileRoute("/items_/$id")({ component: ItemDetailPage });

const r2 = (n: number) => Math.round(n * 100) / 100;

interface HistoryRow {
  date: string;
  created: string;
  type: string;
  ref: string;
  party: string;
  qtyIn: number;
  qtyOut: number;
  rate: number | null;
  docId?: string;
  docKind?: "sale" | "purchase" | "sale-return" | "purchase-return";
}

function ItemDetailPage() {
  const _repoV = useRepoData();
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const goBack = useGoBack("/items");
  const { isOwner, canEdit } = usePermissions();
  const editAllowed = isOwner || canEdit("masterData");
  const [item, setItem] = useState<Item | null | undefined>(undefined);
  const [editOpen, setEditOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setItem(ItemRepo.get(id) ?? null);
  }, [id, refreshKey, _repoV]);

  const { rows, soldQty, profit } = useRepoMemo(() => {
    const entries: HistoryRow[] = [];
    let soldQty = 0;
    let boughtQty = 0;
    let profit = 0;
    if (!item) return { rows: entries, soldQty, boughtQty, profit };
    const costOf = (l: { costPrice?: number }) => l.costPrice ?? item.purchasePrice ?? 0;

    const collect = (
      docs: (Invoice | Return)[],
      type: string,
      docKind: HistoryRow["docKind"],
      inward: boolean,
      onQty?: (l: { qty: number; price: number; discountPct: number; costPrice?: number }) => void,
    ) => {
      for (const d of docs) {
        for (const l of d.lineItems) {
          if (l.itemId !== id) continue;
          entries.push({
            date: d.date,
            created: d.createdAt,
            type,
            ref: d.number,
            party: d.partyName,
            qtyIn: inward ? l.qty : 0,
            qtyOut: inward ? 0 : l.qty,
            rate: l.price,
            docId: d.id,
            docKind,
          });
          onQty?.(l);
        }
      }
    };

    collect(SalesRepo.all(), "Sale", "sale", false, (l) => {
      soldQty = r2(soldQty + l.qty);
      profit = r2(profit + l.qty * l.price * (1 - l.discountPct / 100) - l.qty * costOf(l));
    });
    collect(PurchaseRepo.all(), "Purchase", "purchase", true, (l) => {
      boughtQty = r2(boughtQty + l.qty);
    });
    collect(SaleReturnRepo.all(), "Sale Return", "sale-return", true, (l) => {
      soldQty = r2(soldQty - l.qty);
      profit = r2(profit - (l.qty * l.price * (1 - l.discountPct / 100) - l.qty * costOf(l)));
    });
    collect(PurchaseReturnRepo.all(), "Purchase Return", "purchase-return", false, (l) => {
      boughtQty = r2(boughtQty - l.qty);
    });
    for (const a of StockAdjustmentRepo.all()) {
      if (a.itemId !== id) continue;
      entries.push({
        date: a.date,
        created: a.createdAt,
        type: a.type === "add" ? "Stock Added" : "Stock Reduced",
        ref: a.reason || "Adjustment",
        party: "—",
        qtyIn: a.type === "add" ? a.qty : 0,
        qtyOut: a.type === "reduce" ? a.qty : 0,
        rate: null,
      });
    }
    entries.sort(
      (a, b) => b.date.localeCompare(a.date) || (b.created ?? "").localeCompare(a.created ?? ""),
    );
    return { rows: entries, soldQty, boughtQty, profit };
  }, [item, id, refreshKey]);

  const pg = usePagination(rows, "item-history");

  const openRow = (e: HistoryRow) => {
    if (!e.docId || !e.docKind) return;
    if (e.docKind === "sale") navigate({ to: "/sales/$id", params: { id: e.docId } });
    else if (e.docKind === "purchase") navigate({ to: "/purchase/$id", params: { id: e.docId } });
    else if (e.docKind === "sale-return")
      navigate({ to: "/sale-return/$id", params: { id: e.docId } });
    else navigate({ to: "/purchase-return/$id", params: { id: e.docId } });
  };

  if (item === undefined) return null;
  if (item === null) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 text-gray-400">
        <AlertCircle className="h-12 w-12 text-gray-200" />
        <p className="font-medium">Item not found</p>
        <button
          onClick={() => navigate({ to: "/items" })}
          className="text-sm text-primary hover:underline"
        >
          ← Back to Items
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#f5f6fa]">
      {/* Header */}
      <div className="bg-white border-b px-5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={goBack}
            className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 hover:border-gray-300 flex items-center justify-center text-gray-600 transition shadow-sm"
            aria-label="Go back"
            title="Back to Items"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="h-10 w-10 shrink-0 rounded-lg bg-primary-soft text-primary flex items-center justify-center">
            <Package className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-[17px] font-bold text-gray-800 truncate leading-tight">
              {item.name}
            </h1>
            <p className="text-[12px] text-gray-400">
              {item.category || "No category"} · Unit: {item.unit}
            </p>
          </div>
        </div>
        {editAllowed && (
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              onClick={() => setAdjustOpen(true)}
              className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 h-9 px-4 bg-white border border-gray-200 text-gray-700 rounded-lg text-sm font-semibold shadow-sm hover:bg-gray-50 hover:border-gray-300 hover:shadow transition"
            >
              <ArrowUpDown className="h-4 w-4" /> Adjust Stock
            </button>
            <button
              onClick={() => setEditOpen(true)}
              className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 h-9 px-4 bg-primary text-white rounded-lg text-sm font-semibold shadow-sm hover:opacity-90 hover:shadow transition"
            >
              <Pencil className="h-4 w-4" /> Edit Item
            </button>
          </div>
        )}
      </div>

      {/* Summary — desktop: one row across all 6, plenty of width to spare */}
      <div className="hidden lg:grid grid-cols-6 bg-white border-b">
        <Stat
          label="Current Stock"
          value={`${item.stock} ${item.unit}`}
          color={item.stock < 0 ? "text-rose-600" : "text-gray-800"}
        />
        <Stat label="Stock Value" value={fmtMoney(r2(item.stock * item.purchasePrice))} />
        <Stat label="Purchase Price" value={fmtMoney(item.purchasePrice)} />
        <Stat label="Sale Price" value={fmtMoney(item.salePrice)} />
        <Stat label="Total Sold" value={`${soldQty} ${item.unit}`} />
        <Stat
          label="Profit Earned"
          value={fmtMoney(profit)}
          color={profit >= 0 ? "text-emerald-600" : "text-rose-600"}
          icon
        />
      </div>

      {/* Summary — mobile/tablet: 6 stats don't fit one row at this width, and
          wrapping to a 2-row grid (the old behavior) reads cramped and cuts
          "Profit Earned" awkwardly. A horizontally-scrolling strip of small
          KPI cards keeps every stat a single, evenly-sized tap/glance target
          in one row, native-app style, instead of a squeezed table grid. */}
      <div className="lg:hidden bg-white border-b py-3">
        <div className="flex gap-2.5 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <MobileStatCard
            label="Current Stock"
            value={`${item.stock} ${item.unit}`}
            color={item.stock < 0 ? "text-rose-600" : "text-gray-800"}
          />
          <MobileStatCard
            label="Stock Value"
            value={fmtMoney(r2(item.stock * item.purchasePrice))}
          />
          <MobileStatCard label="Purchase Price" value={fmtMoney(item.purchasePrice)} />
          <MobileStatCard label="Sale Price" value={fmtMoney(item.salePrice)} />
          <MobileStatCard label="Total Sold" value={`${soldQty} ${item.unit}`} />
          <MobileStatCard
            label="Profit Earned"
            value={fmtMoney(profit)}
            color={profit >= 0 ? "text-emerald-600" : "text-rose-600"}
            icon
          />
        </div>
      </div>

      {/* History */}
      <div className="flex-1 overflow-auto p-5">
        <div className="bg-white border rounded-lg shadow-sm overflow-hidden max-w-5xl mx-auto flex flex-col">
          <div className="px-5 py-3 border-b">
            <p className="text-sm font-bold text-gray-800">Transaction History</p>
          </div>
          {/* Mobile card list — a table of 7 columns doesn't fit a phone;
              this is the same history as one tappable card per entry instead. */}
          <div className="md:hidden">
            {rows.length === 0 ? (
              <p className="text-center py-14 text-gray-400">No transactions for this item yet</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {pg.paged.map((e, i) => {
                  const isIn = e.qtyIn > 0;
                  return (
                    <div
                      key={i}
                      onClick={() => openRow(e)}
                      className={`flex items-center gap-3 px-4 py-3 ${e.docId ? "cursor-pointer active:bg-gray-50" : ""}`}
                    >
                      {/* Tinted in/out marker — green = stock came in (purchase /
                          sale return), red = stock went out (sale / purchase return) */}
                      <div
                        className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${isIn ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"}`}
                      >
                        {isIn ? (
                          <ArrowDownLeft className="h-4 w-4" />
                        ) : (
                          <ArrowUpRight className="h-4 w-4" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-[13px] text-gray-800 truncate leading-tight">
                          {e.type}
                        </p>
                        <p className="text-[11px] text-gray-400 truncate mt-0.5">
                          {fmtDate(e.date)}
                          {e.party ? ` · ${e.party}` : ""}
                          {e.rate != null ? ` · Rate ${fmtMoney(e.rate)}` : ""}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p
                          className={`font-bold tabular-nums text-[13px] leading-tight ${isIn ? "text-emerald-600" : "text-rose-600"}`}
                        >
                          {isIn ? `+${e.qtyIn}` : `−${e.qtyOut}`} {item.unit}
                        </p>
                        {e.ref && (
                          <p className="font-mono text-[10px] text-blue-500 mt-0.5">{e.ref}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Table (desktop) */}
          <table className="hidden md:table w-full text-[12.5px] border-collapse">
            <thead>
              <tr className="bg-gray-50">
                {["Date", "Type", "Ref #", "Party", "Rate", "Qty In", "Qty Out"].map((h, i) => (
                  <th
                    key={h}
                    className={`px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500 border-b border-gray-200 whitespace-nowrap ${i >= 4 ? "text-right" : "text-left"}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-14 text-gray-400">
                    No transactions for this item yet
                  </td>
                </tr>
              ) : (
                pg.paged.map((e, i) => (
                  <tr
                    key={i}
                    onClick={() => openRow(e)}
                    title={e.docId ? "Open this bill" : undefined}
                    className={`border-b border-gray-100 hover:bg-gray-50/60 ${e.docId ? "cursor-pointer" : ""}`}
                  >
                    <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">
                      {fmtDate(e.date)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${e.qtyIn > 0 ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-rose-50 text-rose-700 border-rose-200"}`}
                      >
                        {e.type}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-blue-600">{e.ref}</td>
                    <td className="px-4 py-2.5 font-medium text-gray-800 max-w-[160px] truncate">
                      {e.party}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-600">
                      {e.rate != null ? fmtMoney(e.rate) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-emerald-600 font-semibold">
                      {e.qtyIn ? `+${e.qtyIn}` : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-rose-600 font-semibold">
                      {e.qtyOut ? `−${e.qtyOut}` : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <PaginationBar
            page={pg.page}
            totalPages={pg.totalPages}
            pageSize={pg.pageSize}
            total={pg.total}
            onPage={pg.setPage}
            onPageSize={pg.setPageSize}
          />
        </div>
      </div>

      <ItemDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        item={item}
        onSaved={() => setRefreshKey((k) => k + 1)}
      />
      <StockAdjustDialog
        item={adjustOpen ? item : null}
        onOpenChange={(v) => {
          if (!v) setAdjustOpen(false);
        }}
        onSaved={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  color = "text-gray-800",
  icon,
}: {
  label: string;
  value: string;
  color?: string;
  icon?: boolean;
}) {
  return (
    <div className="px-4 py-3 border-r border-gray-100 last:border-r-0">
      <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wide mb-0.5 flex items-center gap-1">
        {icon && <TrendingUp className="h-3 w-3" />}
        {label}
      </p>
      <p className={`text-[15px] font-bold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

function MobileStatCard({
  label,
  value,
  color = "text-gray-800",
  icon,
}: {
  label: string;
  value: string;
  color?: string;
  icon?: boolean;
}) {
  return (
    <div className="shrink-0 min-w-[116px] rounded-xl border border-gray-100 bg-white shadow-sm px-3.5 py-2.5">
      <p className="text-[9px] text-gray-400 font-semibold uppercase tracking-wide mb-1 flex items-center gap-1">
        {icon && <TrendingUp className="h-3 w-3" />}
        {label}
      </p>
      <p className={`text-[14px] font-bold tabular-nums whitespace-nowrap ${color}`}>{value}</p>
    </div>
  );
}

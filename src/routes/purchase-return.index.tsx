import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PurchaseReturnRepo, ItemRepo } from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";
import { newBatch, commitBatch } from "@/repositories/base";
import type { Return } from "@/types";
import { fmtDate, fmtDateShort, fmtMoney } from "@/lib/format";
import { Plus, CornerUpLeft, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DataTable } from "@/components/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { usePagination } from "@/hooks/usePagination";
import { usePeriodLock } from "@/hooks/usePeriodLock";
import { usePermissions } from "@/hooks/usePermissions";
import { VoidDialog, VoidedBadge } from "@/components/VoidDialog";
import { canDeleteOutright, isVoided, removalWord } from "@/lib/voiding";
import { SerialRepo } from "@/repositories";
import { undoSerialsOf } from "@/lib/serialMoves";
import { Ban } from "lucide-react";

export const Route = createFileRoute("/purchase-return/")({ component: PurchaseReturnPage });

function PurchaseReturnPage() {
  const navigate = useNavigate();
  const { isOwner, canEdit, canDelete } = usePermissions();
  const editAllowed = isOwner || canEdit("purchaseExpenses");
  const deleteAllowed = isOwner || canDelete("purchaseExpenses");
  const [rows, setRows] = useState<Return[]>([]);
  // Cancelled returns stay on file; this only decides whether they are in the
  // way.
  const [showVoided, setShowVoided] = useState(false);
  const [voiding, setVoiding] = useState<Return | null>(null);

  const refresh = () =>
    setRows(
      (showVoided ? PurchaseReturnRepo.allWithVoided() : PurchaseReturnRepo.all()).sort((a, b) =>
        b.date.localeCompare(a.date),
      ),
    );
  const _repoV = useRepoData();
  useEffect(refresh, [_repoV, showVoided]);

  const { canPost } = usePeriodLock();
  const pg = usePagination(rows, "purchase-return");

  const totalDebit = rows.reduce((s, r) => s + r.total, 0);

  const handleDelete = (r: Return) => {
    if (!deleteAllowed) {
      toast.error("You don't have permission to delete purchase returns");
      return;
    }
    if (!canPost(r.date)) return;
    if (!confirm(`Delete return ${r.number}? Returned quantities will be added back to stock.`))
      return;
    // Bail if another device already deleted it — the stock reversal is a
    // blind atomic increment, so running it twice would double-adjust stock.
    const live = PurchaseReturnRepo.get(r.id);
    if (!live) {
      toast.info(`Return ${r.number} was already deleted`);
      refresh();
      return;
    }
    // Stock reversal and the delete must land together as one atomic write —
    // previously these were separate calls, so a failure between them left
    // stock reversed with the return still present (or vice versa).
    const batch = newBatch();
    undoReturnEffects(batch, live);
    PurchaseReturnRepo.removeBatched(batch, live.id);
    commitBatch(batch, "delete purchase return");
    refresh();
    toast.success("Purchase return deleted — stock adjusted");
  };

  /** The stock this return moved, put back. Shared by delete and void:
   *  they owe the shop the same reversal, and two copies would drift. */
  const undoReturnEffects = (batch: ReturnType<typeof newBatch>, live: Return) => {
    for (const l of live.lineItems) {
      const it = ItemRepo.get(l.itemId);
      // A serialised item's stock is its units, moved just below. Nudging the
      // stored number as well would leave a second figure that nothing reads
      // and somebody eventually believes.
      if (it && !it.trackSerials) {
        ItemRepo.adjustFieldBatched(batch, l.itemId, "stock", l.qty);
      }
    }
    for (const u of undoSerialsOf(live, "purchase-return", (id) => ItemRepo.get(id))) {
      SerialRepo.updateBatched(batch, u.id, u.patch as never);
    }
  };

  const handleVoid = (live: Return, reason: string) => {
    const batch = newBatch();
    undoReturnEffects(batch, live);
    if (!PurchaseReturnRepo.voidBatched(batch, live.id, reason)) {
      toast.info(`${live.number} was already voided`);
      setVoiding(null);
      return;
    }
    commitBatch(batch, "void purchase return");
    setVoiding(null);
    refresh();
    toast.success(`${live.number} voided — stock adjusted, and it stays on record`);
  };

  return (
    <div className="flex flex-col h-full bg-[#f5f6fa]">
      <PageHeader
        title="Purchase Returns"
        subtitle={`${rows.length} debit notes · Total: ${fmtMoney(totalDebit)}`}
        icon={<CornerUpLeft className="h-5 w-5" />}
        actions={
          <>
            <button
              onClick={() => setShowVoided((v) => !v)}
              className={`hidden sm:inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border text-xs transition ${
                showVoided
                  ? "border-rose-200 bg-rose-50 text-rose-700 font-semibold"
                  : "border-gray-200 bg-gray-50/60 text-gray-500 hover:bg-gray-100"
              }`}
              title="Cancelled records stay on file — this decides whether they are in the way"
            >
              <Ban className="h-3.5 w-3.5" /> Voided
            </button>
            {editAllowed && (
              <button
                onClick={() => navigate({ to: "/purchase-return/new" })}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 h-8 px-4 bg-primary text-primary-foreground rounded-md text-sm font-semibold hover:opacity-90 transition"
              >
                <Plus className="h-4 w-4" /> New Purchase Return
              </button>
            )}
          </>
        }
      />

      {/* Mobile card list — a table of 7 columns doesn't fit a phone; this
          is the same data as one tappable card per return instead. */}
      <div className="md:hidden flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <CornerUpLeft className="h-10 w-10 mx-auto mb-3 text-gray-200" />
            <p className="font-medium">No purchase returns found</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pg.paged.map((r) => (
              <div
                key={r.id}
                onClick={() => navigate({ to: "/purchase-return/$id", params: { id: r.id } })}
                className="bg-white px-4 py-3 active:bg-gray-50 flex items-center gap-3"
              >
                <div className="h-9 w-9 rounded-full flex items-center justify-center shrink-0 bg-amber-50 text-amber-600">
                  <CornerUpLeft className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-[13px] text-gray-800 truncate font-mono leading-tight">
                      <span className={isVoided(r) ? "line-through text-gray-400" : ""}>
                        {r.number}
                      </span>
                      {isVoided(r) && (
                        <>
                          {" "}
                          <VoidedBadge reason={r.voidReason} at={r.voidedAt} />
                        </>
                      )}
                    </p>
                    <p className="font-bold text-[13px] text-gray-800 tabular-nums shrink-0 leading-tight">
                      {fmtMoney(r.total)}
                    </p>
                  </div>
                  <p className="text-[11px] text-gray-400 mt-1 truncate">
                    {fmtDate(r.date)} · {r.partyName}
                    {r.originalRef ? ` · vs ${r.originalRef}` : ""} · {r.lineItems.length} item
                    {r.lineItems.length === 1 ? "" : "s"}
                  </p>
                </div>
                {deleteAllowed && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(r);
                    }}
                    className="p-1.5 rounded hover:bg-rose-50 text-gray-300 hover:text-rose-500 transition shrink-0 -mr-1.5"
                    title={`${removalWord(r.date)} return`}
                  >
                    {canDeleteOutright(r.date) ? (
                      <Trash2 className="h-3.5 w-3.5" />
                    ) : (
                      <Ban className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Table (desktop) */}
      <div className="hidden md:flex flex-1 min-h-0 p-6">
        <DataTable
          storageKey="purchase-return"
          activateOnClick
          columns={[
            {
              key: "number",
              label: "Debit Note #",
              render: (r) => (
                <span className="inline-flex items-center gap-1.5">
                  <span className={`font-mono ${isVoided(r) ? "line-through text-gray-400" : ""}`}>
                    {r.number}
                  </span>
                  {isVoided(r) && <VoidedBadge reason={r.voidReason} at={r.voidedAt} />}
                </span>
              ),
              sortValue: (r) => r.number,
            },
            {
              key: "date",
              label: "Date",
              render: (r) => <span className="whitespace-nowrap">{fmtDateShort(r.date)}</span>,
              sortValue: (r) => r.date,
            },
            {
              key: "original",
              label: "Original Bill #",
              render: (r) => <span className="font-mono">{r.originalRef || "—"}</span>,
            },
            {
              key: "supplier",
              label: "Supplier",
              render: (r) => <span className="max-w-[160px] truncate block">{r.partyName}</span>,
              sortValue: (r) => r.partyName,
            },
            {
              key: "items",
              label: "Items",
              align: "right",
              render: (r) => r.lineItems.length,
              sortValue: (r) => r.lineItems.length,
            },
            {
              key: "gst",
              label: "GST",
              align: "right",
              render: (r) => (r.gstEnabled ? "Yes" : "No"),
            },
            {
              key: "total",
              label: "Total",
              align: "right",
              render: (r) => <span className="tabular-nums">{fmtMoney(r.total)}</span>,
              sortValue: (r) => r.total,
            },
            {
              key: "action",
              label: "Action",
              align: "center",
              render: (r) =>
                deleteAllowed && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(r);
                    }}
                    className="p-1 rounded hover:bg-rose-50 text-gray-400 hover:text-rose-500 transition"
                    title={`${removalWord(r.date)} return`}
                  >
                    {canDeleteOutright(r.date) ? (
                      <Trash2 className="h-3.5 w-3.5" />
                    ) : (
                      <Ban className="h-3.5 w-3.5" />
                    )}
                  </button>
                ),
            },
          ]}
          rows={rows}
          rowKey={(r) => r.id}
          onRowActivate={(r) => navigate({ to: "/purchase-return/$id", params: { id: r.id } })}
          emptyMessage='No purchase returns yet — click "New Purchase Return" to create a debit note'
          footer={
            <tr>
              <td colSpan={6}>Total ({rows.length} returns)</td>
              <td className="text-right tabular-nums">{fmtMoney(totalDebit)}</td>
              <td />
            </tr>
          }
        />
      </div>

      <VoidDialog
        open={!!voiding}
        onOpenChange={(v) => !v && setVoiding(null)}
        what={`${voiding?.number ?? ""}`}
        effects={["Returned quantities go back into stock"]}
        onConfirm={(reason) => voiding && handleVoid(voiding, reason)}
      />
    </div>
  );
}

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { matchesQuery } from "@/lib/search";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
import { usePagination } from "@/hooks/usePagination";
import { useAutoFocusOnDesktop } from "@/hooks/use-mobile";
import { PayeeRepo, ExpenseRepo, CompanyRepo } from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";
import { useStickyState } from "@/hooks/useStickySearch";
import type { Payee } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/Field";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { fmtMoney, fmtDate } from "@/lib/format";
import { Plus, Search, Pencil, FileText, Wallet2 } from "lucide-react";
import { toast } from "sonner";
import { usePermissions } from "@/hooks/usePermissions";

export const Route = createFileRoute("/payees")({ component: PayeesPage });

function PayeesPage() {
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  useAutoFocusOnDesktop(searchRef);
  const { isOwner, canEdit, canDelete } = usePermissions();
  const editAllowed = isOwner || canEdit("purchaseExpenses");
  const deleteAllowed = isOwner || canDelete("purchaseExpenses");
  const [rows, setRows] = useState<Payee[]>([]);
  const [q, setQ] = useStickyState("payees.search", "");
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Payee | null>(null);

  const refresh = () => setRows(PayeeRepo.all());
  const _repoV = useRepoData();
  useEffect(refresh, [_repoV]);

  const filtered = rows.filter((r) => {
    const s = q.toLowerCase();
    return matchesQuery(s, r.name);
  });

  const pg = usePagination(filtered, "payees");

  // Total paid + most recent payment date per payee, derived straight from
  // the expense records — never a second, separately-maintained number that
  // could drift from what the expense list itself shows.
  const expenses = ExpenseRepo.all();
  const statsByPayee = new Map<string, { total: number; lastDate: string }>();
  for (const e of expenses) {
    if (!e.payeeId) continue;
    const cur = statsByPayee.get(e.payeeId) ?? { total: 0, lastDate: "" };
    cur.total += e.amount;
    if (e.date > cur.lastDate) cur.lastDate = e.date;
    statsByPayee.set(e.payeeId, cur);
  }
  const grandTotal = [...statsByPayee.values()].reduce((s, v) => s + v.total, 0);

  const columns: Column<Payee>[] = [
    { key: "name", label: "Name", render: (r) => r.name, sortValue: (r) => r.name },
    {
      key: "category",
      label: "Default Category",
      width: "160px",
      render: (r) => r.defaultCategory ?? "—",
    },
    {
      key: "last",
      label: "Last Paid",
      width: "120px",
      render: (r) => {
        const d = statsByPayee.get(r.id)?.lastDate;
        return d ? fmtDate(d) : "—";
      },
      sortValue: (r) => statsByPayee.get(r.id)?.lastDate ?? "",
    },
    {
      key: "total",
      label: "Total Paid",
      align: "right",
      width: "140px",
      render: (r) => fmtMoney(statsByPayee.get(r.id)?.total ?? 0),
      sortValue: (r) => statsByPayee.get(r.id)?.total ?? 0,
    },
    {
      key: "actions",
      label: "Action",
      width: "90px",
      align: "center",
      render: (r) => (
        <span className="inline-flex items-center justify-center gap-0.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate({ to: "/payees/$id", params: { id: r.id } });
            }}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-primary-soft hover:text-primary hover:border-primary/25"
            title="View ledger"
          >
            <FileText className="h-3.5 w-3.5" />
          </button>
          {editAllowed && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEdit(r);
                setOpen(true);
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-primary-soft hover:text-primary hover:border-primary/25"
              title="Edit payee"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Expense Payees"
        subtitle={`${rows.length} payees · ${fmtMoney(grandTotal)} paid all-time`}
        icon={<Wallet2 className="h-5 w-5" />}
        actions={
          <>
            <div className="relative w-full sm:w-44 lg:w-56">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                ref={searchRef}
                placeholder="Search payees..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-full h-8 pl-8 pr-3 border border-gray-200 rounded-md text-base md:text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
              />
            </div>
            {editAllowed && (
              <Button
                size="sm"
                onClick={() => {
                  setEdit(null);
                  setOpen(true);
                }}
                className="w-full sm:w-auto"
              >
                <Plus className="h-3.5 w-3.5" /> New Payee
              </Button>
            )}
          </>
        }
      />
      {/* Mobile card list — a table of 4 columns doesn't fit a phone; this
          is the same data as one tappable card per payee instead. */}
      <div className="md:hidden flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <Wallet2 className="h-10 w-10 mx-auto mb-3 text-gray-200" />
            <p className="font-medium">No payees found</p>
            <p className="text-xs mt-1">Try adjusting your search or add a new payee</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pg.paged.map((r) => {
              const stats = statsByPayee.get(r.id);
              return (
                <div
                  key={r.id}
                  onClick={() => navigate({ to: "/payees/$id", params: { id: r.id } })}
                  className="bg-white p-4 active:bg-gray-50"
                >
                  <div className="flex items-start justify-between gap-3 mb-1.5">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-800 truncate">{r.name}</p>
                      <p className="text-xs text-gray-400 mt-0.5 truncate">
                        {r.defaultCategory ?? "No category"}
                        {stats?.lastDate ? ` · Last paid ${fmtDate(stats.lastDate)}` : ""}
                      </p>
                    </div>
                    <p className="font-bold text-gray-800 tabular-nums shrink-0">
                      {fmtMoney(stats?.total ?? 0)}
                    </p>
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate({ to: "/payees/$id", params: { id: r.id } });
                      }}
                      className="p-1.5 rounded hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition"
                      title="View ledger"
                    >
                      <FileText className="h-3.5 w-3.5" />
                    </button>
                    {editAllowed && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEdit(r);
                          setOpen(true);
                        }}
                        className="p-1.5 rounded hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition"
                        title="Edit payee"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="hidden md:flex flex-1 min-h-0 p-6">
        <DataTable
          storageKey="payees"
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.id}
          footer={
            <tr>
              <td colSpan={3}>Total ({filtered.length} payees)</td>
              <td className="text-right tabular-nums">{fmtMoney(grandTotal)}</td>
              <td />
            </tr>
          }
          activateOnClick
          onRowActivate={(r) => navigate({ to: "/payees/$id", params: { id: r.id } })}
          onDelete={(r) => {
            if (!deleteAllowed) {
              toast.error("You don't have permission to delete payees");
              return;
            }
            // A payee with any expense history must never be removable —
            // old expenses would keep referencing a payeeId that resolves
            // to nothing, making their ledger permanently inaccessible.
            const hasHistory = expenses.some((e) => e.payeeId === r.id);
            if (hasHistory) {
              toast.error(`Cannot delete ${r.name} — it has expenses on record`);
              return;
            }
            if (confirm(`Delete ${r.name}?`)) {
              PayeeRepo.remove(r.id);
              refresh();
              toast.success("Payee deleted");
            }
          }}
        />
      </div>
      <PayeeDialog open={open} onOpenChange={setOpen} payee={edit} onSaved={refresh} />
    </div>
  );
}

function PayeeDialog({
  open,
  onOpenChange,
  payee,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  payee: Payee | null;
  onSaved: () => void;
}) {
  const firstRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<Partial<Payee>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(payee ?? {});
      setSaving(false);
      setTimeout(() => firstRef.current?.focus(), 50);
    }
  }, [open, payee]);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (!form.name?.trim()) {
      toast.error("Name is required");
      return;
    }
    const dup = PayeeRepo.all().find(
      (p) => p.name.trim().toLowerCase() === form.name!.trim().toLowerCase() && p.id !== payee?.id,
    );
    if (dup) {
      toast.error(`Payee "${dup.name}" already exists`);
      return;
    }
    setSaving(true);
    if (payee) {
      PayeeRepo.update(payee.id, form as Payee);
      toast.success("Payee updated");
    } else {
      PayeeRepo.add({ name: form.name!, defaultCategory: form.defaultCategory });
      toast.success("Payee created");
    }
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{payee ? "Edit Payee" : "New Payee"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="grid grid-cols-1 gap-3">
          <Field
            ref={firstRef}
            label="Name *"
            value={form.name ?? ""}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="text-muted-foreground font-medium">Default Category</span>
            <Select
              value={form.defaultCategory ?? "__none__"}
              onValueChange={(v) =>
                setForm({ ...form, defaultCategory: v === "__none__" ? undefined : v })
              }
            >
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {(CompanyRepo.get().expenseCategories ?? []).map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <p className="text-[11px] text-muted-foreground -mt-1">
            Pre-fills Category whenever this payee is picked on a new expense.
          </p>
          <div className="flex justify-end gap-2 mt-2">
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

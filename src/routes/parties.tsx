import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { matchesQuery } from "@/lib/search";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
import { usePagination } from "@/hooks/usePagination";
import { useAutoFocusOnDesktop } from "@/hooks/use-mobile";
import {
  PartyRepo,
  SalesRepo,
  PurchaseRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  PaymentRepo,
} from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";
import { useStickyState } from "@/hooks/useStickySearch";
import type { Party } from "@/types";
import { newBatch, commitBatch, genId } from "@/repositories/base";
import { downloadCsv } from "@/lib/csv";
import { parseImportFile, normalizeHeader } from "@/lib/sheetImport";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/Field";
import { NumField, NumInput } from "@/components/NumInput";
import { fmtMoney } from "@/lib/format";
import { netPartyPositions } from "@/lib/ledger";
import { PartyLedgerExportDialog } from "@/components/PartyLedgerExportDialog";
import {
  Plus,
  Search,
  Pencil,
  FileText,
  Users,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Trash2,
  Upload,
  Download,
  FileDown,
} from "lucide-react";
import { toast } from "sonner";
import { usePermissions } from "@/hooks/usePermissions";

export const Route = createFileRoute("/parties")({ component: PartiesPage });

// ── Bulk party import ────────────────────────────────────────────────────
const PARTY_BULK_COLUMNS = [
  "Name",
  "Phone",
  "Type",
  "Opening Balance",
  "Credit Limit",
  "GSTIN",
] as const;

const PARTY_ALIASES: Record<string, string[]> = {
  name: ["name", "partyname"],
  phone: ["phone", "mobile", "contact", "phoneno", "mobileno", "phonenumber"],
  type: ["type", "partytype"],
  openingBalance: ["openingbalance", "opening", "balance", "openingbal"],
  creditLimit: ["creditlimit", "credit", "limit"],
  gstin: ["gstin", "gst", "gstno", "gstnumber"],
};

interface PartyPreviewRow {
  rowNum: number;
  name: string;
  phone?: string;
  type: Party["type"];
  openingBalance: number;
  creditLimit?: number;
  gstin?: string;
  status: "new" | "update" | "error" | "duplicate";
  error?: string;
  matchId?: string;
}

/** Turn a parsed bulk-import table into party preview rows. Matches existing
 * parties by phone (unique) then name — the same rule the party form/quick-add
 * already use to prevent duplicates. Opening balance is only applied to NEW
 * parties; a matched party's opening balance is never changed by import (it
 * feeds their ledger, exactly like item stock is protected on item import). */
function buildPartyPreview(table: string[][], existing: Party[]): PartyPreviewRow[] {
  if (table.length < 2) return [];
  const header = table[0].map(normalizeHeader);
  const colIndex: Partial<Record<string, number>> = {};
  for (const [key, aliases] of Object.entries(PARTY_ALIASES)) {
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
  const parseType = (s: string): Party["type"] => {
    const t = s.trim().toLowerCase();
    if (t === "customer" || t === "cust" || t === "c") return "customer";
    if (t === "supplier" || t === "vendor" || t === "s") return "supplier";
    return "both";
  };

  const seenName = new Map<string, number>();
  const seenPhone = new Map<string, number>();
  const out: PartyPreviewRow[] = [];

  for (let i = 1; i < table.length; i++) {
    const row = table[i];
    if (row.every((c) => !c.trim())) continue;
    const rowNum = i + 1;
    const name = cell(row, "name");
    const phone = cell(row, "phone");
    const creditRaw = cell(row, "creditLimit");
    const gstin = cell(row, "gstin");
    const rec: PartyPreviewRow = {
      rowNum,
      name,
      phone: phone || undefined,
      type: parseType(cell(row, "type")),
      openingBalance: num(cell(row, "openingBalance"), 0),
      creditLimit: creditRaw ? num(creditRaw) : undefined,
      gstin: gstin || undefined,
      status: "new",
    };

    if (!name) {
      out.push({ ...rec, status: "error", error: "Name is required" });
      continue;
    }
    // In-file duplicate (same name or phone appearing twice in the sheet) is a
    // normal human slip — quietly marked "duplicate" and skipped (the first
    // occurrence is kept), so the rest of the file still imports. This is not a
    // scary "error" the user must fix; a name/phone is just never imported twice.
    const nameKey = name.toLowerCase();
    if (seenName.has(nameKey)) {
      out.push({
        ...rec,
        status: "duplicate",
        error: `Same name as row ${seenName.get(nameKey)} — skipped`,
      });
      continue;
    }
    if (phone && seenPhone.has(phone)) {
      out.push({
        ...rec,
        status: "duplicate",
        error: `Same phone as row ${seenPhone.get(phone)} — skipped`,
      });
      continue;
    }
    seenName.set(nameKey, rowNum);
    if (phone) seenPhone.set(phone, rowNum);

    // Match existing by phone first (unique), then by name — mirrors the form
    const match =
      (phone ? existing.find((p) => (p.phone ?? "").trim() === phone) : undefined) ??
      existing.find((p) => p.name.trim().toLowerCase() === nameKey);
    if (match) {
      rec.status = "update";
      rec.matchId = match.id;
    }
    out.push(rec);
  }
  return out;
}

function PartiesPage() {
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  useAutoFocusOnDesktop(searchRef);
  const { isOwner, canEdit } = usePermissions();
  const editAllowed = isOwner || canEdit("masterData");
  const [rows, setRows] = useState<Party[]>([]);
  const [q, setQ] = useStickyState("parties.search", "");
  const [view, setView] = useState<"active" | "archived">("active");
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Party | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const refresh = () => setRows(PartyRepo.all());
  const _repoV = useRepoData();
  useEffect(refresh, [_repoV]);

  const activeCount = rows.filter((r) => !r.archived).length;
  const archivedCount = rows.filter((r) => r.archived).length;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "n" && !e.ctrlKey && !e.metaKey && !isTyping(e)) {
        e.preventDefault();
        setEdit(null);
        setOpen(true);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const filtered = rows.filter((r) => {
    // Active/Archived are two separate views of the same list. Archived
    // parties stay fully in the books (dashboard, reports, statements read
    // every party) — they're just hidden from this default "active" view and
    // from new-transaction pickers.
    if (view === "active" ? !!r.archived : !r.archived) return false;
    const s = q.toLowerCase();
    return matchesQuery(s, r.name, r.phone);
  });

  const pg = usePagination(filtered, "parties");

  // Multi-select for bulk ledger download — same interaction as the Items
  // page, so the two lists behave identically.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [ledgerFor, setLedgerFor] = useState<Party[] | null>(null);
  const allFilteredSelected = filtered.length > 0 && filtered.every((r) => selectedIds.has(r.id));
  const toggleAllFiltered = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) filtered.forEach((r) => next.delete(r.id));
      else filtered.forEach((r) => next.add(r.id));
      return next;
    });
  };
  const toggleOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // Resolve from the live list, not the click-time snapshot, and keep the
  // on-screen order so the downloads arrive in a predictable sequence.
  const selectedParties = () => filtered.filter((r) => selectedIds.has(r.id));

  // ONE net position per party, split by sign — identical to the dashboard
  // and to each party's own statement. Summing a customer side and a
  // supplier side separately used to show a party in BOTH columns.
  const positions = netPartyPositions(rows, {
    sales: SalesRepo.all(),
    purchases: PurchaseRepo.all(),
    saleReturns: SaleReturnRepo.all(),
    purchaseReturns: PurchaseReturnRepo.all(),
    payments: PaymentRepo.all(),
  });
  const receivableByParty = new Map(positions.map((p) => [p.partyId, Math.max(0, p.net)]));
  const payableByParty = new Map(positions.map((p) => [p.partyId, Math.max(0, -p.net)]));
  // Footer totals cover the same rows the table shows — searching narrows
  // the table, so an all-party total next to a filtered count would lie.
  const receivable = filtered.reduce((a, p) => a + (receivableByParty.get(p.id) ?? 0), 0);
  const payable = filtered.reduce((a, p) => a + (payableByParty.get(p.id) ?? 0), 0);

  // Money still sitting against ARCHIVED parties. The home page counts it
  // (rightly — archiving hides a party, it doesn't cancel a debt) but the
  // Active list can't show it, which is precisely why the two screens looked
  // like they disagreed. Surface it here instead of leaving it invisible.
  const archivedReceivable = rows
    .filter((r) => r.archived)
    .reduce((a, p) => a + (receivableByParty.get(p.id) ?? 0), 0);
  const archivedPayable = rows
    .filter((r) => r.archived)
    .reduce((a, p) => a + (payableByParty.get(p.id) ?? 0), 0);
  const archivedHoldsMoney = archivedReceivable > 0.01 || archivedPayable > 0.01;

  // Archive = soft-delete (the recommended action). Just a flag update, so it
  // commits offline and orphans nothing — every document referencing this
  // party keeps working.
  const archiveParty = (r: Party) => {
    // Archiving does NOT forgive a debt. The dashboard keeps counting what an
    // archived party owes (correctly — the money is still due), but the
    // Active list stops showing them, so the two screens quietly stop
    // agreeing and the home page looks wrong. Confirm before creating that
    // situation, and say the amount out loud.
    const owed = receivableByParty.get(r.id) ?? 0;
    const owing = payableByParty.get(r.id) ?? 0;
    const outstanding = owed || owing;
    if (outstanding > 0.01) {
      const side = owed > 0.01 ? "still owes you" : "is still owed";
      const msg = [
        `${r.name} ${side} ${fmtMoney(outstanding)}.`,
        "",
        "Archiving only hides them from new bills — the amount stays in your " +
          "Receivable/Payable totals on the home page, but you won't see it in the " +
          "Active list any more.",
        "",
        "Archive anyway?",
      ].join("\n");
      if (!confirm(msg)) return;
    }
    PartyRepo.update(r.id, { archived: true });
    refresh();
    toast.success(`${r.name} archived — hidden from new transactions, history kept`);
  };
  const restoreParty = (r: Party) => {
    // Same duplicate-name rule the create/edit dialog enforces — restoring must
    // not leave two ACTIVE parties sharing a name (only possible when a
    // same-name active party was created while this one was archived).
    const clash = PartyRepo.all().find(
      (p) =>
        p.id !== r.id && !p.archived && p.name.trim().toLowerCase() === r.name.trim().toLowerCase(),
    );
    if (clash) {
      toast.error(
        `An active party named "${clash.name}" already exists — rename it before restoring "${r.name}".`,
      );
      return;
    }
    PartyRepo.update(r.id, { archived: false });
    refresh();
    toast.success(`${r.name} restored`);
  };

  /** Exactly what is keeping this party from being deleted, in plain words.
   *
   * This used to be a single boolean behind one generic message ("contains
   * accounting history"), which reads as "delete is broken" to anyone who has
   * just cleared what they thought was everything — most often an opening
   * balance they forgot about, or a payment that stayed behind after the
   * bills were removed. Naming the exact records, with counts, turns a dead
   * end into an instruction. */
  const deleteBlockers = (r: Party): string[] => {
    // allWithVoided throughout: a cancelled bill is still this party's
    // history, and the ledger still carries both it and its reversal against
    // them. A guard that cannot see cancelled documents would let the party
    // be deleted out from under their own ledger.
    const counts: [string, number][] = [
      ["sale", SalesRepo.allWithVoided().filter((i) => i.partyId === r.id).length],
      ["purchase", PurchaseRepo.allWithVoided().filter((i) => i.partyId === r.id).length],
      ["sale return", SaleReturnRepo.allWithVoided().filter((i) => i.partyId === r.id).length],
      [
        "purchase return",
        PurchaseReturnRepo.allWithVoided().filter((i) => i.partyId === r.id).length,
      ],
      ["payment", PaymentRepo.allWithVoided().filter((i) => i.partyId === r.id).length],
    ];
    const blockers = counts
      .filter(([, n]) => n > 0)
      .map(([label, n]) => `${n} ${label}${n > 1 ? "s" : ""}`);
    if ((r.openingBalance ?? 0) !== 0) {
      blockers.push(`an opening balance of ${fmtMoney(r.openingBalance ?? 0)}`);
    }
    return blockers;
  };

  // Permanent delete is the rare exception, not the norm. Owner-only: only the
  // owner hydrates every collection, so the history check is reliable — a
  // permission-scoped user might have some collections unloaded and get a
  // false "no history". Also requires a zero opening balance, since that is
  // real outstanding money the history check alone wouldn't catch.
  const permanentlyDelete = (r: Party) => {
    if (!isOwner) {
      toast.error("Only the owner can permanently delete a party. Use Archive instead.");
      return;
    }
    const blockers = deleteBlockers(r);
    if (blockers.length) {
      toast.error(
        `Can't delete ${r.name} — still linked to ${blockers.join(", ")}. ` +
          "Delete those first, or Archive the party to hide it while keeping its history.",
        { duration: 8000 },
      );
      return;
    }
    if (confirm(`Permanently delete ${r.name}? This cannot be undone.`)) {
      PartyRepo.remove(r.id);
      refresh();
      toast.success("Party permanently deleted");
    }
  };

  const columns: Column<Party>[] = [
    {
      key: "sel",
      label: "",
      width: "32px",
      render: (r) => (
        <input
          type="checkbox"
          checked={selectedIds.has(r.id)}
          onChange={() => toggleOne(r.id)}
          onClick={(e) => e.stopPropagation()}
          className="accent-primary"
          aria-label={`Select ${r.name}`}
        />
      ),
    },
    {
      key: "name",
      label: "Name",
      render: (r) => r.name,
      sortValue: (r) => r.name,
    },
    { key: "phone", label: "Phone", width: "160px", render: (r) => r.phone ?? "—" },
    {
      key: "receivable",
      label: "Receivable",
      align: "right",
      width: "130px",
      render: (r) => {
        const v = receivableByParty.get(r.id) ?? 0;
        return v > 0 ? <span className="tabular-nums">{fmtMoney(v)}</span> : "—";
      },
      sortValue: (r) => receivableByParty.get(r.id) ?? 0,
    },
    {
      key: "payable",
      label: "Payable",
      align: "right",
      width: "130px",
      render: (r) => {
        const v = payableByParty.get(r.id) ?? 0;
        return v > 0 ? <span className="tabular-nums">{fmtMoney(v)}</span> : "—";
      },
      sortValue: (r) => payableByParty.get(r.id) ?? 0,
    },
    {
      key: "credit",
      label: "Credit Limit",
      align: "right",
      width: "130px",
      render: (r) => (r.creditLimit ? fmtMoney(r.creditLimit) : "—"),
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
              navigate({ to: "/parties/$id", params: { id: r.id } });
            }}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-primary-soft hover:text-primary hover:border-primary/25"
            title="View statement"
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
              title="Edit party"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {editAllowed &&
            (r.archived ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  restoreParty(r);
                }}
                className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-emerald-50 hover:text-emerald-600 hover:border-emerald-200"
                title="Restore party"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  archiveParty(r);
                }}
                className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-amber-50 hover:text-amber-600 hover:border-amber-200"
                title="Archive party"
              >
                <Archive className="h-3.5 w-3.5" />
              </button>
            ))}
          {/* Permanent delete: owner-only, and only meaningful for a party
              with no accounting history — permanentlyDelete enforces both and
              explains via toast when it's blocked. */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setLedgerFor([r]);
            }}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-primary-soft hover:text-primary hover:border-primary/25"
            title="Download ledger (choose a date range)"
          >
            <FileDown className="h-3.5 w-3.5" />
          </button>
          {isOwner && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                permanentlyDelete(r);
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200"
              title="Permanently delete (only if no history)"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      ),
    },
  ];

  // The Active/Archived toggle (shared markup). On mobile it sits in the free
  // space to the right of the title (via PageHeader's mobileAction slot); on
  // sm+ it stays inline in the actions row. Same buttons either way.
  const viewToggleButtons = (
    <>
      <button
        onClick={() => setView("active")}
        className={`h-8 px-3 text-xs font-semibold transition ${view === "active" ? "bg-primary text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
      >
        Active ({activeCount})
      </button>
      <button
        onClick={() => setView("archived")}
        className={`h-8 px-3 text-xs font-semibold transition ${view === "archived" ? "bg-primary text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
      >
        Archived ({archivedCount})
      </button>
    </>
  );

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Parties"
        subtitle={`${rows.length} customers / suppliers`}
        icon={<Users className="h-5 w-5" />}
        mobileAction={
          <div className="inline-flex rounded-md border border-gray-200 bg-white overflow-hidden shrink-0">
            {viewToggleButtons}
          </div>
        }
        actions={
          <>
            <div className="hidden sm:inline-flex rounded-md border border-gray-200 bg-white overflow-hidden shrink-0">
              {viewToggleButtons}
            </div>
            <div className="relative w-full sm:w-44 lg:w-56">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                ref={searchRef}
                placeholder="Search parties..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-full h-8 pl-8 pr-3 border border-gray-200 rounded-md text-base md:text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
              />
            </div>
            {editAllowed && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setBulkOpen(true)}
                className="w-full sm:w-auto"
              >
                <Upload className="h-3.5 w-3.5" /> Bulk Import
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
                <Plus className="h-3.5 w-3.5" /> New Party
              </Button>
            )}
          </>
        }
      />
      {selectedIds.size > 0 && (
        <div className="px-3 sm:px-5 py-2 border-b bg-primary-soft flex items-center gap-3 flex-wrap no-print">
          <label className="flex items-center gap-1.5 text-xs font-medium text-primary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allFilteredSelected}
              onChange={toggleAllFiltered}
              className="accent-primary"
            />
            Select all {filtered.length}
          </label>
          <span className="text-xs font-semibold text-foreground">{selectedIds.size} selected</span>
          <div className="flex items-center gap-2 ml-auto">
            <Button size="sm" variant="outline" onClick={() => setLedgerFor(selectedParties())}>
              <FileDown className="h-3.5 w-3.5" /> Download Ledgers
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}
      {view === "active" && archivedHoldsMoney && (
        <button
          type="button"
          onClick={() => setView("archived")}
          className="no-print w-full text-left px-3 sm:px-5 py-2 bg-amber-50 border-b border-amber-200 text-[12px] text-amber-800 flex flex-wrap items-center gap-x-2 gap-y-1 hover:bg-amber-100 transition"
        >
          <span className="font-semibold">Archived parties still hold money:</span>
          {archivedReceivable > 0.01 && <span>{fmtMoney(archivedReceivable)} receivable</span>}
          {archivedReceivable > 0.01 && archivedPayable > 0.01 && <span>·</span>}
          {archivedPayable > 0.01 && <span>{fmtMoney(archivedPayable)} payable</span>}
          <span className="underline">View archived</span>
          <span className="w-full text-[11px] text-amber-700/80">
            This is included in the home page totals, which is why they can look higher than the
            list below.
          </span>
        </button>
      )}
      {/* Mobile card list — a table of 6 columns doesn't fit a phone; this
          is the same data as one tappable card per party instead. */}
      <div className="md:hidden flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <Users className="h-10 w-10 mx-auto mb-3 text-gray-200" />
            <p className="font-medium">No parties found</p>
            <p className="text-xs mt-1">Try adjusting your search or add a new party</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pg.paged.map((r) => (
              <div
                key={r.id}
                onClick={() => navigate({ to: "/parties/$id", params: { id: r.id } })}
                className="bg-white p-4 active:bg-gray-50"
              >
                <div className="flex items-start justify-between gap-3 mb-1.5">
                  <div className="flex items-start gap-3 min-w-0">
                    {/* Generous tap target — a bare 16px checkbox is a
                        mis-tap magnet next to a card that navigates. */}
                    <label
                      onClick={(e) => e.stopPropagation()}
                      className="shrink-0 -m-1 p-1 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.has(r.id)}
                        onChange={() => toggleOne(r.id)}
                        className="accent-primary h-4 w-4 align-middle"
                        aria-label={`Select ${r.name}`}
                      />
                    </label>
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-800 truncate">{r.name}</p>
                      <p className="text-xs text-gray-400 mt-0.5 truncate">
                        {r.phone || "No phone"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setLedgerFor([r]);
                      }}
                      className="p-1.5 rounded hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition"
                      title="Download ledger"
                    >
                      <FileDown className="h-4 w-4" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate({ to: "/parties/$id", params: { id: r.id } });
                      }}
                      className="p-1.5 rounded hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition"
                      title="View statement"
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
                        title="Edit party"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {editAllowed &&
                      (r.archived ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            restoreParty(r);
                          }}
                          className="p-1.5 rounded hover:bg-emerald-50 text-gray-400 hover:text-emerald-600 transition"
                          title="Restore party"
                        >
                          <ArchiveRestore className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            archiveParty(r);
                          }}
                          className="p-1.5 rounded hover:bg-amber-50 text-gray-400 hover:text-amber-600 transition"
                          title="Archive party"
                        >
                          <Archive className="h-3.5 w-3.5" />
                        </button>
                      ))}
                    {isOwner && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          permanentlyDelete(r);
                        }}
                        className="p-1.5 rounded hover:bg-rose-50 text-gray-400 hover:text-rose-600 transition"
                        title="Permanently delete (only if no history)"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  {r.archived && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                      Archived
                    </span>
                  )}
                  {(receivableByParty.get(r.id) ?? 0) > 0 && (
                    <span>
                      <span className="text-gray-400">Receivable </span>
                      <span className="font-semibold tabular-nums text-emerald-600">
                        {fmtMoney(receivableByParty.get(r.id) ?? 0)}
                      </span>
                    </span>
                  )}
                  {(payableByParty.get(r.id) ?? 0) > 0 && (
                    <span>
                      <span className="text-gray-400">Payable </span>
                      <span className="font-semibold tabular-nums text-rose-600">
                        {fmtMoney(payableByParty.get(r.id) ?? 0)}
                      </span>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Table (desktop) */}
      <div className="hidden md:flex flex-1 min-h-0 p-6">
        <DataTable
          storageKey="parties"
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.id}
          footer={
            <tr>
              {/* Spans the select checkbox + Name + Phone. Must match the
                  real column count or the last column drops outside the
                  footer row entirely. */}
              <td colSpan={3}>Total ({filtered.length} parties)</td>
              <td className="text-right tabular-nums">{fmtMoney(receivable)}</td>
              <td className="text-right tabular-nums">{fmtMoney(payable)}</td>
              <td colSpan={2} />
            </tr>
          }
          activateOnClick
          onRowActivate={(r) => navigate({ to: "/parties/$id", params: { id: r.id } })}
          onDelete={(r) => {
            // Ctrl+Delete reaches this directly, bypassing the row buttons —
            // route it through the same owner-only, no-history, zero-opening
            // -balance guard so the keyboard path can't skip the checks.
            permanentlyDelete(r);
          }}
        />
      </div>
      <PartyDialog
        open={open}
        onOpenChange={setOpen}
        party={edit}
        onSaved={() => {
          refresh();
        }}
      />
      <BulkPartyImportDialog open={bulkOpen} onOpenChange={setBulkOpen} onSaved={refresh} />
      <PartyLedgerExportDialog
        open={!!ledgerFor}
        onOpenChange={(v) => !v && setLedgerFor(null)}
        parties={ledgerFor ?? []}
      />
    </div>
  );
}

function BulkPartyImportDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<PartyPreviewRow[]>([]);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (open) {
      setFileName("");
      setRows([]);
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [open]);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    // Shared parser — same WPS/Excel/CSV handling as item import.
    const table = await parseImportFile(file);
    if (!table.length) {
      toast.error("File looks empty or unreadable — export it as CSV/Excel and try again");
      setRows([]);
      return;
    }
    const header = table[0].map(normalizeHeader);
    if (!PARTY_ALIASES.name.some((a) => header.includes(a))) {
      toast.error(
        `No "Name" column found. First row of your file: "${table[0].join(", ").slice(0, 100)}" — download the Sample to see the expected format`,
      );
      setRows([]);
      return;
    }
    setRows(buildPartyPreview(table, PartyRepo.all()));
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
            // Descriptive fields only — opening balance is NEVER changed on an
            // existing party by import (it feeds their ledger balance).
            PartyRepo.updateBatched(batch, r.matchId, {
              phone: r.phone,
              type: r.type,
              creditLimit: r.creditLimit,
              gstin: r.gstin,
            });
          } else {
            PartyRepo.addBatched(batch, {
              id: genId(),
              name: r.name,
              type: r.type,
              phone: r.phone,
              gstin: r.gstin,
              openingBalance: r.openingBalance,
              creditLimit: r.creditLimit,
              createdAt: new Date().toISOString(),
            } as Party);
          }
        }
        if (!(await commitBatch(batch, "bulk party import"))) committed = false;
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
          <DialogTitle>Bulk Import Parties</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-muted-foreground max-w-lg">
              Matches by <b>Phone</b> then <b>Name</b> — matched rows update the existing party,
              unmatched rows create a new one. Opening Balance is only set for new parties; an
              existing party's balance is never changed by import.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => downloadCsv("parties-template", [...PARTY_BULK_COLUMNS], [])}
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
                      <th className="sticky top-0 z-10 bg-muted text-left p-1.5">Phone</th>
                      <th className="sticky top-0 z-10 bg-muted text-right p-1.5">Opening Bal.</th>
                      <th className="sticky top-0 z-10 bg-muted text-left p-1.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.rowNum} className="border-t">
                        <td className="p-1.5">{r.rowNum}</td>
                        <td className="p-1.5">{r.name || "—"}</td>
                        <td className="p-1.5">{r.phone ?? "—"}</td>
                        <td className="p-1.5 text-right tabular-nums">
                          {r.status === "update" ? "—" : fmtMoney(r.openingBalance)}
                        </td>
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

export function PartyDialog({
  open,
  onOpenChange,
  party,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  party: Party | null;
  onSaved: () => void;
}) {
  const firstRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<Partial<Party>>({});
  const [saving, setSaving] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  /* Which side the opening balance sits on, held as its own answer.
   *
   * It used to be read back off the sign of the amount, which meant the
   * choice could not be made before the amount was: on a new party the
   * amount is 0, "Payable" stored -0, and -0 < 0 is FALSE — so the button
   * lit up green again the moment it was clicked and the direction appeared
   * to do nothing at all. The stored field stays signed, because that is
   * what every balance calculation reads; only the form keeps the two
   * apart. */
  const [openingDir, setOpeningDir] = useState<"receivable" | "payable">("receivable");

  useEffect(() => {
    if (open) {
      setForm(party ?? { type: "both", openingBalance: 0 });
      setOpeningDir((party?.openingBalance ?? 0) < 0 ? "payable" : "receivable");
      setSaving(false);
      setNameOpen(false);
      setTimeout(() => firstRef.current?.focus(), 50);
    }
  }, [open, party]);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (!form.name?.trim()) {
      toast.error("Name is required");
      return;
    }
    // Repeat parties cannot be added — block duplicate names (case/spacing
    // insensitive) so "ABC" and "abc " don't end up as two separate parties.
    const dup = PartyRepo.all().find(
      (p) => p.name.trim().toLowerCase() === form.name!.trim().toLowerCase() && p.id !== party?.id,
    );
    if (dup) {
      toast.error(
        dup.archived
          ? `"${dup.name}" is in Archived — restore it instead of creating a duplicate`
          : `Party "${dup.name}" already exists — repeat parties cannot be added`,
      );
      return;
    }
    setSaving(true);
    if (party) {
      PartyRepo.update(party.id, form as Party);
      toast.success("Party updated");
    } else {
      PartyRepo.add({
        ...form,
        name: form.name!,
        type: "both",
        openingBalance: form.openingBalance ?? 0,
      });
      toast.success("Party created");
    }
    onSaved();
    onOpenChange(false);
  };

  // Live "does this already exist?" hint — the exact-match case is hard
  // blocked on save, but a near-match (extra word, different spacing) isn't
  // an error, just something the client asked to be warned about before
  // they commit to a possible duplicate.
  const nameQ = (form.name ?? "").trim().toLowerCase();
  const similarPartiesAll = nameQ
    ? PartyRepo.all().filter(
        (p) => p.id !== party?.id && p.name.trim().toLowerCase().includes(nameQ),
      )
    : [];
  const similarParties = similarPartiesAll.slice(0, 5);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl"
        onKeyDown={(e) => {
          if (e.key === "Escape") onOpenChange(false);
        }}
      >
        <DialogHeader>
          <DialogTitle>{party ? "Edit Party" : "New Party"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="relative">
            <Field
              ref={firstRef}
              label="Name *"
              value={form.name ?? ""}
              onChange={(e) => {
                setForm({ ...form, name: e.target.value });
                setNameOpen(true);
              }}
              onFocus={() => setNameOpen(true)}
              onBlur={() => setTimeout(() => setNameOpen(false), 150)}
              autoComplete="off"
            />
            {nameOpen && similarParties.length > 0 && (
              <div className="absolute z-30 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-elevated max-h-52 overflow-auto">
                <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 bg-amber-50 border-b flex items-center gap-1.5">
                  <AlertTriangle className="h-3 w-3" />
                  {similarPartiesAll.length === 1
                    ? "Similar party exists"
                    : "Similar parties exist"}
                  — check before saving
                </div>
                {similarParties.map((p) => (
                  <div key={p.id} className="px-3 py-2 text-sm flex items-center justify-between">
                    <span className="font-medium">{p.name}</span>
                    {p.phone && (
                      <span className="text-[11px] text-muted-foreground">{p.phone}</span>
                    )}
                  </div>
                ))}
                {similarPartiesAll.length > similarParties.length && (
                  <div className="px-3 py-1.5 text-[11px] text-muted-foreground border-t">
                    +{similarPartiesAll.length - similarParties.length} more match
                    {similarPartiesAll.length - similarParties.length > 1 ? "es" : ""}
                  </div>
                )}
              </div>
            )}
          </div>
          <Field
            label="Phone"
            value={form.phone ?? ""}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
          {/* Direction is a CHOICE, not a minus sign.
              This used to be one signed number labelled "+ they owe you,
              − you owe them". A supplier's opening typed as a positive
              number therefore landed in Receivable, and the client read
              that as "payable didn't update" — the amount was right, it was
              just on the wrong side, with nothing on screen to say so. */}
          <div className="sm:col-span-2">
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">
              Opening Balance
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <div
                role="radiogroup"
                aria-label="Opening balance side"
                className="inline-flex rounded-md border border-gray-200 overflow-hidden shrink-0"
              >
                {/* "Receivable" and "Payable", not "They owe me" / "I owe
                    them". Those read as friendlier English but they are not
                    the words on any other screen in the app, so the person at
                    the counter has to translate them against the Dashboard,
                    the party list and the statement every time. One vocabulary
                    across the whole app is what makes it learnable. */}
                {(
                  [
                    ["receivable", "Receivable", "they owe you"],
                    ["payable", "Payable", "you owe them"],
                  ] as const
                ).map(([dir, text, hint]) => (
                  <button
                    key={dir}
                    type="button"
                    role="radio"
                    aria-checked={openingDir === dir}
                    title={`Opening balance is ${text.toLowerCase()} — ${hint}`}
                    onClick={() => {
                      setOpeningDir(dir);
                      const amount = Math.abs(form.openingBalance ?? 0);
                      setForm({
                        ...form,
                        openingBalance: dir === "payable" ? -amount : amount,
                      });
                    }}
                    className={`h-9 px-3 text-xs font-semibold transition whitespace-nowrap ${
                      openingDir === dir
                        ? dir === "payable"
                          ? "bg-rose-600 text-white"
                          : "bg-emerald-600 text-white"
                        : "bg-white text-gray-500 hover:bg-gray-50"
                    }`}
                  >
                    {text}
                  </button>
                ))}
              </div>
              <div className="flex-1">
                <NumInput
                  value={Math.abs(form.openingBalance ?? 0)}
                  aria-label="Opening balance amount"
                  onValue={(n) =>
                    setForm({
                      ...form,
                      openingBalance: openingDir === "payable" ? -Math.abs(n) : Math.abs(n),
                    })
                  }
                  className="w-full h-9 px-3 border border-gray-200 rounded-md text-base md:text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-200 text-right tabular-nums"
                />
              </div>
            </div>
            <p className="text-[11px] text-gray-400 mt-1">
              {Math.abs(form.openingBalance ?? 0) === 0
                ? "No opening balance."
                : openingDir === "payable"
                  ? `Payable ${fmtMoney(Math.abs(form.openingBalance ?? 0))} — money you owe them.`
                  : `Receivable ${fmtMoney(Math.abs(form.openingBalance ?? 0))} — money they owe you.`}
            </p>
          </div>
          <NumField
            label="Credit Limit"
            value={form.creditLimit ?? 0}
            onValue={(n) => setForm({ ...form, creditLimit: n || undefined })}
          />
          <div className="sm:col-span-2 flex justify-end gap-2 mt-2">
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

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  return (
    el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      el.isContentEditable)
  );
}

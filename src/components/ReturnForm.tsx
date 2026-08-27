import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/Field";
import {
  PartyRepo,
  ItemRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  CompanyRepo,
  nextInvoiceNumber,
  SalesRepo,
  PurchaseRepo,
} from "@/repositories";
import type { Return, LineItem, Party, Item, Invoice } from "@/types";
import { fmtMoney, today } from "@/lib/format";
import { toast } from "sonner";
import { Trash2, UserPlus, Save, X, CornerDownLeft, CornerUpLeft, Loader2 } from "lucide-react";
import { genId, newBatch, commitBatch } from "@/repositories/base";
import { stepBackOnBackspace, useEscapeToLeave } from "@/hooks/useFormKeys";
import { usePeriodLock } from "@/hooks/usePeriodLock";
import { stockShortfalls } from "@/lib/stock";
import { NumInput } from "@/components/NumInput";
import { QuickAddPartyDialog, type QuickAddPartyDetails } from "@/components/QuickAddPartyDialog";
import { useRepoData, useRepoMemo } from "@/hooks/useRepoData";
import { matchesQuery, byRelevance } from "@/lib/search";

/** See the note on the same constant in InvoiceForm — a rendering guard, not
 * a search limit. */
const MAX_SUGGESTIONS = 200;

interface Props {
  mode: "sale-return" | "purchase-return";
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function ReturnForm({ mode }: Props) {
  // Key every repo read on this version — the app renders before the
  // collections finish loading, so a mount-time snapshot is empty on a cold
  // open. See the same note in InvoiceForm.
  const _repoV = useRepoData();
  const navigate = useNavigate();
  const company = CompanyRepo.get();
  const isSaleReturn = mode === "sale-return";
  const repo = isSaleReturn ? SaleReturnRepo : PurchaseReturnRepo;
  const prefix = isSaleReturn
    ? company.invoicePrefix.replace("INV-", "CR-") || "CR-"
    : company.purchasePrefix.replace("PUR-", "DR-") || "DR-";
  const backPath = isSaleReturn ? "/sale-return" : "/purchase-return";

  const [ret, setRet] = useState<Return>(() => ({
    id: "",
    number: nextInvoiceNumber(prefix, repo.all()),
    date: today(),
    originalRef: "",
    partyId: "",
    partyName: "",
    partyPhone: "",
    // Matches InvoiceForm — starts off, turned on per-document when needed.
    gstEnabled: false,
    lineItems: [],
    subtotal: 0,
    taxAmount: 0,
    total: 0,
    notes: "",
    createdAt: "",
  }));

  const gstOn = ret.gstEnabled !== false;
  const allParties = useRepoMemo(() => PartyRepo.all());
  const items = useRepoMemo(() => ItemRepo.all());
  // After an item is picked, focus goes to THAT line's Qty field (id
  // "qty-<lineId>") so the returned quantity can be typed immediately —
  // matching Sales' invoice form — not back into the search box.
  const focusQtyId = useRef<string | null>(null);
  useEffect(() => {
    if (focusQtyId.current) {
      const el = document.getElementById(`qty-${focusQtyId.current}`) as HTMLInputElement | null;
      el?.focus();
      el?.select();
      focusQtyId.current = null;
    }
  }, [ret.lineItems]);
  useEffect(() => {
    const next = nextInvoiceNumber(prefix, repo.all());
    setRet((cur) => (cur.number === next ? cur : { ...cur, number: next }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_repoV]);

  const partyRef = useRef<HTMLInputElement>(null);
  const [partyQ, setPartyQ] = useState("");
  const [partyOpen, setPartyOpen] = useState(false);
  const [partyIdx, setPartyIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const { canPost } = usePeriodLock();
  // A party typed at the counter that doesn't exist yet is no longer
  // silently created with just a bare name — this opens a quick-add dialog
  // asking for phone/opening balance/GSTIN before it's actually created.
  const [quickAddParty, setQuickAddParty] = useState<{ name: string; phone: string } | null>(null);

  // "Return against invoice": search the original bill and auto-load its items
  const [invQ, setInvQ] = useState("");
  const [invOpen, setInvOpen] = useState(false);
  const [invIdx, setInvIdx] = useState(0);
  const invoiceRepo = isSaleReturn ? SalesRepo : PurchaseRepo;

  const invSuggests = useRepoMemo(() => {
    const q = invQ.trim().toLowerCase();
    // Once a customer/supplier is picked, a return can only ever be against
    // one of THEIR bills — scope the search to just their invoices instead
    // of browsing every party's, same as the party field itself narrows
    // things down first.
    const pool = ret.partyId
      ? invoiceRepo.all().filter((i) => i.partyId === ret.partyId)
      : invoiceRepo.all();
    // Empty query — browse the most recent bills (already newest-first),
    // like every other search-as-you-type field in this app.
    if (!q) return pool.slice(0, MAX_SUGGESTIONS);
    return pool
      .filter((i) => matchesQuery(q, i.number, i.partyName))
      .sort(byRelevance(q, (i) => i.number))
      .slice(0, MAX_SUGGESTIONS);
  }, [invQ, invoiceRepo, ret.partyId]);

  const loadFromInvoice = (inv: Invoice) => {
    const lines = inv.lineItems.map((l) => ({ ...l, id: genId() }));
    const gst = inv.gstEnabled !== false;
    setRet({
      ...ret,
      originalRef: inv.number,
      partyId: inv.partyId,
      partyName: inv.partyName,
      partyPhone: inv.partyPhone,
      gstEnabled: inv.gstEnabled,
      lineItems: lines,
      ...recalc(lines, gst),
    });
    setPartyQ(inv.partyName);
    setInvQ(inv.number);
    setInvOpen(false);
    toast.success(
      `Loaded ${lines.length} item${lines.length > 1 ? "s" : ""} from ${inv.number} — remove items or adjust qty to what actually came back`,
    );
  };

  const partySuggests = useMemo(() => {
    // Archived parties are hidden from the picker; `allParties` stays full for
    // save-time dedup, which auto-restores an archived match instead of
    // creating a duplicate.
    const active = allParties.filter((p) => !p.archived);
    const q = partyQ.trim().toLowerCase();
    // Empty query — browse the full party list (like a combobox), instead
    // of showing nothing until the user starts typing.
    if (!q) return active.slice(0, MAX_SUGGESTIONS);
    return active
      .filter((p) => matchesQuery(q, p.name, p.phone))
      .sort(byRelevance(q, (p) => p.name))
      .slice(0, MAX_SUGGESTIONS);
  }, [partyQ, allParties]);

  useEffect(() => {
    partyRef.current?.focus();
  }, []);

  const recalc = (lines: LineItem[], gst = gstOn) => {
    const subtotal = r2(lines.reduce((s, l) => s + l.qty * l.price, 0));
    const afterDisc = r2(
      lines.reduce((s, l) => s + r2(l.qty * l.price * (1 - l.discountPct / 100)), 0),
    );
    const taxAmount = gst
      ? r2(
          lines.reduce(
            (s, l) => s + r2(r2(l.qty * l.price * (1 - l.discountPct / 100)) * (l.gstRate / 100)),
            0,
          ),
        )
      : 0;
    const total = r2(afterDisc + taxAmount);
    return { subtotal, taxAmount, total };
  };

  const selectParty = (p: Party) => {
    setRet({ ...ret, partyId: p.id, partyName: p.name, partyPhone: p.phone ?? "" });
    setPartyQ(p.name);
    setPartyOpen(false);
    // Matches Sales' invoice form — party picked, land on Date next.
    setTimeout(() => document.getElementById("ret-date")?.focus(), 30);
  };

  const addLineItem = (it: Item) => {
    // Same item twice = one line with higher qty (keeps the over-return cap honest)
    const existingLine = ret.lineItems.find((l) => l.itemId === it.id);
    if (existingLine) {
      updateLine(existingLine.id, { qty: existingLine.qty + 1 });
      toast.info(`${it.name} — quantity increased to ${existingLine.qty + 1}`);
      focusQtyId.current = existingLine.id;
      return;
    }
    const line: LineItem = {
      id: genId(),
      itemId: it.id,
      name: it.name,
      qty: 1,
      unit: it.unit,
      price: isSaleReturn ? it.salePrice || it.purchasePrice : it.purchasePrice,
      discountPct: 0,
      gstRate: it.gstRate,
      amount: 0,
      costPrice: it.purchasePrice,
    };
    const gstMult = gstOn ? 1 + line.gstRate / 100 : 1;
    line.amount = r2(r2(line.qty * line.price) * gstMult);
    const lines = [...ret.lineItems, line];
    setRet({ ...ret, lineItems: lines, ...recalc(lines) });
    focusQtyId.current = line.id;
  };

  const updateLine = (id: string, patch: Partial<LineItem>) => {
    const lines = ret.lineItems.map((l) => {
      if (l.id !== id) return l;
      const nl = { ...l, ...patch };
      // Clamp so a mistyped discount (e.g. 500 instead of 50) or a negative
      // GST rate can never flip the line amount negative.
      nl.discountPct = Math.min(100, Math.max(0, nl.discountPct));
      nl.gstRate = Math.max(0, nl.gstRate);
      const gstMult = gstOn ? 1 + nl.gstRate / 100 : 1;
      nl.amount = r2(r2(nl.qty * nl.price * (1 - nl.discountPct / 100)) * gstMult);
      return nl;
    });
    setRet({ ...ret, lineItems: lines, ...recalc(lines) });
  };

  const removeLine = (id: string) => {
    const lines = ret.lineItems.filter((l) => l.id !== id);
    setRet({ ...ret, lineItems: lines, ...recalc(lines) });
  };

  const toggleGst = () => {
    const newGst = !gstOn;
    const lines = ret.lineItems.map((l) => {
      const gstMult = newGst ? 1 + l.gstRate / 100 : 1;
      return { ...l, amount: r2(r2(l.qty * l.price * (1 - l.discountPct / 100)) * gstMult) };
    });
    setRet({ ...ret, gstEnabled: newGst, lineItems: lines, ...recalc(lines, newGst) });
  };

  // Runs once the party is fully resolved — either an existing match, or a
  // brand-new one whose details were just collected via the quick-add
  // dialog (never silently defaulted to just a bare name, as before).
  const finalizeSave = (party: { id: string; name: string } | { create: Party }) => {
    savingRef.current = true;
    setSaving(true);

    // The new party (if any), the return document, and its stock adjustments
    // must all land together or not at all — a shared batch commits them as
    // one atomic Firestore write, so a failed commit can't leave an orphaned
    // party with no corresponding return.
    const batch = newBatch();

    let partyId: string;
    let partyName: string;
    if ("create" in party) {
      PartyRepo.addBatched(batch, party.create);
      partyId = party.create.id;
      partyName = party.create.name;
      toast.success(`New party added: ${partyName}`);
    } else {
      partyId = party.id;
      partyName = party.name;
      // Reusing an archived party means they're active again — restore in the
      // same batch (matches the sale/purchase form's behaviour).
      if (PartyRepo.get(partyId)?.archived) {
        PartyRepo.updateBatched(batch, partyId, { archived: false });
      }
    }

    const finalRet: Return = {
      ...ret,
      number: (ret.number ?? "").trim(),
      partyId,
      partyName,
      createdAt: new Date().toISOString(),
    };

    // Sale Return → items come BACK to stock (+qty)
    // Purchase Return → items GO BACK to supplier (-qty)
    const stockDelta = isSaleReturn ? 1 : -1;
    for (const l of finalRet.lineItems) {
      const it = ItemRepo.get(l.itemId);
      if (it) ItemRepo.adjustFieldBatched(batch, it.id, "stock", stockDelta * l.qty);
    }

    repo.addBatched(batch, finalRet);
    commitBatch(batch, `save ${isSaleReturn ? "sale return" : "purchase return"}`);
    toast.success(`${isSaleReturn ? "Sale Return" : "Purchase Return"} saved`);
    navigate({ to: backPath });
  };

  const save = () => {
    if (savingRef.current) return; // double-click protection
    // One date only: a return is created, never edited, so there is no
    // previous date it could be moved away from.
    if (!canPost(ret.date)) return;
    const noteNo = (ret.number ?? "").trim();
    if (!noteNo) {
      toast.error(`${isSaleReturn ? "Credit" : "Debit"} note number is required`);
      return;
    }
    if (repo.all().some((r) => (r.number ?? "").trim() === noteNo)) {
      toast.error(
        `${isSaleReturn ? "Credit" : "Debit"} note number ${noteNo} is already used — reload the page and try again`,
      );
      return;
    }
    const partyId = ret.partyId;
    const partyName = ret.partyName || partyQ.trim();
    if (!partyId && !partyName) {
      toast.error("Enter party name");
      partyRef.current?.focus();
      return;
    }
    if (!ret.lineItems.length) {
      toast.error("Add at least one item");
      return;
    }
    const badLine = ret.lineItems.find((l) => !(l.qty > 0) || l.price < 0);
    if (badLine) {
      toast.error(`Check quantity/price for "${badLine.name}" — qty must be more than 0`);
      return;
    }
    // Purchase returns send stock back OUT to the supplier — sale returns bring it back IN
    if (!isSaleReturn && company.allowNegativeStock === false) {
      const shortfalls = stockShortfalls(ret.lineItems);
      if (shortfalls.length) {
        toast.error(`Not enough stock to return — ${shortfalls.join(", ")}`);
        return;
      }
    }

    // When this return is LINKED to an original bill, cap each item's return
    // qty at what's actually left to return on that bill (across all prior
    // returns against it) — otherwise the same bill could be returned twice or
    // beyond what it sold, crediting stock and the party's balance more than
    // once. A typed bill number that matches nothing is rejected as a likely
    // typo. A blank reference is a legitimate standalone credit/debit note
    // (walk-in return, or goods whose original bill isn't in the system —
    // common after migration); like Vyapar/Tally it isn't qty-capped, since
    // there is no specific bill to cap against. (An earlier build capped these
    // by the party's net transacted qty, but that both blocked legitimate
    // cross-party/walk-in returns AND was bypassable by typing the party name
    // instead of selecting it, so it was removed in favour of this per-bill rule.)
    const ref = (ret.originalRef ?? "").trim();
    if (ref) {
      const originalInvoice = invoiceRepo.all().find((i) => i.number.trim() === ref);
      if (!originalInvoice) {
        toast.error(
          `No ${isSaleReturn ? "invoice" : "bill"} numbered "${ref}" found — check the number, or clear the field for a return without a linked bill.`,
        );
        return;
      }
      const originalQty = new Map<string, number>();
      for (const l of originalInvoice.lineItems) {
        originalQty.set(l.itemId, (originalQty.get(l.itemId) ?? 0) + l.qty);
      }
      const alreadyReturned = new Map<string, number>();
      for (const r of repo.all()) {
        if ((r.originalRef ?? "").trim() !== ref) continue;
        for (const l of r.lineItems) {
          alreadyReturned.set(l.itemId, (alreadyReturned.get(l.itemId) ?? 0) + l.qty);
        }
      }
      const thisReturnQty = new Map<string, number>();
      for (const l of ret.lineItems) {
        thisReturnQty.set(l.itemId, r2((thisReturnQty.get(l.itemId) ?? 0) + l.qty));
      }
      for (const l of ret.lineItems) {
        const bought = originalQty.get(l.itemId) ?? 0;
        const already = alreadyReturned.get(l.itemId) ?? 0;
        const remaining = r2(bought - already);
        const returningNow = thisReturnQty.get(l.itemId) ?? l.qty;
        if (returningNow > remaining + 0.0001) {
          toast.error(
            remaining > 0
              ? `"${l.name}" — only ${remaining} ${l.unit} left to return from ${ref} (already returned ${already})`
              : `"${l.name}" has already been fully returned from ${ref}`,
          );
          return;
        }
      }
    }

    if (partyId) {
      finalizeSave({ id: partyId, name: partyName });
      return;
    }
    const match = allParties.find((p) => p.name.toLowerCase() === partyName.toLowerCase());
    if (match) {
      finalizeSave({ id: match.id, name: match.name });
      return;
    }
    // No match — this would previously auto-create a bare-bones party with
    // just a name recorded. Ask for the real details instead.
    setQuickAddParty({ name: partyName, phone: "" });
  };

  const confirmQuickAddParty = (details: QuickAddPartyDetails) => {
    if (!quickAddParty) return;
    const name = details.name.trim() || quickAddParty.name;
    const phone = details.phone.trim();
    setQuickAddParty(null);
    // The name may have been EDITED inside the dialog — re-check so a
    // same-phone or same-name party (any capitalisation) is reused, never
    // duplicated. Mirrors InvoiceForm's confirmQuickAddParty.
    const match =
      (phone ? allParties.find((p) => (p.phone ?? "").trim() === phone) : undefined) ??
      allParties.find((p) => p.name.trim().toLowerCase() === name.toLowerCase());
    if (match) {
      toast.info(`Using existing party: ${match.name}`);
      finalizeSave({ id: match.id, name: match.name });
      return;
    }
    const newParty: Party = {
      id: genId(),
      name,
      type: "both",
      phone: phone || undefined,
      openingBalance: details.openingBalance || 0,
      gstin: details.gstin.trim() || undefined,
      creditLimit: details.creditLimit || undefined,
      createdAt: new Date().toISOString(),
    };
    finalizeSave({ create: newParty });
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  useEscapeToLeave(
    () => navigate({ to: backPath }),
    () => !!ret.partyId || ret.lineItems.length > 0,
  );

  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-3 border-b bg-card flex items-center gap-3">
        <div className="h-10 w-10 rounded-md flex items-center justify-center bg-primary-soft text-primary shrink-0">
          {isSaleReturn ? (
            <CornerDownLeft className="h-5 w-5" />
          ) : (
            <CornerUpLeft className="h-5 w-5" />
          )}
        </div>
        <div className="min-w-0">
          <h1 className="text-[17px] font-bold tracking-tight leading-tight">
            New {isSaleReturn ? "Sale Return" : "Purchase Return"}
          </h1>
          <p className="text-[11px] text-muted-foreground">
            <span className="font-mono font-semibold text-foreground">{ret.number}</span>
          </p>
        </div>
      </div>

      <div className="p-5 space-y-4 overflow-auto flex-1 bg-muted/30">
        {/* Party & Meta */}
        <div className="bg-card border rounded-lg shadow-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {isSaleReturn ? "Customer Details" : "Supplier Details"}
            </span>
            {ret.partyId && (
              <span className="text-[11px] text-success font-medium bg-success-soft px-2 py-0.5 rounded">
                ✓ Existing party
              </span>
            )}
            {!ret.partyId && partyQ && (
              <span className="text-[11px] text-primary font-medium bg-primary-soft px-2 py-0.5 rounded flex items-center gap-1">
                <UserPlus className="h-3 w-3" /> New party — details asked on save
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="relative lg:col-span-2">
              <label className="flex flex-col gap-1 text-[12px]">
                <span className="text-muted-foreground font-medium">
                  {isSaleReturn ? "Customer" : "Supplier"} Name *
                </span>
                <input
                  ref={partyRef}
                  value={partyQ}
                  onChange={(e) => {
                    setPartyQ(e.target.value);
                    setPartyOpen(true);
                    setPartyIdx(0);
                    if (ret.partyId) setRet({ ...ret, partyId: "", partyName: e.target.value });
                  }}
                  onFocus={() => setPartyOpen(true)}
                  onBlur={() => setTimeout(() => setPartyOpen(false), 150)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setPartyIdx((i) => Math.min(partySuggests.length - 1, i + 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setPartyIdx((i) => Math.max(0, i - 1));
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      if (partySuggests[partyIdx]) {
                        selectParty(partySuggests[partyIdx]);
                      }
                    }
                  }}
                  className="h-9 px-3 border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none"
                  placeholder="Type name or search…"
                />
              </label>
              {partyOpen && partySuggests.length > 0 && (
                <div className="absolute z-20 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-lg max-h-48 overflow-auto">
                  {partySuggests.map((p, i) => (
                    <div
                      key={p.id}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectParty(p);
                      }}
                      className={`px-3 py-2 text-sm cursor-pointer ${i === partyIdx ? "bg-accent" : "hover:bg-accent"}`}
                    >
                      <div className="font-semibold">{p.name}</div>
                      {p.phone && (
                        <div className="text-[11px] text-muted-foreground">📞 {p.phone}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <Field
              id="ret-date"
              label="Return Date"
              type="date"
              value={ret.date}
              onChange={(e) => setRet({ ...ret, date: e.target.value })}
            />
            <div className="relative">
              <label className="flex flex-col gap-1 text-[12px]">
                <span className="text-muted-foreground font-medium">
                  Original {isSaleReturn ? "Invoice" : "Bill"} #
                </span>
                <input
                  value={invQ}
                  onChange={(e) => {
                    setInvQ(e.target.value);
                    setRet({ ...ret, originalRef: e.target.value });
                    setInvOpen(true);
                    setInvIdx(0);
                  }}
                  onFocus={() => setInvOpen(true)}
                  onBlur={() => setTimeout(() => setInvOpen(false), 150)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setInvIdx((i) => Math.min(invSuggests.length - 1, i + 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setInvIdx((i) => Math.max(0, i - 1));
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      if (invSuggests[invIdx]) loadFromInvoice(invSuggests[invIdx]);
                    }
                  }}
                  className="h-9 px-3 border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none"
                  placeholder={`Search ${isSaleReturn ? "INV-…" : "PUR-…"} to auto-load items`}
                />
              </label>
              {invOpen && invSuggests.length > 0 && (
                <div className="absolute z-30 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-lg max-h-56 overflow-auto">
                  {invSuggests.map((i, idx) => (
                    <div
                      key={i.id}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        loadFromInvoice(i);
                      }}
                      className={`px-3 py-2 text-sm cursor-pointer ${idx === invIdx ? "bg-accent" : "hover:bg-accent"}`}
                    >
                      <div className="flex justify-between">
                        <span className="font-mono font-semibold text-xs text-primary">
                          {i.number}
                        </span>
                        <span className="font-semibold tabular-nums">{fmtMoney(i.total)}</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {i.partyName} · {i.lineItems.length} items · {i.date}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Items — search bar lives OUTSIDE the table's scroll container
            so its suggestion dropdown can never be clipped/hidden by it */}
        <div className="border rounded-lg bg-card shadow-sm">
          <div className="px-4 py-2.5 border-b bg-muted/50 flex items-center justify-between rounded-t-lg">
            <span className="text-[13px] font-semibold">
              Returned Items ({ret.lineItems.length})
            </span>
            <span className="text-[11px] text-muted-foreground">
              Search item to add, or pick the original bill to auto-load
            </span>
          </div>
          <div className="overflow-x-auto rounded-b-lg">
            <table className="w-full text-[13px] min-w-[640px]">
              <thead className="text-[11px] text-muted-foreground uppercase tracking-wider">
                <tr className="bg-muted/40">
                  <th className="text-left px-3 py-2 w-8">#</th>
                  <th className="text-left px-3 py-2">Item</th>
                  <th className="text-right w-20 py-2 px-2">Qty</th>
                  <th className="text-left w-16 py-2 px-2">Unit</th>
                  <th className="text-right w-24 py-2 px-2">Price</th>
                  <th className="text-right w-20 py-2 px-2">Disc%</th>
                  {gstOn && <th className="text-right w-20 py-2 px-2">GST%</th>}
                  <th className="text-right w-28 py-2 pr-3">Amount</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {ret.lineItems.map((l, idx) => (
                  <tr
                    key={l.id}
                    className="border-t hover:bg-accent/30"
                    // Same step-back as the bill grid: Backspace in an empty
                    // box walks back along the line rather than doing nothing.
                    onKeyDown={stepBackOnBackspace}
                  >
                    <td className="px-3 py-1.5 text-muted-foreground text-[11px]">{idx + 1}</td>
                    <td className="px-3 py-1.5 font-medium">{l.name}</td>
                    <td className="py-1.5 px-1">
                      <NumInput
                        id={`qty-${l.id}`}
                        value={l.qty}
                        onValue={(n) => updateLine(l.id, { qty: n })}
                        className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                      />
                    </td>
                    <td className="py-1.5 px-1">
                      <input
                        value={l.unit}
                        onChange={(e) => updateLine(l.id, { unit: e.target.value })}
                        className="w-full h-7 px-1.5 border rounded bg-background focus:border-primary outline-none"
                      />
                    </td>
                    <td className="py-1.5 px-1">
                      <NumInput
                        value={l.price}
                        onValue={(n) => updateLine(l.id, { price: n })}
                        className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                      />
                    </td>
                    <td className="py-1.5 px-1">
                      <NumInput
                        value={l.discountPct}
                        onValue={(n) => updateLine(l.id, { discountPct: n })}
                        className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                      />
                    </td>
                    {gstOn && (
                      <td className="py-1.5 px-1">
                        <NumInput
                          value={l.gstRate}
                          onValue={(n) => updateLine(l.id, { gstRate: n })}
                          className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                        />
                      </td>
                    )}
                    <td className="text-right px-3 py-1.5 font-semibold tabular-nums">
                      {fmtMoney(l.amount)}
                    </td>
                    <td className="py-1.5 px-1">
                      <button
                        type="button"
                        onClick={() => removeLine(l.id)}
                        className="text-destructive p-1 hover:bg-destructive/10 rounded"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                <ReturnItemSearchRow items={items} onAdd={addLineItem} gstOn={gstOn} />
              </tbody>
            </table>
          </div>
        </div>

        {/* Totals + Notes */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 bg-card border rounded-lg shadow-sm p-4">
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="text-muted-foreground font-medium uppercase text-[11px] tracking-wider">
                Notes
              </span>
              <textarea
                value={ret.notes ?? ""}
                onChange={(e) => setRet({ ...ret, notes: e.target.value })}
                placeholder="Reason for return, condition of goods…"
                className="min-h-[80px] px-3 py-2 border rounded-md bg-background focus:border-primary outline-none"
              />
            </label>
          </div>
          <div className="border rounded-lg bg-card shadow-sm p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="tabular-nums">{fmtMoney(ret.subtotal)}</span>
            </div>
            {gstOn && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tax (GST)</span>
                <span className="tabular-nums">{fmtMoney(ret.taxAmount)}</span>
              </div>
            )}
            <div className="flex justify-between items-center pt-2 mt-1 border-t font-bold text-lg">
              <span>{isSaleReturn ? "Credit Note" : "Debit Note"} Total</span>
              <span className="tabular-nums text-warning">{fmtMoney(ret.total)}</span>
            </div>
            <p className="text-[10px] text-muted-foreground pt-1">
              Stock will be {isSaleReturn ? "increased" : "decreased"} on save
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 md:px-5 py-3 border-t bg-card flex items-center gap-2">
        <span className="hidden md:inline text-[11px] text-muted-foreground mr-auto">
          Tab/Enter to move · Ctrl+S save · Esc cancel
        </span>
        <label className="shrink-0 flex items-center gap-2 h-9 px-3 rounded-md border bg-background cursor-pointer select-none">
          <input type="checkbox" checked={gstOn} onChange={toggleGst} className="accent-primary" />
          <span className="text-[12px] font-semibold">GST</span>
        </label>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate({ to: backPath })}
          className="shrink-0"
        >
          <X className="h-3.5 w-3.5" /> Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={saving} className="flex-1 md:flex-none">
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      <QuickAddPartyDialog
        draft={quickAddParty}
        isSale={isSaleReturn}
        onCancel={() => setQuickAddParty(null)}
        onConfirm={confirmQuickAddParty}
      />
    </div>
  );
}

// A real row in the same table as the filled line items — matching
// InvoiceForm's pending-row pattern — instead of a standalone search bar
// floating above it, so this looks and behaves the same as the Sales form.
function ReturnItemSearchRow({
  items,
  onAdd,
  gstOn,
}: {
  items: Item[];
  onAdd: (i: Item) => void;
  gstOn: boolean;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dropdownRect, setDropdownRect] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  // The row lives inside a horizontally-scrollable table (overflow-x-auto),
  // which also forces overflow-y to "auto" — a plain absolutely positioned
  // dropdown would get silently clipped by the table's own scroll box.
  // Render it through a portal instead, positioned from the input's rect.
  useEffect(() => {
    if (!open) return;
    const updateRect = () => {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setDropdownRect({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 260) });
    };
    updateRect();
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
    };
  }, [open]);

  // Empty query — browse the full item catalog (like a combobox), instead
  // of showing nothing until the user starts typing. Enter always commits
  // whichever row is highlighted (index 0 by default), matching what's
  // visually shown as selected.
  const suggests = q.trim()
    ? items
        .filter((i) => matchesQuery(q, i.name, i.sku, i.barcode))
        .sort(byRelevance(q, (i) => i.name))
        .slice(0, MAX_SUGGESTIONS)
    : items.slice(0, MAX_SUGGESTIONS);

  // No self-refocus here — the parent moves focus to the newly added line's
  // Qty field instead (see focusQtyId in ReturnForm), matching Sales' flow:
  // pick an item, land straight on Qty to type how much actually came back.
  const pick = (it: Item) => {
    onAdd(it);
    setQ("");
    setOpen(false);
    setIdx(0);
  };

  return (
    <tr className="border-t hover:bg-accent/20">
      <td className="px-3 py-1.5"></td>
      <td className="px-3 py-1.5">
        <input
          id="return-item-search"
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setIdx(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(suggests.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (suggests[idx]) pick(suggests[idx]);
            }
          }}
          placeholder="Search item to add for return…"
          className="w-full h-8 px-2 border rounded bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none text-sm"
        />
        {open &&
          suggests.length > 0 &&
          dropdownRect &&
          createPortal(
            <div
              style={{
                position: "fixed",
                top: dropdownRect.top,
                left: dropdownRect.left,
                width: dropdownRect.width,
              }}
              className="z-50 border rounded-md bg-popover shadow-elevated max-h-72 overflow-auto"
            >
              {suggests.map((it, i) => (
                <div
                  key={it.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(it);
                  }}
                  className={`px-3 py-2 text-sm cursor-pointer flex justify-between ${i === idx ? "bg-accent" : "hover:bg-accent"}`}
                >
                  <div>
                    <div className="font-semibold">{it.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      Stock: {it.stock} {it.unit}
                    </div>
                  </div>
                </div>
              ))}
            </div>,
            document.body,
          )}
      </td>
      <td className="py-1.5 px-1">
        <input
          disabled
          className="w-full h-7 px-1.5 text-right border rounded bg-muted/40 text-muted-foreground/50 outline-none cursor-not-allowed"
        />
      </td>
      <td className="py-1.5 px-1">
        <input
          disabled
          className="w-full h-7 px-1.5 border rounded bg-muted/40 text-muted-foreground/50 outline-none cursor-not-allowed"
        />
      </td>
      <td className="py-1.5 px-1">
        <input
          disabled
          className="w-full h-7 px-1.5 text-right border rounded bg-muted/40 text-muted-foreground/50 outline-none cursor-not-allowed"
        />
      </td>
      <td className="py-1.5 px-1">
        <input
          disabled
          className="w-full h-7 px-1.5 text-right border rounded bg-muted/40 text-muted-foreground/50 outline-none cursor-not-allowed"
        />
      </td>
      {gstOn && (
        <td className="py-1.5 px-1">
          <input
            disabled
            className="w-full h-7 px-1.5 text-right border rounded bg-muted/40 text-muted-foreground/50 outline-none cursor-not-allowed"
          />
        </td>
      )}
      <td className="py-1.5 px-1">
        <input
          disabled
          className="w-full h-7 px-1.5 text-right border rounded bg-muted/40 text-muted-foreground/50 outline-none cursor-not-allowed"
        />
      </td>
      <td className="py-1.5 px-1"></td>
    </tr>
  );
}

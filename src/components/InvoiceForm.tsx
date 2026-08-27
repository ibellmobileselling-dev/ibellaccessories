import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/Field";
import {
  PartyRepo,
  ItemRepo,
  SalesRepo,
  PurchaseRepo,
  CompanyRepo,
  nextInvoiceNumber,
  SaleReturnRepo,
  PurchaseReturnRepo,
  PaymentRepo,
  BankRepo,
} from "@/repositories";
import { partyBalances } from "@/lib/ledger";
import { correctBankPaidAmount } from "@/lib/bankRepair";
import { matchesQuery, byRelevance } from "@/lib/search";

/** Rendering guard for the search dropdowns, NOT a search limit: every match
 * is found and ranked, this only bounds how many rows go into the DOM at once
 * so a large catalogue can't make the list janky. Anything beyond it is
 * reported by a "+N more" footer. */
const MAX_SUGGESTIONS = 200;
import type { Invoice, LineItem, Party, Item, PaymentMode, BankAccount } from "@/types";
import { fmtMoney, fmtDate, today } from "@/lib/format";
import { toast } from "sonner";
import {
  Trash2,
  UserPlus,
  Save,
  X,
  Printer,
  FileText,
  Receipt,
  Pencil,
  Check,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { PrintableInvoice } from "@/components/PrintableInvoice";
import { NumInput, NumField } from "@/components/NumInput";
import { ModePills } from "@/components/ModePills";
import { QuickAddPartyDialog, type QuickAddPartyDetails } from "@/components/QuickAddPartyDialog";
import { genId, newBatch, commitBatch } from "@/repositories/base";
import { stepBackOnBackspace, useEscapeToLeave } from "@/hooks/useFormKeys";
import { usePeriodLock } from "@/hooks/usePeriodLock";
import { stockShortfalls } from "@/lib/stock";
import { useRepoData, useRepoMemo } from "@/hooks/useRepoData";

interface Props {
  mode: "sale" | "purchase";
  existing?: Invoice | null;
}

export function InvoiceForm({ mode, existing }: Props) {
  // The app now opens BEFORE the collections have loaded (see hydrateRepos),
  // so every repo read in this form has to be keyed on this version or it
  // freezes whatever was in the cache at mount — which on a cold open is
  // nothing at all. Discarding it re-rendered the form without ever
  // re-reading, which is worse than not subscribing: the pickers stayed
  // empty and, far worse, save-time party dedup matched against an empty
  // list and created a DUPLICATE party for an existing customer.
  const _repoV = useRepoData();
  const navigate = useNavigate();
  const company = CompanyRepo.get();
  const isSale = mode === "sale";
  const repo = isSale ? SalesRepo : PurchaseRepo;
  // Archived parties are hidden from the picker (no NEW transactions for
  // them) — but the full `allParties` list is still used for save-time dedup
  // below, so typing an archived party's exact name still reuses (and
  // auto-restores) it instead of creating a duplicate.
  const partyFilter = (p: Party) => !p.archived;

  const [inv, setInv] = useState<Invoice>(
    () =>
      existing ?? {
        id: "",
        number: nextInvoiceNumber(
          isSale ? company.invoicePrefix : company.purchasePrefix,
          repo.all(),
        ),
        date: today(),
        partyId: "",
        partyName: "",
        partyPhone: "",
        // New bills start with GST off — the cashier turns it on per-bill
        // when actually needed, instead of every bill defaulting to a tax invoice.
        gstEnabled: false,
        lineItems: [],
        subtotal: 0,
        discount: 0,
        shippingCharge: 0,
        taxAmount: 0,
        total: 0,
        paid: 0,
        paymentMode: "credit",
        createdAt: "",
        notes: "",
      },
  );

  const gstOn = inv.gstEnabled !== false;

  // Per-line Unit and Disc% are off on BOTH sale and purchase bills: the
  // counter gives one whole-bill "Extra Discount" in the totals card instead,
  // and Unit belongs to the item rather than being re-typed per bill. Two
  // fewer columns also makes the grid fit a phone without sideways scrolling.
  //
  // Sales dropped them first and purchases kept them, only because that was
  // all that had been asked for. Two forms that look different for no reason
  // the person using them can see is its own small cost, and the reason for
  // hiding them was never a sales-only reason.
  //
  // The DATA is untouched — `discountPct` still exists, is still 0 on new
  // lines, and every existing bill keeps calculating exactly as before, so no
  // historical total or GST figure moves. A new line takes its unit from the
  // item it was picked from, which is where that value came from anyway.
  //
  // The one exception: if a bill being edited already carries a line
  // discount, the column stays visible. Hiding a live, non-zero discount
  // would leave an amount affecting the total that nobody could see or
  // correct.
  // Whether the bill ARRIVED carrying a line discount — decided once, when
  // the form opens, and then held.
  //
  // Recomputing it from the live lines looks equivalent and is not. NumInput
  // reports 0 for an empty box, so backspacing the last discount away to
  // retype it flips this to false mid-keystroke: the column unmounts and
  // takes the focused input with it, and the value that is actually being
  // corrected is the one that makes correcting it impossible. Holding the
  // answer keeps the column for as long as the bill is open, which is the
  // only span that matters.
  const [hadLineDiscount] = useState(() =>
    (existing?.lineItems ?? []).some((l) => (l.discountPct ?? 0) > 0),
  );
  const showUnitCol: boolean = false;
  const showDiscCol = hadLineDiscount;

  const allParties = useRepoMemo(() => PartyRepo.all());
  const parties = useMemo(() => allParties.filter(partyFilter), [allParties]);
  const items = useRepoMemo(() => ItemRepo.all());
  const banks = useRepoMemo<BankAccount[]>(() => BankRepo.all());
  // Vyapar-style entry: starts with 2 blank rows below the filled items,
  // each a self-contained search-and-add row. Row ids (not indexes) so the
  // untouched row keeps its own typed-but-not-submitted text when the other
  // one is completed and shifts up.
  const ITEM_ENTRY_ROWS = 2;
  const [pendingRowIds, setPendingRowIds] = useState<string[]>(() =>
    Array.from({ length: ITEM_ENTRY_ROWS }, () => genId()),
  );
  const pendingInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  // Called when a pending row's item is added — that row is retired. A
  // fresh blank one is appended ONLY if that was the last blank row left
  // (buffer would hit 0), not after every single completion — so filling
  // the first of the 2 starting rows leaves the other one as-is (no new row
  // yet), and only filling that last one too triggers a fresh replacement.
  const completePendingRow = (rowId: string) => {
    setPendingRowIds((prev) => {
      const remaining = prev.filter((id) => id !== rowId);
      return remaining.length === 0 ? [genId()] : remaining;
    });
  };
  // After an item is picked, focus goes to THAT row's Qty field (id
  // "qty-<lineId>") so the amount can be typed immediately — not to the next
  // blank search row. Pressing Enter in Qty is what advances to the next row.
  const focusQtyId = useRef<string | null>(null);
  /** Line whose item picker the Qty box asked to reopen (Backspace on an
   *  empty Qty = "wrong item, let me choose again"). */
  const [reopenPickerFor, setReopenPickerFor] = useState<string | null>(null);
  const { canPost } = usePeriodLock();
  useEffect(() => {
    if (focusQtyId.current) {
      const el = document.getElementById(`qty-${focusQtyId.current}`) as HTMLInputElement | null;
      el?.focus();
      el?.select();
      focusQtyId.current = null;
    }
  }, [inv.lineItems]);
  const focusFirstPendingRow = () => {
    pendingInputRefs.current[pendingRowIds[0]]?.focus();
  };
  // A party or item typed at the counter that doesn't exist yet is no longer
  // silently created with blank/zero defaults — these open a quick-add
  // dialog asking for the real details (phone/opening balance, or
  // price/GST) before it's actually created.
  const [quickAddParty, setQuickAddParty] = useState<{
    name: string;
    phone: string;
    paid: number;
    andPrint: boolean;
  } | null>(null);
  const [quickAddItem, setQuickAddItem] = useState<{ name: string; rowId: string } | null>(null);
  const partyRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const [partyQ, setPartyQ] = useState(existing?.partyName ?? "");
  const [phoneQ, setPhoneQ] = useState(existing?.partyPhone ?? "");
  const [partyOpen, setPartyOpen] = useState(false);
  const [partyIdx, setPartyIdx] = useState(0);
  const [numberEditing, setNumberEditing] = useState(false);
  const numberRef = useRef<HTMLInputElement>(null);
  // The opening number was computed at mount from repo.all(), which on a cold
  // open is still empty — that hands out INV-0001 again on a shop with
  // thousands of bills. Recompute as the bills actually arrive, but never
  // over a number the cashier typed themselves, and never on an edit.
  const numberTouched = useRef(false);
  useEffect(() => {
    if (existing?.id || numberTouched.current) return;
    const next = nextInvoiceNumber(
      isSale ? company.invoicePrefix : company.purchasePrefix,
      repo.all(),
    );
    setInv((cur) => (cur.number === next ? cur : { ...cur, number: next }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_repoV]);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const bankSelectRef = useRef<HTMLInputElement>(null);
  const prevPaymentMode = useRef(inv.paymentMode);
  useEffect(() => {
    // Only jump focus on an actual switch to "bank" — not on mount, or an
    // already-bank invoice would steal focus away from wherever the cashier
    // is when opening it for edit.
    if (inv.paymentMode === "bank" && prevPaymentMode.current !== "bank") {
      bankSelectRef.current?.focus();
    }
    prevPaymentMode.current = inv.paymentMode;
  }, [inv.paymentMode]);

  // Search-as-you-type for Bank Account — same combobox pattern as the
  // party picker above, since a shop can have many accounts and a plain
  // dropdown makes them scroll-hunt for one.
  const [bankQ, setBankQ] = useState("");
  const [bankOpen, setBankOpen] = useState(false);
  const [bankIdx, setBankIdx] = useState(0);
  useEffect(() => {
    setBankQ(banks.find((b) => b.id === inv.bankId)?.name ?? "");
  }, [inv.bankId, banks]);
  const bankSuggests = useMemo(() => {
    const q = bankQ.trim().toLowerCase();
    if (!q) return banks;
    return banks.filter(
      (b) => b.name.toLowerCase().includes(q) || (b.accountNumber ?? "").toLowerCase().includes(q),
    );
  }, [banks, bankQ]);
  const selectBank = (b: BankAccount) => {
    setInv({ ...inv, bankId: b.id });
    setBankQ(b.name);
    setBankOpen(false);
  };

  // Live outstanding balance of the selected party (credit decision at the counter)
  const partyBalance = useRepoMemo(() => {
    if (!inv.partyId) return null;
    const list = partyBalances(
      isSale ? SalesRepo.all() : PurchaseRepo.all(),
      isSale ? SaleReturnRepo.all() : PurchaseReturnRepo.all(),
      PaymentRepo.all().filter((p) => p.type === (isSale ? "in" : "out")),
      allParties.filter((p) => (isSale ? p.type !== "supplier" : p.type !== "customer")),
      isSale ? "customer" : "supplier",
    );
    return list.find((b) => b.partyId === inv.partyId)?.balance ?? 0;
  }, [inv.partyId, isSale, allParties]);

  const partySuggests = useMemo(() => {
    const q = partyQ.trim();
    const pq = phoneQ.trim();
    // Empty query — browse the full party list (like a combobox), instead
    // of showing nothing until the user starts typing. Was capped at 8, so a
    // shop with more customers than that could never scroll to the rest.
    if (!q && !pq) return parties.slice(0, MAX_SUGGESTIONS);
    return parties
      .filter((p) => (q ? matchesQuery(q, p.name) : (p.phone ?? "").includes(pq)))
      .sort(byRelevance(q, (p) => p.name))
      .slice(0, MAX_SUGGESTIONS);
  }, [partyQ, phoneQ, parties]);

  useEffect(() => {
    partyRef.current?.focus();
  }, []);

  const r2 = (n: number) => Math.round(n * 100) / 100;

  const roundEnabled = company.enableRoundOff !== false;

  const recalc = (
    lines: LineItem[],
    discount = inv.discount,
    gst = gstOn,
    shipping = inv.shippingCharge ?? 0,
  ) => {
    const subtotal = r2(lines.reduce((s, l) => s + l.qty * l.price, 0));
    const afterLineDisc = r2(
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
    const rawTotal = Math.max(0, r2(afterLineDisc + taxAmount - discount + shipping));
    // Indian billing convention: round to the nearest whole rupee
    const total = roundEnabled ? Math.round(rawTotal) : rawTotal;
    const roundOff = r2(total - rawTotal);
    return { subtotal, taxAmount, total, roundOff };
  };

  const selectParty = (p: Party) => {
    setInv({ ...inv, partyId: p.id, partyName: p.name, partyPhone: p.phone ?? "" });
    setPartyQ(p.name);
    setPhoneQ(p.phone ?? "");
    setPartyOpen(false);
    setTimeout(() => document.getElementById("inv-date")?.focus(), 30);
  };

  const clearParty = () => {
    setInv({ ...inv, partyId: "", partyName: "", partyPhone: "" });
    setPartyQ("");
    setPhoneQ("");
    setTimeout(() => partyRef.current?.focus(), 30);
  };

  // Every past bill where this party bought/sold each item, most recent
  // first — many shops negotiate a standing rate per customer/item that
  // doesn't match the catalog price, so seeing (and re-using) the last few
  // prices charged beats re-typing it from memory every time. Indexed once
  // per selected party: the render path asks for this per line row on every
  // keystroke, and a fresh scan of every invoice each time made typing lag
  // once the shop had a few thousand bills.
  const partyHistoryIndex = useRepoMemo(() => {
    const map = new Map<string, { date: string; created: string; qty: number; price: number }[]>();
    if (!inv.partyId) return map;
    for (const doc of repo.all()) {
      if (doc.partyId !== inv.partyId) continue;
      for (const l of doc.lineItems) {
        let rows = map.get(l.itemId);
        if (!rows) map.set(l.itemId, (rows = []));
        rows.push({ date: doc.date, created: doc.createdAt || "", qty: l.qty, price: l.price });
      }
    }
    for (const rows of map.values())
      rows.sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created));
    return map;
  }, [inv.partyId, repo]);

  const partyItemHistory = (itemId: string): { date: string; qty: number; price: number }[] =>
    (partyHistoryIndex.get(itemId) ?? [])
      .slice(0, 5)
      .map(({ date, qty, price }) => ({ date, qty, price }));

  const lastPartyPrice = (itemId: string): number | undefined =>
    partyHistoryIndex.get(itemId)?.[0]?.price;

  /** What this item last went out at to ANYONE, newest first.
   *
   * A brand-new customer has no history of their own, and the catalogue
   * price can be months stale — so without this the counter is quoted a
   * price nobody has charged in a long time. Party-specific history still
   * wins when it exists; this only fills the gap behind it. */
  const lastAnyPrice = (itemId: string): number | undefined => {
    let best: { date: string; created: string; price: number } | undefined;
    for (const doc of repo.all()) {
      for (const l of doc.lineItems) {
        if (l.itemId !== itemId || !(l.price > 0)) continue;
        const created = doc.createdAt || "";
        if (!best || doc.date > best.date || (doc.date === best.date && created > best.created)) {
          best = { date: doc.date, created, price: l.price };
        }
      }
    }
    return best?.price;
  };

  // Returns the id of the line that was added/updated, so the caller can move
  // focus straight to that row's Qty field for fast entry.
  const addLineItem = (it: Item): string => {
    // Repeat items cannot be added twice — increase quantity of the existing line instead
    const existingLine = inv.lineItems.find((l) => l.itemId === it.id);
    if (existingLine) {
      updateLine(existingLine.id, { qty: existingLine.qty + 1 });
      toast.info(`${it.name} — quantity increased to ${existingLine.qty + 1}`);
      return existingLine.id;
    }
    // This party's own last price wins; otherwise what the item last
    // actually went out at; only then the catalogue figure.
    const historicalPrice = lastPartyPrice(it.id) ?? lastAnyPrice(it.id);
    const line: LineItem = {
      id: genId(),
      itemId: it.id,
      name: it.name,
      qty: 1,
      unit: it.unit,
      price: historicalPrice ?? (isSale ? it.salePrice || it.purchasePrice : it.purchasePrice),
      discountPct: 0,
      gstRate: it.gstRate,
      amount: 0,
      costPrice: it.purchasePrice,
    };
    const gstMult = gstOn ? 1 + line.gstRate / 100 : 1;
    line.amount = r2(r2(line.qty * line.price * (1 - line.discountPct / 100)) * gstMult);
    const lines = [...inv.lineItems, line];
    setInv({ ...inv, lineItems: lines, ...recalc(lines) });
    return line.id;
  };

  // Called from the quick-add-item dialog once the cashier has actually
  // entered price/GST/unit — a name typed at the counter that doesn't match
  // any known item is never auto-created with blank/zero defaults anymore.
  const confirmQuickAddItem = (details: {
    name: string;
    unit: string;
    gstRate: number;
    salePrice: number;
    purchasePrice: number;
  }) => {
    if (!quickAddItem) return;
    const rowId = quickAddItem.rowId;
    setQuickAddItem(null);
    const existingMatch = items.find(
      (i) => i.name.trim().toLowerCase() === details.name.trim().toLowerCase(),
    );
    if (existingMatch) {
      focusQtyId.current = addLineItem(existingMatch);
      completePendingRow(rowId);
      return;
    }
    const newItem = ItemRepo.add({
      name: details.name.trim(),
      unit: details.unit.trim() || "pcs",
      gstRate: Math.max(0, details.gstRate),
      purchasePrice: Math.max(0, details.purchasePrice),
      salePrice: Math.max(0, details.salePrice),
      stock: 0,
      openingStock: 0,
    }) as Item;
    focusQtyId.current = addLineItem(newItem);
    completePendingRow(rowId);
    toast.success(`New item added: ${newItem.name}`);
  };

  // Landed per-unit cost for an international purchase: convert the foreign
  // price to INR, then add the flat per-piece freight/customs cost — e.g.
  // 44 (foreign) * 14 (rate) + 10 (carry) = ₹636/pc.
  const landedPrice = (foreignPrice: number) =>
    r2(foreignPrice * (inv.exchangeRate ?? 0) + (inv.carryCostPerUnit ?? 0));

  const updateLine = (id: string, patch: Partial<LineItem>) => {
    const lines = inv.lineItems.map((l) => {
      if (l.id !== id) return l;
      const nl = { ...l, ...patch };
      // Clamp so a mistyped discount (e.g. 500 instead of 50) or a negative
      // GST rate can never flip the line amount negative.
      nl.discountPct = Math.min(100, Math.max(0, nl.discountPct));
      nl.gstRate = Math.max(0, nl.gstRate);
      // Auto-fill the INR price whenever the foreign price changes — still
      // a normal editable field afterward, so a cashier can override it.
      if (inv.isInternational && "foreignPrice" in patch && nl.foreignPrice != null) {
        nl.price = landedPrice(nl.foreignPrice);
      }
      const gstMult = gstOn ? 1 + nl.gstRate / 100 : 1;
      nl.amount = r2(r2(nl.qty * nl.price * (1 - nl.discountPct / 100)) * gstMult);
      return nl;
    });
    setInv({ ...inv, lineItems: lines, ...recalc(lines) });
  };

  // Changing the exchange rate or per-piece carry cost after items are
  // already on the bill should re-price every line that has a foreign price
  // set — otherwise "auto-fill" would only ever apply retroactively to the
  // next item typed, leaving already-added rows silently stale.
  const updateInternational = (patch: {
    isInternational?: boolean;
    exchangeRate?: number;
    carryCostPerUnit?: number;
  }) => {
    const merged = { ...inv, ...patch };
    const rate = merged.exchangeRate ?? 0;
    const carry = merged.carryCostPerUnit ?? 0;
    const lines = inv.lineItems.map((l) => {
      if (l.foreignPrice == null) return l;
      const price = r2(l.foreignPrice * rate + carry);
      const gstMult = gstOn ? 1 + l.gstRate / 100 : 1;
      const amount = r2(r2(l.qty * price * (1 - l.discountPct / 100)) * gstMult);
      return { ...l, price, amount };
    });
    setInv({ ...merged, lineItems: lines, ...recalc(lines) });
  };

  const removeLine = (id: string) => {
    const lines = inv.lineItems.filter((l) => l.id !== id);
    setInv({ ...inv, lineItems: lines, ...recalc(lines) });
  };

  // Swaps the item on an already-added row (clicked from the item-name cell)
  // instead of forcing a delete + re-add. Qty/discount are kept as typed;
  // price/unit/GST reset to the newly picked item (party's historical price
  // if there is one), same defaulting as a fresh addLineItem(). Returns the
  // id of the row that ends up holding the item, so the caller can move
  // focus straight to its Qty field.
  const changeLineItem = (lineId: string, it: Item): string => {
    const dup = inv.lineItems.find((l) => l.itemId === it.id && l.id !== lineId);
    if (dup) {
      const removed = inv.lineItems.find((l) => l.id === lineId);
      const mergedQty = dup.qty + (removed?.qty ?? 0);
      const gstMult = gstOn ? 1 + dup.gstRate / 100 : 1;
      const lines = inv.lineItems
        .filter((l) => l.id !== lineId)
        .map((l) =>
          l.id === dup.id
            ? {
                ...l,
                qty: mergedQty,
                amount: r2(r2(mergedQty * l.price * (1 - l.discountPct / 100)) * gstMult),
              }
            : l,
        );
      setInv({ ...inv, lineItems: lines, ...recalc(lines) });
      toast.info(`${it.name} — merged into existing line, quantity increased to ${mergedQty}`);
      return dup.id;
    }
    // This party's own last price wins; otherwise what the item last
    // actually went out at; only then the catalogue figure.
    const historicalPrice = lastPartyPrice(it.id) ?? lastAnyPrice(it.id);
    updateLine(lineId, {
      itemId: it.id,
      name: it.name,
      unit: it.unit,
      gstRate: it.gstRate,
      price: historicalPrice ?? (isSale ? it.salePrice || it.purchasePrice : it.purchasePrice),
      costPrice: it.purchasePrice,
      // The old item's foreign price must not survive the swap — a later
      // exchange-rate change re-prices every line that still has one, which
      // would overwrite the new item's price with the OLD item's landed cost.
      foreignPrice: undefined,
    });
    return lineId;
  };

  const setDiscount = (d: number) => setInv({ ...inv, discount: d, ...recalc(inv.lineItems, d) });

  const setShippingCharge = (s: number) =>
    setInv({
      ...inv,
      shippingCharge: s,
      ...recalc(inv.lineItems, inv.discount, gstOn, s),
    });

  const toggleGst = () => {
    const newGst = !gstOn;
    const lines = inv.lineItems.map((l) => {
      const gstMult = newGst ? 1 + l.gstRate / 100 : 1;
      return { ...l, amount: r2(r2(l.qty * l.price * (1 - l.discountPct / 100)) * gstMult) };
    });
    setInv({
      ...inv,
      gstEnabled: newGst,
      lineItems: lines,
      ...recalc(lines, inv.discount, newGst),
    });
  };

  // Runs once the party is fully resolved — either an existing match, or a
  // brand-new one whose details were just collected via the quick-add
  // dialog (never silently defaulted). Everything here is the actual write:
  // the party (if new), the invoice, its stock/bank effects, and any
  // Payment re-allocation land together in one atomic batch.
  const finalizeSave = (
    party: { id: string; name: string } | { create: Party },
    phone: string,
    paid: number,
    andPrint: boolean,
  ) => {
    // Changing the party on a bill that already has payments linked to it
    // would leave that received money attributed to the OLD party — the
    // dashboard (which reads invoice.paid) and the party statement (which
    // reads the payment's own partyId) would then disagree, and the cash
    // would show under the wrong name. Block it: the payment must be removed
    // (or the bill left on its original party) first.
    if (existing?.id) {
      const newPartyId = "create" in party ? party.create.id : party.id;
      if (newPartyId !== existing.partyId) {
        const linkedPayment = PaymentRepo.all().some(
          (p) =>
            p.allocations?.some((a) => a.invoiceId === existing.id) ||
            (!p.allocations?.length &&
              (p.ref ?? "")
                .split(",")
                .map((s) => s.trim())
                .includes(existing.number.trim())),
        );
        if (linkedPayment) {
          toast.error(
            "This bill has payments linked to its current party. Delete those payments (or keep the same party) before changing it — otherwise the received money would stay under the old party.",
          );
          return;
        }
      }
    }

    savingRef.current = true;
    setSaving(true);

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
      // Reusing an archived party for a NEW bill means they're active again —
      // restore them in the same batch so they reappear in pickers and the
      // active list (Zoho/QuickBooks "reactivate on use"). Only on a new bill:
      // merely editing an OLD bill for an already-archived party must not
      // silently un-archive it.
      if (!existing?.id && PartyRepo.get(partyId)?.archived) {
        PartyRepo.updateBatched(batch, partyId, { archived: false });
      }
    }

    // How much of `paid` actually moves on a bank account AT BILLING — see
    // correctBankPaidAmount for why this is NOT simply `paid`. Shared with
    // the Settings → bank reconciliation repair so the two can never disagree.
    const bankPaidNow = correctBankPaidAmount(
      { ...inv, id: existing?.id ?? "", paid } as Invoice,
      PaymentRepo.all(),
    );

    const finalInv: Invoice = {
      ...inv,
      number: inv.number.trim(),
      paid,
      partyId,
      partyName,
      partyPhone: phone,
      bankId: inv.paymentMode === "bank" ? inv.bankId : undefined,
      bankPaidAmount: bankPaidNow,
    };

    // This invoice's own paid-at-billing amount can move money on a specific
    // bank account. Reverse whatever it PREVIOUSLY moved (tracked via the
    // bankPaidAmount snapshot, not `existing.paid` — paid can also grow
    // later via unrelated Payment-page allocations that never touched this
    // bank account) before applying what it moves now, in the same batch as
    // everything else in this save.
    if (existing?.paymentMode === "bank" && existing.bankId && (existing.bankPaidAmount ?? 0) > 0) {
      BankRepo.adjustFieldBatched(
        batch,
        existing.bankId,
        "balance",
        isSale ? -existing.bankPaidAmount! : existing.bankPaidAmount!,
      );
    }
    if (finalInv.paymentMode === "bank" && finalInv.bankId && (finalInv.bankPaidAmount ?? 0) > 0) {
      BankRepo.adjustFieldBatched(
        batch,
        finalInv.bankId,
        "balance",
        isSale ? finalInv.bankPaidAmount! : -finalInv.bankPaidAmount!,
      );
    }

    // If editing dropped the settled amount (bill total reduced, or paid
    // lowered manually), Payment allocations tied to this invoice can now
    // exceed what's actually owed. Trim them so the freed money surfaces as
    // an advance instead of silently vanishing from ledger reports.
    // IMPORTANT: this runs AFTER every validation early-return (cache writes
    // land immediately), and the excess is recomputed from the LIVE
    // allocations — never from existing.paid — so a failed attempt or a
    // retry can never trim the same money twice.
    if (existing?.id) {
      const liveAllocated = r2(
        PaymentRepo.all().reduce(
          (s, p) =>
            s +
            (p.allocations ?? [])
              .filter((a) => a.invoiceId === existing.id)
              .reduce((x, a) => x + a.amount, 0),
          0,
        ),
      );
      let excess = r2(liveAllocated - paid);
      for (const p of PaymentRepo.all()) {
        if (excess <= 0) break;
        const alloc = p.allocations?.find((a) => a.invoiceId === existing.id);
        if (!alloc) continue;
        const reduceBy = Math.min(alloc.amount, excess);
        const remaining = p
          .allocations!.map((a) =>
            a.invoiceId === existing.id ? { ...a, amount: r2(a.amount - reduceBy) } : a,
          )
          .filter((a) => a.amount > 0);
        PaymentRepo.updateBatched(batch, p.id, {
          allocations: remaining.length ? remaining : undefined,
        });
        excess = r2(excess - reduceBy);
      }
    }

    if (existing?.id) {
      // Reverse original stock before applying new quantities (atomic increments)
      const origDelta = isSale ? 1 : -1;
      for (const l of existing.lineItems) {
        const it = ItemRepo.get(l.itemId);
        if (it) ItemRepo.adjustFieldBatched(batch, it.id, "stock", origDelta * l.qty);
      }
    }

    const stockDelta = isSale ? -1 : 1;
    for (const l of finalInv.lineItems) {
      const it = ItemRepo.get(l.itemId);
      if (!it) continue;
      const extra: Partial<Item> = {};
      if (l.price > 0) {
        // Track the LAST price this item actually moved at, on both sides.
        // Sale price used to be written only when the item had none, so
        // after the very first bill it never changed again and "last sale
        // price" was really "the price someone typed once, long ago".
        if (isSale && it.salePrice !== l.price) extra.salePrice = l.price;
        // Purchase price: always the LATEST cost, so profit stays accurate.
        if (!isSale && it.purchasePrice !== l.price) extra.purchasePrice = l.price;
      }
      ItemRepo.adjustFieldBatched(batch, it.id, "stock", stockDelta * l.qty, extra);
    }

    // Warn (non-blocking) when a sale pushes stock below zero — shop can still bill
    if (isSale) {
      const negative = finalInv.lineItems
        .map((l) => ItemRepo.get(l.itemId))
        .filter((it): it is Item => !!it && it.stock < 0);
      if (negative.length) {
        toast.warning(
          `Stock below zero: ${negative.map((i) => i.name).join(", ")} — add purchase entry`,
        );
      }
      // Credit limit alert for credit sales
      const partyRecord = PartyRepo.get(partyId);
      if (partyRecord?.creditLimit && partyBalance !== null) {
        const newBalance =
          partyBalance +
          (finalInv.total - finalInv.paid) -
          (existing ? Math.max(0, (existing.total ?? 0) - (existing.paid ?? 0)) : 0);
        if (newBalance > partyRecord.creditLimit) {
          toast.warning(
            `${partyName} crossed credit limit ${fmtMoney(partyRecord.creditLimit)} — balance now ${fmtMoney(newBalance)}`,
          );
        }
      }
    }

    // If the bill NUMBER was changed on edit, the records that reference it by
    // that string (returns via originalRef, and payments via their allocation
    // display number / legacy ref) would otherwise point at a number that no
    // longer exists — the return's over-return cap silently stops matching and
    // the linked-invoice display goes stale. Cascade the rename to them in the
    // same batch. (Payment MATH keys on invoiceId, so balances stay correct
    // regardless; this keeps the human-readable links right too.)
    if (existing?.id) {
      const oldNum = (existing.number ?? "").trim();
      const newNum = finalInv.number;
      if (oldNum && oldNum !== newNum) {
        const retRepo = isSale ? SaleReturnRepo : PurchaseReturnRepo;
        for (const ret of retRepo.all()) {
          if ((ret.originalRef ?? "").trim() === oldNum) {
            retRepo.updateBatched(batch, ret.id, { originalRef: newNum });
          }
        }
        for (const p of PaymentRepo.all()) {
          let changed = false;
          let allocations = p.allocations;
          if (p.allocations?.some((a) => a.invoiceId === existing.id)) {
            allocations = p.allocations.map((a) =>
              a.invoiceId === existing.id ? { ...a, number: newNum } : a,
            );
            changed = true;
          }
          let ref = p.ref;
          if (p.ref) {
            const tokens = p.ref.split(",").map((t) => t.trim());
            if (tokens.includes(oldNum)) {
              ref = tokens.map((t) => (t === oldNum ? newNum : t)).join(", ");
              changed = true;
            }
          }
          if (changed) PaymentRepo.updateBatched(batch, p.id, { allocations, ref });
        }
      }
    }

    let savedId: string;
    if (existing?.id) {
      repo.updateBatched(batch, existing.id, finalInv);
      savedId = existing.id;
      toast.success(`${isSale ? "Sale" : "Purchase"} ${finalInv.number} updated`);
    } else {
      savedId = (repo.addBatched(batch, finalInv) as Invoice).id;
      toast.success(`${isSale ? "Sale" : "Purchase"} ${finalInv.number} saved`);
    }
    commitBatch(batch, `save ${isSale ? "sale" : "purchase"}`);
    if (andPrint) {
      navigate({
        to: isSale ? "/sales/$id" : "/purchase/$id",
        params: { id: savedId },
        search: { print: 1 },
      });
    } else {
      navigate({ to: isSale ? "/sales" : "/purchase" });
    }
  };

  const save = (andPrint = false) => {
    if (savingRef.current) return; // double-click / Ctrl+S repeat protection
    // Both dates: an edit that moves a bill out of a closed month changes that
    // month's filed totals as surely as one posted into it.
    if (!canPost(inv.date, existing?.date)) return;

    // ── Validations ─────────────────────────────────────────────
    if (!inv.lineItems.length) {
      toast.error("Add at least one item");
      return;
    }
    const badLine = inv.lineItems.find((l) => !(l.qty > 0) || l.price < 0);
    if (badLine) {
      toast.error(`Check quantity/price for "${badLine.name}" — qty must be more than 0`);
      return;
    }
    if (isSale && company.allowNegativeStock === false) {
      const shortfalls = stockShortfalls(inv.lineItems, existing?.lineItems ?? []);
      if (shortfalls.length) {
        toast.error(`Not enough stock — ${shortfalls.join(", ")}`);
        return;
      }
    }
    // Editing an existing bill must never drop an item's quantity below what
    // has already been returned against this exact bill — otherwise returned
    // qty exceeds sold/purchased qty and both stock and the party balance get
    // over-credited (with no error to signal it). The return side has its own
    // over-return cap; this is the same guard from the bill side.
    if (existing?.id) {
      const returnRepo = isSale ? SaleReturnRepo : PurchaseReturnRepo;
      const returnedByItem = new Map<string, number>();
      for (const ret of returnRepo.all()) {
        if ((ret.originalRef ?? "").trim() !== existing.number.trim()) continue;
        for (const l of ret.lineItems) {
          returnedByItem.set(l.itemId, (returnedByItem.get(l.itemId) ?? 0) + l.qty);
        }
      }
      if (returnedByItem.size) {
        const newQtyByItem = new Map<string, number>();
        for (const l of inv.lineItems) {
          newQtyByItem.set(l.itemId, (newQtyByItem.get(l.itemId) ?? 0) + l.qty);
        }
        for (const [itemId, returned] of returnedByItem) {
          const nowQty = newQtyByItem.get(itemId) ?? 0;
          if (nowQty < returned - 0.0001) {
            const name =
              inv.lineItems.find((l) => l.itemId === itemId)?.name ??
              ItemRepo.get(itemId)?.name ??
              "this item";
            toast.error(
              `Can't reduce "${name}" to ${nowQty} — ${returned} already returned against ${existing.number}. Delete or adjust that return first.`,
            );
            return;
          }
        }
      }
    }
    const number = inv.number.trim();
    if (!number) {
      toast.error(`${isSale ? "Invoice" : "Bill"} number is required`);
      return;
    }
    const dupNo = repo.all().find((i) => i.number.trim() === number && i.id !== existing?.id);
    if (dupNo) {
      toast.error(`${isSale ? "Invoice" : "Bill"} number ${number} is already used — change it`);
      setNumberEditing(true);
      setTimeout(() => numberRef.current?.focus(), 50);
      return;
    }
    if (inv.paymentMode === "bank" && !inv.bankId) {
      toast.error("Select which bank account this goes to");
      return;
    }
    // Paid can never exceed the bill total
    let paid = inv.paid;
    if (paid > inv.total) {
      paid = inv.total;
      toast.info(`Paid amount adjusted to bill total ${fmtMoney(inv.total)}`);
    }

    const partyId = inv.partyId;
    const partyName = inv.partyName || partyQ.trim();
    const phone = phoneQ.trim();

    if (partyId) {
      finalizeSave({ id: partyId, name: partyName }, phone, paid, andPrint);
      return;
    }
    if (!partyName && !phone) {
      toast.error("Enter customer name or phone");
      partyRef.current?.focus();
      return;
    }
    // Try match by phone first (unique), then by name
    const byPhone = phone ? allParties.find((p) => (p.phone ?? "").trim() === phone) : null;
    const byName = partyName
      ? allParties.find((p) => p.name.toLowerCase() === partyName.toLowerCase())
      : null;
    const existingParty = byPhone ?? byName;
    if (existingParty) {
      finalizeSave({ id: existingParty.id, name: existingParty.name }, phone, paid, andPrint);
      return;
    }
    // No match — this would previously auto-create a bare-bones party with
    // no phone/opening-balance recorded. Ask for the real details instead.
    setQuickAddParty({ name: partyName || `Party ${phone}`, phone, paid, andPrint });
  };

  const confirmQuickAddParty = (details: QuickAddPartyDetails) => {
    if (!quickAddParty) return;
    const name = details.name.trim() || quickAddParty.name;
    const phone = details.phone.trim();
    const { paid, andPrint } = quickAddParty;
    setQuickAddParty(null);
    // The name may have been EDITED inside the dialog — re-check so a
    // same-phone or same-name party (any capitalisation) is reused, never
    // duplicated. Mirrors confirmQuickAddItem.
    const match =
      (phone ? allParties.find((p) => (p.phone ?? "").trim() === phone) : undefined) ??
      allParties.find((p) => p.name.trim().toLowerCase() === name.toLowerCase());
    if (match) {
      toast.info(`Using existing party: ${match.name}`);
      finalizeSave({ id: match.id, name: match.name }, phone, paid, andPrint);
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
    finalizeSave({ create: newParty }, phone, paid, andPrint);
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

  // A bill with a party or a line on it is work worth asking about before
  // Escape throws it away — and Escape belongs to any open dropdown first.
  useEscapeToLeave(
    () => navigate({ to: isSale ? "/sales" : "/purchase" }),
    () => !!inv.partyId || inv.lineItems.length > 0,
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 md:px-5 py-3 border-b bg-card flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center justify-between gap-3 min-w-0">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`h-10 w-10 rounded-md flex items-center justify-center ${isSale ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}
            >
              {isSale ? <Receipt className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
            </div>
            <div className="min-w-0">
              <h1 className="text-[17px] font-bold tracking-tight leading-tight">
                {existing ? "Edit" : "New"} {isSale ? "Sale Invoice" : "Purchase Bill"}
              </h1>
              <p className="text-[11px] text-muted-foreground">
                <span className="font-mono font-semibold text-foreground">{inv.number}</span>
              </p>
            </div>
          </div>
          {isSale && (
            <label className="sm:hidden shrink-0 flex items-center gap-1.5 h-7 px-2.5 rounded-md border bg-background cursor-pointer select-none">
              <input
                type="checkbox"
                checked={gstOn}
                onChange={toggleGst}
                className="accent-primary h-3.5 w-3.5"
              />
              <span className="text-[11px] font-semibold">GST Bill</span>
            </label>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap sm:justify-end">
          {/* Toggles — grouped together as one row so they read as a clean
              pair of switches instead of separate borderline-width chips
              each wrapping onto their own line. */}
          <div
            className={
              !isSale
                ? "grid grid-cols-2 gap-2 sm:flex sm:items-center sm:w-auto"
                : "flex items-center justify-end gap-2"
            }
          >
            {!isSale && (
              <label className="flex items-center justify-center gap-2 h-9 px-3 rounded-md border bg-background cursor-pointer select-none sm:justify-start sm:w-auto">
                <input
                  type="checkbox"
                  checked={!!inv.isInternational}
                  onChange={(e) => updateInternational({ isInternational: e.target.checked })}
                  className="accent-primary"
                />
                <span className="text-[12px] font-semibold whitespace-nowrap">
                  International Purchase
                </span>
              </label>
            )}
            {!isSale && (
              <label className="sm:hidden shrink-0 flex items-center gap-2 h-9 px-3 rounded-md border bg-background cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={gstOn}
                  onChange={toggleGst}
                  className="accent-primary"
                />
                <span className="text-[12px] font-semibold">GST Bill</span>
              </label>
            )}
          </div>

          {!isSale && inv.isInternational && (
            <>
              {/* Mobile: proper label-above-input fields in a 2-col grid —
                  reads as a form, not a squeezed inline pill. */}
              <div className="sm:hidden grid grid-cols-2 gap-2">
                <label
                  className="flex flex-col gap-1 px-2.5 py-2 rounded-md border bg-background"
                  title="How many rupees 1 unit of the supplier's currency is worth"
                >
                  <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                    Exchange Rate (₹)
                  </span>
                  <NumInput
                    value={inv.exchangeRate ?? 0}
                    onValue={(n) => updateInternational({ exchangeRate: n })}
                    className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1 px-2.5 py-2 rounded-md border bg-background">
                  <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                    Carry cost/pc (₹)
                  </span>
                  <NumInput
                    value={inv.carryCostPerUnit ?? 0}
                    onValue={(n) => updateInternational({ carryCostPerUnit: n })}
                    className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                  />
                </label>
              </div>
              {/* Desktop: original compact inline pills, unchanged */}
              <label
                className="hidden sm:flex items-center gap-1.5 h-9 px-2.5 rounded-md border bg-background text-[12px]"
                title="How many rupees 1 unit of the supplier's currency is worth"
              >
                <span className="text-muted-foreground whitespace-nowrap">Exchange Rate (₹)</span>
                <NumInput
                  value={inv.exchangeRate ?? 0}
                  onValue={(n) => updateInternational({ exchangeRate: n })}
                  className="w-16 h-6 px-1 text-right border rounded bg-background focus:border-primary outline-none"
                />
              </label>
              <label className="hidden sm:flex items-center gap-1.5 h-9 px-2.5 rounded-md border bg-background text-[12px]">
                <span className="text-muted-foreground whitespace-nowrap">Carry cost/pc</span>
                <NumInput
                  value={inv.carryCostPerUnit ?? 0}
                  onValue={(n) => updateInternational({ carryCostPerUnit: n })}
                  className="w-16 h-6 px-1 text-right border rounded bg-background focus:border-primary outline-none"
                />
                <span className="text-muted-foreground">₹</span>
              </label>
            </>
          )}
          {/* GST toggle — desktop position */}
          <label className="hidden sm:flex items-center gap-2 h-9 px-3 rounded-md border bg-background cursor-pointer select-none">
            <input
              type="checkbox"
              checked={gstOn}
              onChange={toggleGst}
              className="accent-primary"
            />
            <span className="text-[12px] font-semibold">GST Bill</span>
          </label>
        </div>
      </div>

      <div className="p-4 md:p-5 space-y-4 overflow-auto flex-1 bg-muted/30">
        {/* Party + meta */}
        <div className="bg-card border rounded-lg shadow-card p-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 mb-3">
            <span className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
              {isSale ? "Customer Details" : "Supplier Details"}
            </span>
            {inv.partyId ? (
              <span className="inline-flex items-center gap-1.5 flex-wrap">
                <span className="text-[11px] inline-flex items-center gap-1 text-success font-medium bg-success-soft px-2 py-0.5 rounded shrink-0">
                  ✓ Existing party
                </span>
                {partyBalance !== null && Math.abs(partyBalance) > 0.01 && (
                  <span
                    className={`text-[11px] font-semibold px-2 py-0.5 rounded shrink-0 ${partyBalance > 0 ? "text-destructive bg-destructive/10" : "text-success bg-success-soft"}`}
                  >
                    {partyBalance > 0
                      ? `${isSale ? "Receivable" : "Payable"}: ${fmtMoney(partyBalance)}`
                      : `Advance: ${fmtMoney(-partyBalance)}`}
                  </span>
                )}
              </span>
            ) : partyQ || phoneQ ? (
              <span className="text-[11px] inline-flex items-center gap-1 text-primary font-medium bg-primary-soft px-2 py-0.5 rounded self-start">
                <UserPlus className="h-3 w-3" /> New party — details asked on save
              </span>
            ) : null}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="relative">
              <label className="flex flex-col gap-1 text-[12px]">
                <span className="text-muted-foreground font-medium">
                  {isSale ? "Customer Name" : "Supplier Name"} *
                </span>
                <div className="flex gap-1">
                  <input
                    ref={partyRef}
                    value={partyQ}
                    onChange={(e) => {
                      setPartyQ(e.target.value);
                      setPartyOpen(true);
                      setPartyIdx(0);
                      if (inv.partyId) setInv({ ...inv, partyId: "", partyName: e.target.value });
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
                        } else phoneRef.current?.focus();
                      } else if (e.key === "Escape" && partyOpen) {
                        // Close the list, and nothing else — see the note on
                        // useEscapeToLeave.
                        e.preventDefault();
                        e.stopPropagation();
                        setPartyOpen(false);
                      }
                    }}
                    className="h-9 px-3 border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none flex-1"
                    placeholder="Type name or search…"
                  />
                  {inv.partyId && (
                    <button
                      type="button"
                      onClick={clearParty}
                      className="h-9 w-9 rounded-md border bg-background hover:bg-accent text-muted-foreground flex items-center justify-center"
                      title="Clear"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </label>
              {partyOpen && partySuggests.length > 0 && (
                <div className="absolute z-20 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-elevated max-h-64 overflow-auto">
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
                      <div className="text-[11px] text-muted-foreground">
                        {p.phone && <>📞 {p.phone}</>}
                        {p.phone && p.gstin && " · "}
                        {p.gstin && <>GSTIN: {p.gstin}</>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <label className="flex flex-col gap-1 text-[12px]">
              <span className="text-muted-foreground font-medium">Phone Number</span>
              <input
                ref={phoneRef}
                value={phoneQ}
                onChange={(e) => {
                  const v = e.target.value;
                  setPhoneQ(v);
                  if (inv.partyId) setInv({ ...inv, partyId: "", partyPhone: v });
                  // Auto-match by phone (10 digits)
                  if (v.length >= 10) {
                    const match = allParties.find((p) => (p.phone ?? "").trim() === v.trim());
                    if (match) selectParty(match);
                  }
                }}
                className="h-9 px-3 border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none"
                placeholder="10-digit phone (auto-match)"
                inputMode="numeric"
              />
            </label>

            <Field
              id="inv-date"
              label="Bill Date"
              type="date"
              value={inv.date}
              onChange={(e) => setInv({ ...inv, date: e.target.value })}
            />

            <div className="flex flex-col gap-1 text-[12px]">
              <span className="text-muted-foreground font-medium">
                {isSale ? "Invoice #" : "Bill #"}
              </span>
              <div className="flex items-center gap-1">
                {numberEditing ? (
                  <>
                    <input
                      ref={numberRef}
                      value={inv.number}
                      onChange={(e) => {
                        numberTouched.current = true;
                        setInv({ ...inv, number: e.target.value });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === "Escape") setNumberEditing(false);
                      }}
                      className="h-9 px-3 border-2 border-primary rounded-md bg-background focus:outline-none font-mono font-semibold text-primary flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => setNumberEditing(false)}
                      className="h-9 w-9 flex items-center justify-center rounded-md border bg-success-soft text-success hover:opacity-80 transition flex-shrink-0"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <>
                    <div className="h-9 px-3 border rounded-md bg-muted flex items-center font-mono font-semibold text-muted-foreground flex-1">
                      {inv.number}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setNumberEditing(true);
                        setTimeout(() => numberRef.current?.focus(), 30);
                      }}
                      className="h-9 w-9 flex items-center justify-center rounded-md border bg-background hover:bg-accent text-muted-foreground hover:text-foreground transition flex-shrink-0"
                      title="Edit invoice number"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
              <span className="text-[10px] text-muted-foreground">
                Auto-generated · click ✎ to edit
              </span>
            </div>
          </div>
        </div>

        {/* Line items — each blank row below the filled ones is its own
            search-and-add field (Vyapar-style), not a separate search bar */}
        <div className="border rounded-lg bg-card shadow-card">
          <div className="px-4 py-2.5 border-b bg-muted/50 flex items-center justify-between rounded-t-lg">
            <span className="text-[13px] font-semibold">Items ({inv.lineItems.length})</span>
            <span className="text-[11px] text-muted-foreground">
              Type an item name in a row below to add it
            </span>
          </div>
          <div className="overflow-x-auto rounded-b-lg">
            <table className="w-full text-[13px] min-w-[720px]">
              <thead className="text-[11px] text-muted-foreground uppercase tracking-wider">
                <tr className="bg-muted/40">
                  <th className="text-left px-3 py-2 w-8">#</th>
                  <th className="text-left px-3 py-2">Item</th>
                  <th className="text-right w-20 py-2 px-2">Qty</th>
                  {showUnitCol && <th className="text-left w-20 py-2 px-2">Unit</th>}
                  {inv.isInternational && (
                    <th className="text-right w-28 py-2 px-2 whitespace-nowrap">Foreign Price</th>
                  )}
                  <th className="text-right w-24 py-2 px-2">Price</th>
                  {showDiscCol && <th className="text-right w-20 py-2 px-2">Disc%</th>}
                  {gstOn && <th className="text-right w-20 py-2 px-2">GST%</th>}
                  <th className="text-right w-28 py-2 pr-3">Amount</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {inv.lineItems.map((l, idx) => (
                  <tr
                    key={l.id}
                    className="border-t hover:bg-accent/30"
                    // Backspace in an empty box walks back along the line —
                    // price to unit, unit to qty, qty to the item picker.
                    onKeyDown={(e) =>
                      stepBackOnBackspace(e, { onStart: () => setReopenPickerFor(l.id) })
                    }
                  >
                    <td className="px-3 py-1.5 text-muted-foreground text-[11px]">{idx + 1}</td>
                    <td className="px-3 py-1.5">
                      <ItemNameCell
                        name={l.name}
                        items={items}
                        isSale={isSale}
                        gstOn={gstOn}
                        onChange={(it) => changeLineItem(l.id, it)}
                        openNow={reopenPickerFor === l.id}
                        onOpened={() => setReopenPickerFor(null)}
                      />
                    </td>
                    <td className="py-1.5 px-1">
                      <NumInput
                        id={`qty-${l.id}`}
                        value={l.qty}
                        onValue={(n) => updateLine(l.id, { qty: n })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            focusFirstPendingRow();
                          }
                        }}
                        className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                      />
                    </td>
                    {showUnitCol && (
                      <td className="py-1.5 px-1">
                        <input
                          value={l.unit}
                          onChange={(e) => updateLine(l.id, { unit: e.target.value })}
                          className="w-full h-7 px-1.5 border rounded bg-background focus:border-primary outline-none"
                        />
                      </td>
                    )}
                    {inv.isInternational && (
                      <td className="py-1.5 px-1">
                        <NumInput
                          value={l.foreignPrice ?? 0}
                          onValue={(n) => updateLine(l.id, { foreignPrice: n })}
                          className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                        />
                      </td>
                    )}
                    <td className="py-1.5 px-1 relative">
                      {inv.partyId ? (
                        <PriceHistoryCell
                          value={l.price}
                          onValue={(n) => updateLine(l.id, { price: n })}
                          history={partyItemHistory(l.itemId)}
                          partyName={inv.partyName}
                          isSale={isSale}
                        />
                      ) : (
                        <NumInput
                          value={l.price}
                          onValue={(n) => updateLine(l.id, { price: n })}
                          className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                        />
                      )}
                    </td>
                    {showDiscCol && (
                      <td className="py-1.5 px-1">
                        <NumInput
                          value={l.discountPct}
                          onValue={(n) => updateLine(l.id, { discountPct: n })}
                          className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                        />
                      </td>
                    )}
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
                {pendingRowIds.map((id) => (
                  <ItemEntryRow
                    key={id}
                    items={items}
                    gstOn={gstOn}
                    isSale={isSale}
                    isInternational={!!inv.isInternational}
                    showUnit={showUnitCol}
                    showDisc={showDiscCol}
                    onAdd={(it) => {
                      focusQtyId.current = addLineItem(it);
                      completePendingRow(id);
                    }}
                    onAddNew={(name) => setQuickAddItem({ name, rowId: id })}
                    registerInput={(el) => {
                      pendingInputRefs.current[id] = el;
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Totals + notes */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
          <div className="lg:col-span-2 border rounded-lg bg-card shadow-card overflow-hidden text-sm">
            {/* Amount breakdown */}
            <div className="p-4 space-y-2.5">
              <Row label="Subtotal" value={fmtMoney(inv.subtotal)} />
              {gstOn && <Row label="Tax (GST)" value={fmtMoney(inv.taxAmount)} />}
              <div className="flex justify-between items-center gap-2">
                <span className="text-muted-foreground">Extra Discount</span>
                <NumInput
                  value={inv.discount}
                  onValue={(n) => setDiscount(n)}
                  className="w-28 h-8 px-2 text-right border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none tabular-nums"
                />
              </div>
              {isSale && (
                <div className="flex justify-between items-center gap-2">
                  <span className="text-muted-foreground">Shipping Charge</span>
                  <NumInput
                    value={inv.shippingCharge ?? 0}
                    onValue={(n) => setShippingCharge(n)}
                    className="w-28 h-8 px-2 text-right border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none tabular-nums"
                  />
                </div>
              )}
              {!!inv.roundOff && Math.abs(inv.roundOff) > 0.001 && (
                <Row
                  label="Round Off"
                  value={`${inv.roundOff > 0 ? "+" : "−"}${fmtMoney(Math.abs(inv.roundOff))}`}
                />
              )}
            </div>

            {/* Total — its own band so it reads as the one number that matters */}
            <div className="flex justify-between items-center gap-2 px-4 py-3 bg-muted/40 border-y font-bold text-lg">
              <span>Total</span>
              <span className="tabular-nums text-primary">{fmtMoney(inv.total)}</span>
            </div>

            {/* Payment */}
            <div className="p-4 space-y-2.5">
              <div className="flex justify-between items-center gap-2">
                <span className="text-muted-foreground">Payment Mode</span>
                <ModePills
                  value={inv.paymentMode}
                  onChange={(newMode: PaymentMode) => {
                    setInv({
                      ...inv,
                      paymentMode: newMode,
                      paid: newMode === "credit" ? 0 : inv.paid,
                      bankId: newMode === "bank" ? inv.bankId : undefined,
                    });
                  }}
                  modes={["cash", "bank", "credit"]}
                />
              </div>
              {inv.paymentMode === "bank" && (
                <div className="relative flex flex-col gap-1.5">
                  <span className="text-muted-foreground text-[12px]">Bank Account *</span>
                  <input
                    ref={bankSelectRef}
                    value={bankQ}
                    onChange={(e) => {
                      setBankQ(e.target.value);
                      setBankOpen(true);
                      setBankIdx(0);
                      if (inv.bankId) setInv({ ...inv, bankId: undefined });
                    }}
                    onFocus={() => setBankOpen(true)}
                    onBlur={() => setTimeout(() => setBankOpen(false), 150)}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setBankIdx((i) => Math.min(bankSuggests.length - 1, i + 1));
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setBankIdx((i) => Math.max(0, i - 1));
                      } else if (e.key === "Enter") {
                        e.preventDefault();
                        if (bankSuggests[bankIdx]) {
                          selectBank(bankSuggests[bankIdx]);
                        }
                      } else if (e.key === "Escape" && bankOpen) {
                        e.preventDefault();
                        e.stopPropagation();
                        setBankOpen(false);
                      }
                    }}
                    placeholder="Search bank account…"
                    className="h-9 px-3 border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none text-[13px]"
                  />
                  {bankOpen && bankSuggests.length > 0 && (
                    <div className="absolute z-20 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-elevated max-h-56 overflow-auto">
                      {bankSuggests.map((b, i) => (
                        <div
                          key={b.id}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectBank(b);
                          }}
                          className={`px-3 py-2 text-sm cursor-pointer ${i === bankIdx ? "bg-accent" : "hover:bg-accent"}`}
                        >
                          {b.name}
                          {b.accountNumber ? ` — ${b.accountNumber}` : ""}
                        </div>
                      ))}
                    </div>
                  )}
                  {bankOpen && bankQ && bankSuggests.length === 0 && (
                    <div className="absolute z-20 top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-elevated px-3 py-2 text-xs text-muted-foreground">
                      No matching bank account
                    </div>
                  )}
                  {banks.length === 0 && (
                    <p className="text-[11px] text-amber-600">
                      No bank accounts set up yet — add one from Bank Accounts first.
                    </p>
                  )}
                </div>
              )}
              <div className="flex justify-between items-center gap-2 pt-1">
                <span className="text-muted-foreground">
                  {mode === "sale" ? "Received Amount" : "Paid Amount"}
                </span>
                {inv.paymentMode === "credit" ? (
                  <span className="text-[12px] text-muted-foreground select-none">
                    ₹0.00 — {mode === "sale" ? "will receive later" : "will pay later"}
                  </span>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={(e) => {
                        // Safari doesn't focus a clicked <button> by default
                        // (Chrome/Firefox do) — force it so Tab/Enter still
                        // continues the form flow from here on Safari too.
                        e.currentTarget.focus();
                        setInv({ ...inv, paid: inv.total });
                      }}
                      className="h-8 px-2.5 rounded-md border bg-success-soft text-success text-[11px] font-semibold hover:opacity-80 focus:ring-2 focus:ring-ring/20 outline-none transition"
                      title="Received full amount"
                    >
                      Full
                    </button>
                    <NumInput
                      value={inv.paid}
                      onValue={(n) => setInv({ ...inv, paid: n })}
                      className="w-24 h-8 px-2 text-right border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none tabular-nums"
                    />
                  </div>
                )}
              </div>
              <div className="flex justify-between items-center gap-2 pt-2 mt-1 border-t font-semibold">
                <span>Balance Due</span>
                <span
                  className={`tabular-nums ${inv.total - inv.paid > 0 ? "text-destructive" : "text-success"}`}
                >
                  {fmtMoney(Math.max(0, inv.total - inv.paid))}
                </span>
              </div>
            </div>
          </div>

          <div className="bg-card border rounded-lg shadow-card p-4">
            <label className="flex flex-col gap-1.5 text-[12px] h-full">
              <span className="text-muted-foreground font-medium uppercase text-[11px] tracking-wider">
                Notes / Terms
                <span className="normal-case font-normal text-muted-foreground/70">
                  {" "}
                  (optional)
                </span>
              </span>
              <textarea
                value={inv.notes ?? ""}
                onChange={(e) => setInv({ ...inv, notes: e.target.value })}
                placeholder="Add any note or terms & conditions…"
                className="flex-1 min-h-[140px] px-3 py-2 border rounded-md bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none resize-none"
              />
            </label>
          </div>
        </div>
      </div>

      {/* Bottom action bar — kept last in DOM/tab order on purpose: the whole
          form (party, items, totals, notes) is fully keyboard-navigable via
          Tab, and this is where that flow naturally lands to save. */}
      <div className="px-4 md:px-5 py-3 border-t bg-card flex items-center gap-2">
        {/* Keyboard hint is meaningless on a touchscreen — desktop only */}
        <span className="hidden md:inline text-[11px] text-muted-foreground mr-auto">
          Tab/Enter to move · Ctrl+S save · Esc cancel
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate({ to: isSale ? "/sales" : "/purchase" })}
          className="shrink-0"
        >
          <X className="h-3.5 w-3.5" /> Cancel
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => save(true)}
          disabled={saving}
          className="shrink-0"
        >
          <Printer className="h-3.5 w-3.5" /> Save & Print
        </Button>
        <Button
          size="sm"
          onClick={() => save()}
          disabled={saving}
          className="flex-1 md:flex-none bg-primary text-primary-foreground"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      <PrintableInvoice inv={inv} company={company} mode={mode} />
      <QuickAddPartyDialog
        draft={quickAddParty}
        isSale={isSale}
        existingParties={allParties}
        onCancel={() => setQuickAddParty(null)}
        onPickExisting={(p) => {
          setQuickAddParty(null);
          selectParty(p);
        }}
        onConfirm={confirmQuickAddParty}
      />
      <QuickAddItemDialog
        draft={quickAddItem}
        isSale={isSale}
        existingItems={items}
        onCancel={() => setQuickAddItem(null)}
        onPickExisting={(it) => {
          if (!quickAddItem) return;
          focusQtyId.current = addLineItem(it);
          completePendingRow(quickAddItem.rowId);
          setQuickAddItem(null);
        }}
        onConfirm={confirmQuickAddItem}
      />
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function ItemEntryRow({
  items,
  onAdd,
  onAddNew,
  gstOn,
  isSale,
  isInternational,
  showUnit,
  showDisc,
  registerInput,
}: {
  items: Item[];
  onAdd: (i: Item) => void;
  onAddNew: (name: string) => void;
  gstOn: boolean;
  isSale: boolean;
  isInternational: boolean;
  /** Must mirror the header's optional columns exactly. This row kept
   * emitting Unit and Disc% cells after they were dropped from the header,
   * so the grid grew two dead boxes on the right and stopped lining up. */
  showUnit: boolean;
  showDisc: boolean;
  registerInput: (el: HTMLInputElement | null) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const inputElRef = useRef<HTMLInputElement | null>(null);
  const [dropdownRect, setDropdownRect] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  // The row lives inside a horizontally-scrollable table
  // (overflow-x-auto), which per the CSS spec also forces overflow-y to
  // "auto" once overflow-x isn't "visible" — so a plain absolutely
  // positioned dropdown gets silently clipped by the table's own scroll
  // box. Render it through a portal instead, positioned in viewport
  // coordinates from the input's own rect, so it floats above everything.
  useEffect(() => {
    if (!open) return;
    const updateRect = () => {
      const el = inputElRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const next = { top: r.bottom + 4, left: r.left, width: r.width };
      // Bail out when nothing actually moved. This listener is registered
      // with capture:true, so it also fires for scrolls that happen INSIDE
      // the dropdown — and writing a fresh object there re-rendered the list
      // on every scroll frame, which threw the list back to the top. The
      // input hasn't moved when you scroll the options, so returning the
      // previous state makes React skip the render entirely (it also stops
      // a 200-row list re-rendering on every frame of an outer scroll).
      setDropdownRect((prev) =>
        prev && prev.top === next.top && prev.left === next.left && prev.width === next.width
          ? prev
          : next,
      );
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
  //
  // This used to be capped at 8 rows, which is why the catalogue looked
  // truncated: a shop with hundreds of items could only ever see the first
  // eight of them, matched on one contiguous substring. Now every typed word
  // is matched independently against name/SKU/barcode (so "guard fan" finds
  // "V-GUARD GLADO 1200MM FAN"), best matches sort first, and the list
  // scrolls. The remaining cap is a rendering guard, not a search limit —
  // see the "+N more" footer.
  const allMatches = q.trim()
    ? items
        .filter((i) => matchesQuery(q, i.name, i.sku, i.barcode))
        .sort(byRelevance(q, (i) => i.name))
    : items;
  const suggests = allMatches.slice(0, MAX_SUGGESTIONS);
  const hiddenCount = allMatches.length - suggests.length;

  // Keep the keyboard-highlighted option visible — but ONLY when the
  // highlight actually moves. This used to be a ref callback that ran on
  // every render, so any unrelated re-render (the dropdown's own scroll
  // listener, a repo update) called scrollIntoView on the highlighted row
  // and snapped a scrolled list straight back to the top. That is what made
  // the item list feel impossible to scroll.
  const optionsRef = useRef<HTMLDivElement>(null);
  const prevIdx = useRef(idx);
  useEffect(() => {
    if (prevIdx.current === idx) return;
    prevIdx.current = idx;
    optionsRef.current?.querySelector(`[data-opt="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  // Offer "add as new item" whenever the typed name doesn't exactly match an existing one
  const trimmed = q.trim();
  const showAddNew =
    trimmed.length > 0 && !items.some((i) => i.name.trim().toLowerCase() === trimmed.toLowerCase());
  const optionCount = suggests.length + (showAddNew ? 1 : 0);

  // No local reset()/refocus here — once an item is added this row is
  // retired by the parent (a fresh blank row takes its id's place), and the
  // parent moves focus to the new line's Qty field, not back into this row.
  const pick = (it: Item) => onAdd(it);
  const pickNew = () => onAddNew(trimmed);
  const choose = (i: number) => {
    if (i < suggests.length) pick(suggests[i]);
    else if (showAddNew) pickNew();
  };

  return (
    <tr className="border-t hover:bg-accent/20">
      <td className="px-3 py-1.5"></td>
      <td className="px-3 py-1.5">
        <input
          ref={(el) => {
            inputElRef.current = el;
            registerInput(el);
          }}
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
              setIdx((i) => Math.min(optionCount - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (optionCount > 0) choose(idx);
            } else if (e.key === "Escape" && open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
          placeholder="Type item name to add…"
          className="w-full h-8 px-2 border rounded bg-background focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none text-sm"
        />
        {open &&
          optionCount > 0 &&
          dropdownRect &&
          createPortal(
            <div
              style={{
                position: "fixed",
                top: dropdownRect.top,
                left: dropdownRect.left,
                width: dropdownRect.width,
              }}
              className="z-50 border rounded-md bg-popover shadow-elevated max-h-72 flex flex-col"
            >
              {/* The list scrolls; the "+N more" note below does NOT live
                  inside it. As a sticky child of the scroller it sat on top
                  of the last row and hid it. */}
              <div ref={optionsRef} className="overflow-auto flex-1 min-h-0">
                {suggests.map((it, i) => (
                  <div
                    key={it.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(it);
                    }}
                    data-opt={i}
                    className={`px-3 py-2 text-sm cursor-pointer flex justify-between ${i === idx ? "bg-accent" : "hover:bg-accent"}`}
                  >
                    <div>
                      <div className="font-semibold">{it.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        Stock: {it.stock} {it.unit}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-semibold tabular-nums">
                        {fmtMoney(isSale ? it.salePrice || it.purchasePrice : it.purchasePrice)}
                      </div>
                      {gstOn && (
                        <div className="text-[11px] text-muted-foreground">GST {it.gstRate}%</div>
                      )}
                    </div>
                  </div>
                ))}
                {showAddNew && (
                  <div
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickNew();
                    }}
                    className={`px-3 py-2 text-sm cursor-pointer flex items-center gap-2 border-t ${idx === suggests.length ? "bg-accent" : "hover:bg-accent"}`}
                  >
                    <span className="h-5 w-5 rounded bg-primary-soft text-primary flex items-center justify-center text-xs font-bold">
                      +
                    </span>
                    <span>
                      Add "<span className="font-semibold">{trimmed}</span>" as new item
                    </span>
                  </div>
                )}
              </div>
              {hiddenCount > 0 && (
                <div className="shrink-0 px-3 py-2 text-[11px] text-muted-foreground border-t bg-muted/40">
                  +{hiddenCount} more — keep typing to narrow it down
                </div>
              )}
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
      {showUnit && (
        <td className="py-1.5 px-1">
          <input
            disabled
            className="w-full h-7 px-1.5 border rounded bg-muted/40 text-muted-foreground/50 outline-none cursor-not-allowed"
          />
        </td>
      )}
      {isInternational && (
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
      {showDisc && (
        <td className="py-1.5 px-1">
          <input
            disabled
            className="w-full h-7 px-1.5 text-right border rounded bg-muted/40 text-muted-foreground/50 outline-none cursor-not-allowed"
          />
        </td>
      )}
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

function ItemNameCell({
  name,
  items,
  isSale,
  gstOn,
  onChange,
  openNow,
  onOpened,
}: {
  name: string;
  items: Item[];
  isSale: boolean;
  gstOn: boolean;
  onChange: (it: Item) => string;
  /** Reopen the picker from outside — see the Qty box's Backspace. */
  openNow?: boolean;
  onOpened?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputElRef = useRef<HTMLInputElement | null>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!editing) return;
    const updateRect = () => {
      const el = inputElRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 240) });
    };
    updateRect();
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
    };
  }, [editing]);

  const startEdit = () => {
    setQ("");
    setIdx(0);
    setEditing(true);
  };

  // Picking the wrong item is the most common slip on this screen, and until
  // now the only way back was to notice the name is a button and click it.
  // The Qty box hands the line back here on Backspace; this is the other end
  // of that.
  useEffect(() => {
    if (!openNow) return;
    startEdit();
    onOpened?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNow]);

  // Same all-words matching and rendering cap as the main item search bar —
  // this picker was capped at 8 too, so swapping a line's item could only
  // ever reach the first eight of the catalogue.
  const allMatches = q.trim()
    ? items
        .filter((i) => matchesQuery(q, i.name, i.sku, i.barcode))
        .sort(byRelevance(q, (i) => i.name))
    : items;
  const suggests = allMatches.slice(0, MAX_SUGGESTIONS);
  const hiddenCount = allMatches.length - suggests.length;

  // Keep the keyboard-highlighted option visible — but ONLY when the
  // highlight actually moves. This used to be a ref callback that ran on
  // every render, so any unrelated re-render (the dropdown's own scroll
  // listener, a repo update) called scrollIntoView on the highlighted row
  // and snapped a scrolled list straight back to the top. That is what made
  // the item list feel impossible to scroll.
  const optionsRef = useRef<HTMLDivElement>(null);
  const prevIdx = useRef(idx);
  useEffect(() => {
    if (prevIdx.current === idx) return;
    prevIdx.current = idx;
    optionsRef.current?.querySelector(`[data-opt="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const pick = (it: Item) => {
    setEditing(false);
    const focusId = onChange(it);
    setTimeout(() => {
      const qtyEl = document.getElementById(`qty-${focusId}`) as HTMLInputElement | null;
      qtyEl?.focus();
    }, 0);
  };

  if (!editing) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={startEdit}
        onKeyDown={(e) => {
          // Backspace/Delete read as "undo this choice" on a field that
          // already holds one; Enter and Space are what any focusable
          // control is expected to answer to.
          if (e.key === "Enter" || e.key === " " || e.key === "Backspace" || e.key === "Delete") {
            e.preventDefault();
            startEdit();
          }
        }}
        title="Click, or press Backspace, to change item"
        className="font-medium cursor-pointer hover:underline hover:text-primary"
      >
        {name}
      </div>
    );
  }

  return (
    <>
      <input
        ref={inputElRef}
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setIdx(0);
        }}
        onBlur={() => setTimeout(() => setEditing(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setEditing(false);
          } else if (e.key === "ArrowDown") {
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
        placeholder="Type to change item…"
        className="w-full h-7 px-1.5 border rounded bg-background focus:border-primary outline-none text-sm"
      />
      {rect &&
        createPortal(
          <div
            style={{ position: "fixed", top: rect.top, left: rect.left, width: rect.width }}
            className="z-50 border rounded-md bg-popover shadow-elevated max-h-72 flex flex-col"
          >
            <div ref={optionsRef} className="overflow-auto flex-1 min-h-0">
              {suggests.length === 0 && (
                <div className="px-3 py-3 text-[12px] text-muted-foreground text-center">
                  No items found
                </div>
              )}
              {suggests.map((it, i) => (
                <div
                  key={it.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(it);
                  }}
                  data-opt={i}
                  className={`px-3 py-2 text-sm cursor-pointer flex justify-between ${i === idx ? "bg-accent" : "hover:bg-accent"}`}
                >
                  <div>
                    <div className="font-semibold">{it.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      Stock: {it.stock} {it.unit}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold tabular-nums">
                      {fmtMoney(isSale ? it.salePrice || it.purchasePrice : it.purchasePrice)}
                    </div>
                    {gstOn && (
                      <div className="text-[11px] text-muted-foreground">GST {it.gstRate}%</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {hiddenCount > 0 && (
              <div className="shrink-0 px-3 py-2 text-[11px] text-muted-foreground border-t bg-muted/40">
                +{hiddenCount} more — keep typing to narrow it down
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function PriceHistoryCell({
  value,
  onValue,
  history,
  partyName,
  isSale,
}: {
  value: number;
  onValue: (n: number) => void;
  history: { date: string; qty: number; price: number }[];
  partyName: string;
  isSale: boolean;
}) {
  const [open, setOpen] = useState(false);
  const inputElRef = useRef<HTMLInputElement | null>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);

  // Same portal trick as ItemEntryRow's dropdown — this cell lives inside
  // the overflow-x-auto item table, so a plain absolutely positioned popup
  // gets clipped by the table's own scroll box.
  useEffect(() => {
    if (!open) return;
    const updateRect = () => {
      const el = inputElRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.bottom + 4, left: r.right - 256, width: 256 });
    };
    updateRect();
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
    };
  }, [open]);

  return (
    <>
      <NumInput
        ref={inputElRef}
        value={value}
        onValue={onValue}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="w-full h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
      />
      {open &&
        rect &&
        createPortal(
          <div
            style={{ position: "fixed", top: rect.top, left: rect.left, width: rect.width }}
            className="z-50 border rounded-md bg-popover shadow-elevated overflow-hidden"
          >
            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground bg-muted/50 border-b">
              Last {isSale ? "Sale" : "Purchase"} Prices — {partyName}
            </div>
            {!history.length ? (
              <div className="px-3 py-3 text-[12px] text-muted-foreground text-center">
                No previous transaction found
              </div>
            ) : (
              <div>
                <div className="grid grid-cols-3 gap-2 px-3 py-1 text-[10px] font-semibold uppercase text-muted-foreground border-b">
                  <span>Date</span>
                  <span className="text-right">Qty</span>
                  <span className="text-right">Price</span>
                </div>
                {history.map((h, i) => (
                  <button
                    type="button"
                    key={i}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onValue(h.price);
                      setOpen(false);
                    }}
                    className="w-full grid grid-cols-3 gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-accent border-b last:border-0"
                  >
                    <span className="text-muted-foreground">{fmtDate(h.date)}</span>
                    <span className="text-right tabular-nums">{h.qty}</span>
                    <span className="text-right tabular-nums font-semibold">
                      {fmtMoney(h.price)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function QuickAddItemDialog({
  draft,
  isSale,
  existingItems = [],
  onCancel,
  onPickExisting,
  onConfirm,
}: {
  draft: { name: string; rowId: string } | null;
  isSale: boolean;
  existingItems?: Item[];
  onCancel: () => void;
  onPickExisting?: (it: Item) => void;
  onConfirm: (details: {
    name: string;
    unit: string;
    gstRate: number;
    salePrice: number;
    purchasePrice: number;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("pcs");
  const [gstRate, setGstRate] = useState(0);
  const [salePrice, setSalePrice] = useState(0);
  const [purchasePrice, setPurchasePrice] = useState(0);
  const [nameOpen, setNameOpen] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (draft) {
      setName(draft.name);
      setUnit("pcs");
      setGstRate(0);
      setSalePrice(0);
      setPurchasePrice(0);
      setNameOpen(false);
      setTimeout(() => firstRef.current?.focus(), 50);
    }
  }, [draft]);

  if (!draft) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Name required");
      return;
    }
    onConfirm({ name, unit, gstRate, salePrice, purchasePrice });
  };

  // Live "does this already exist?" hint — the name typed at the counter
  // didn't exactly match anyone, but if they edit it here into something
  // close to an existing item, flag it before a near-duplicate gets created.
  const nameQ = name.trim().toLowerCase();
  const similarItemsAll = nameQ
    ? existingItems.filter((it) => it.name.trim().toLowerCase().includes(nameQ))
    : [];
  const similarItems = similarItemsAll.slice(0, 5);

  return (
    <Dialog open onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            New Item
          </DialogTitle>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground -mt-2">
          "{draft.name}" isn't in your items list yet — set its price & GST before adding it to this{" "}
          {isSale ? "invoice" : "bill"}.
        </p>
        <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2 relative">
            <Field
              ref={firstRef}
              label="Name *"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
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
                  click to use it instead
                </div>
                {similarItems.map((it) => (
                  <div
                    key={it.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onPickExisting?.(it);
                      setNameOpen(false);
                    }}
                    className="px-3 py-2 text-sm cursor-pointer hover:bg-accent flex items-center justify-between"
                  >
                    <span className="font-medium">{it.name}</span>
                    <span className="text-[11px] text-muted-foreground">
                      Stock: {it.stock} {it.unit}
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
          <Field label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
          <NumField
            label="GST Rate (%)"
            value={gstRate}
            onValue={(n) => setGstRate(Math.max(0, n))}
          />
          <NumField
            label={isSale ? "Sale Price *" : "Purchase Price *"}
            value={isSale ? salePrice : purchasePrice}
            onValue={(n) => {
              const v = Math.max(0, n);
              if (isSale) setSalePrice(v);
              else setPurchasePrice(v);
            }}
          />
          <NumField
            label={isSale ? "Purchase Price" : "Sale Price"}
            value={isSale ? purchasePrice : salePrice}
            onValue={(n) => {
              const v = Math.max(0, n);
              if (isSale) setPurchasePrice(v);
              else setSalePrice(v);
            }}
          />
          <div className="sm:col-span-2 flex justify-end gap-2 mt-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">Add & Continue</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

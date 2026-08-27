import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/store/workspace";
import { useNavigate } from "@tanstack/react-router";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { PartyRepo, ItemRepo, SalesRepo, PurchaseRepo } from "@/repositories";
import { usePermissions } from "@/hooks/usePermissions";
import { useRepoData } from "@/hooks/useRepoData";
import { useStickyState } from "@/hooks/useStickySearch";
import type { Party, Item, Invoice } from "@/types";
import { matchesQuery, byRelevance } from "@/lib/search";

/** How many rows to show per group when the box is EMPTY — a browse list,
 * not a search result. Once anything is typed every match is listed and the
 * panel scrolls, because hiding matches behind "+N more" is the one thing a
 * search must never do. */
const BROWSE_LIMIT = 8;
import { Users, Package, ShoppingCart, Truck } from "lucide-react";

export function GlobalSearch() {
  const _repoV = useRepoData();
  const { globalSearchOpen, setGlobalSearch } = useWorkspace();
  const navigate = useNavigate();
  const { isOwner, canView } = usePermissions();
  const [q, setQ] = useStickyState("global.search", "");
  const [data, setData] = useState<{
    parties: Party[];
    items: Item[];
    sales: Invoice[];
    purchases: Invoice[];
  }>({ parties: [], items: [], sales: [], purchases: [] });

  // Belt-and-suspenders on top of permission-aware hydration (a repo for a
  // module the user can't view is never populated in the first place, so
  // .all() is already empty for them) — an explicit check here means this
  // stays safe even if hydration's own scoping ever regresses later.
  useEffect(() => {
    if (globalSearchOpen) {
      // The last search is kept, not wiped. Opening a result and coming back
      // to an empty box meant retyping it every time; the text is selected on
      // focus, so typing still replaces it in one go.
      setData({
        parties: isOwner || canView("masterData") ? PartyRepo.all() : [],
        items: isOwner || canView("masterData") ? ItemRepo.all() : [],
        sales: isOwner || canView("sales") ? SalesRepo.all() : [],
        purchases: isOwner || canView("purchaseExpenses") ? PurchaseRepo.all() : [],
      });
    }
  }, [globalSearchOpen, isOwner, canView, _repoV]);

  const goParty = (id: string) => {
    setGlobalSearch(false);
    navigate({ to: "/parties/$id", params: { id } });
  };
  const goItem = (id: string) => {
    setGlobalSearch(false);
    navigate({ to: "/items/$id", params: { id } });
  };
  const goSale = (id: string) => {
    setGlobalSearch(false);
    navigate({ to: "/sales/$id", params: { id } });
  };
  const goPurchase = (id: string) => {
    setGlobalSearch(false);
    navigate({ to: "/purchase/$id", params: { id } });
  };

  // The query is controlled here, and cmdk's own filtering is switched off
  // (`shouldFilter={false}`), because the previous arrangement searched only
  // what had already been rendered: each group emitted `.slice(0, 6)` of the
  // collection and cmdk then filtered those six. On a real shop that means
  // the 7th party — and every party after it — could never be found, no
  // matter what you typed. Now every record is matched, then the display is
  // capped. Matching is the shared all-words rule, so "guard fan" finds
  // "V-GUARD GLADO 1200MM FAN".
  const parties = useMemo(
    () =>
      data.parties
        .filter((p) => matchesQuery(q, p.name, p.phone))
        .sort(byRelevance(q, (p) => p.name)),
    [data.parties, q],
  );
  const items = useMemo(
    () =>
      data.items.filter((i) => matchesQuery(q, i.name, i.sku)).sort(byRelevance(q, (i) => i.name)),
    [data.items, q],
  );
  const sales = useMemo(
    () =>
      data.sales
        .filter((s) => matchesQuery(q, s.number, s.partyName))
        .sort(byRelevance(q, (s) => s.number)),
    [data.sales, q],
  );
  const purchases = useMemo(
    () =>
      data.purchases
        .filter((s) => matchesQuery(q, s.number, s.partyName))
        .sort(byRelevance(q, (s) => s.number)),
    [data.purchases, q],
  );

  // Typing = show everything that matches. Empty = a short browse list.
  const limit = q.trim() ? Number.POSITIVE_INFINITY : BROWSE_LIMIT;
  const more = (shown: number, total: number) =>
    total > shown ? (
      <div className="px-3 py-1.5 text-[11px] text-muted-foreground">
        +{total - shown} more — start typing to search all of them
      </div>
    ) : null;

  return (
    <CommandDialog open={globalSearchOpen} onOpenChange={setGlobalSearch}>
      <Command shouldFilter={false}>
        <CommandInput
          placeholder="Search parties, items, invoices..."
          autoFocus
          value={q}
          onValueChange={setQ}
          // Select the remembered text so the next search replaces it with
          // one keystroke — the same bargain a browser address bar makes.
          onFocus={(e) => e.currentTarget.select()}
        />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          {parties.length > 0 && (
            <CommandGroup heading="Parties">
              {parties.slice(0, limit).map((p) => (
                <CommandItem
                  key={p.id}
                  onSelect={() => goParty(p.id)}
                  value={`party ${p.name} ${p.phone ?? ""}`}
                >
                  <Users className="h-3.5 w-3.5" />
                  {p.name}
                  {p.archived && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                      Archived
                    </span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">{p.phone}</span>
                </CommandItem>
              ))}
              {more(limit, parties.length)}
            </CommandGroup>
          )}
          {items.length > 0 && (
            <CommandGroup heading="Items">
              {items.slice(0, limit).map((i) => (
                <CommandItem
                  key={i.id}
                  onSelect={() => goItem(i.id)}
                  value={`item ${i.name} ${i.sku ?? ""}`}
                >
                  <Package className="h-3.5 w-3.5" />
                  {i.name}
                  <span className="ml-auto text-xs text-muted-foreground">Stock: {i.stock}</span>
                </CommandItem>
              ))}
              {more(limit, items.length)}
            </CommandGroup>
          )}
          {sales.length > 0 && (
            <CommandGroup heading="Sales Invoices">
              {sales.slice(0, limit).map((s) => (
                <CommandItem
                  key={s.id}
                  onSelect={() => goSale(s.id)}
                  value={`sale ${s.number} ${s.partyName}`}
                >
                  <ShoppingCart className="h-3.5 w-3.5" />
                  {s.number} — {s.partyName}
                </CommandItem>
              ))}
              {more(limit, sales.length)}
            </CommandGroup>
          )}
          {purchases.length > 0 && (
            <CommandGroup heading="Purchase Bills">
              {purchases.slice(0, limit).map((s) => (
                <CommandItem
                  key={s.id}
                  onSelect={() => goPurchase(s.id)}
                  value={`purchase ${s.number} ${s.partyName}`}
                >
                  <Truck className="h-3.5 w-3.5" />
                  {s.number} — {s.partyName}
                </CommandItem>
              ))}
              {more(limit, purchases.length)}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

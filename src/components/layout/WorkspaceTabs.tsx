import { useWorkspace } from "@/store/workspace";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  X,
  LayoutDashboard,
  Users,
  Package,
  Boxes,
  ShoppingCart,
  Truck,
  CornerDownLeft,
  CornerUpLeft,
  Receipt,
  Wallet,
  Landmark,
  Banknote,
  BarChart3,
  BookOpen,
  FileText,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  PartyRepo,
  ItemRepo,
  SalesRepo,
  PurchaseRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  BankRepo,
} from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";

export function WorkspaceTabs() {
  useRepoData();
  const { tabs, closeTabAndNext, openTab } = useWorkspace();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const routeTitle = titleFromPath(pathname);

  const tabElsRef = useRef<Record<string, HTMLDivElement | null>>({});
  // Chrome's rapid-close trick: while the mouse stays over the strip, a
  // closed tab's neighbors hold their exact pixel width instead of
  // reflowing to fill the gap — so clicking the same spot repeatedly closes
  // one tab after another without ever moving the cursor. Only cleared on
  // mouseleave, which is when the strip is allowed to reflow to fit again.
  const [pinnedWidths, setPinnedWidths] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    if (!routeTitle) return;
    openTab({ id: pathname, title: routeTitle, path: pathname });
  }, [pathname, routeTitle, openTab]);

  if (!tabs.length) return null;

  // Where closing lands you is decided by the store (see closeTabAndNext),
  // because Escape closes tabs too and the rule must not exist twice. What
  // stays here is the pixel trick above, which is purely about the mouse.
  const handleClose = (tabId: string) => {
    const widths: Record<string, number> = { ...pinnedWidths };
    for (const t of tabs) {
      if (t.id === tabId) continue;
      const el = tabElsRef.current[t.id];
      if (el) widths[t.id] = el.getBoundingClientRect().width;
    }
    setPinnedWidths(widths);

    const next = closeTabAndNext(tabId, pathname);
    if (next) navigate({ to: next });
  };

  return (
    <div
      className="hidden md:flex h-12 items-end bg-gradient-to-b from-muted to-muted/70 border-b border-border px-2 gap-1 overflow-x-auto shrink-0"
      onMouseLeave={() => setPinnedWidths(null)}
    >
      {tabs.map((tab) => {
        const active = tab.path === pathname;
        const Icon = iconForPath(tab.path);
        const pinnedWidth = pinnedWidths?.[tab.id];
        return (
          <Link
            key={tab.id}
            to={tab.path}
            ref={(el) => {
              tabElsRef.current[tab.id] = el as unknown as HTMLDivElement | null;
            }}
            style={pinnedWidth != null ? { flex: `0 0 ${pinnedWidth}px` } : undefined}
            className={cn(
              "group relative flex items-center gap-1.5 h-10 pl-2.5 pr-1 rounded-t-xl text-[12.5px] cursor-pointer transition-all duration-150 min-w-[72px] max-w-[152px]",
              pinnedWidth != null ? "shrink-0 overflow-hidden" : "flex-1",
              active
                ? "bg-background text-foreground font-semibold shadow-[0_-2px_8px_rgba(0,0,0,0.08)] -mb-px"
                : "bg-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground",
            )}
          >
            <Icon
              className={cn(
                "h-3.5 w-3.5 shrink-0 transition-colors",
                active ? "text-primary" : "text-muted-foreground/70 group-hover:text-foreground",
              )}
            />
            <span className="truncate flex-1 min-w-0">{tab.title}</span>
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleClose(tab.id);
              }}
              className={cn(
                "rounded-full p-0.5 hover:!opacity-100 hover:bg-accent transition-opacity shrink-0",
                active ? "opacity-60" : "opacity-0 group-hover:opacity-60",
              )}
            >
              <X className="h-3 w-3" />
            </button>
          </Link>
        );
      })}
    </div>
  );
}

// Detail pages (open from a list row, or from another detail page like item
// history) get their own tab too, titled with the actual record — not just
// left to silently reuse whatever tab happened to be active.
const DETAIL_ROUTES: { re: RegExp; title: (id: string) => string | null }[] = [
  {
    re: /^\/sales\/edit\/([^/]+)$/,
    title: (id) => {
      const inv = SalesRepo.get(id);
      return inv ? `Edit ${inv.number}` : null;
    },
  },
  {
    re: /^\/purchase\/edit\/([^/]+)$/,
    title: (id) => {
      const inv = PurchaseRepo.get(id);
      return inv ? `Edit ${inv.number}` : null;
    },
  },
  { re: /^\/sales\/([^/]+)$/, title: (id) => SalesRepo.get(id)?.number ?? null },
  { re: /^\/purchase\/([^/]+)$/, title: (id) => PurchaseRepo.get(id)?.number ?? null },
  { re: /^\/sale-return\/([^/]+)$/, title: (id) => SaleReturnRepo.get(id)?.number ?? null },
  { re: /^\/purchase-return\/([^/]+)$/, title: (id) => PurchaseReturnRepo.get(id)?.number ?? null },
  { re: /^\/parties\/([^/]+)$/, title: (id) => PartyRepo.get(id)?.name ?? null },
  { re: /^\/items\/([^/]+)$/, title: (id) => ItemRepo.get(id)?.name ?? null },
  { re: /^\/bank\/([^/]+)$/, title: (id) => BankRepo.get(id)?.name ?? null },
];

function titleFromPath(path: string): string | null {
  if (path === "/") return "Dashboard";
  const map: Record<string, string> = {
    "/parties": "Parties",
    "/items": "Items",
    "/sales": "Sales",
    "/sales/new": "New Sale",
    "/purchase": "Purchase",
    "/purchase/new": "New Purchase",
    "/sale-return": "Sale Return",
    "/sale-return/new": "New Sale Return",
    "/purchase-return": "Purchase Return",
    "/purchase-return/new": "New Purchase Return",
    "/expenses": "Expenses",
    "/payments": "Payments",
    "/inventory": "Inventory",
    "/bank": "Bank",
    "/cash": "Cash",
    "/reports": "Reports",
    "/daybook": "Daybook",
    "/gst": "GST",
    "/settings": "Settings",
  };
  if (map[path]) return map[path];
  for (const d of DETAIL_ROUTES) {
    const m = path.match(d.re);
    if (m) return d.title(m[1]);
  }
  return null;
}

const ICON_BY_SEGMENT: Record<string, LucideIcon> = {
  parties: Users,
  items: Package,
  inventory: Boxes,
  sales: ShoppingCart,
  purchase: Truck,
  "sale-return": CornerDownLeft,
  "purchase-return": CornerUpLeft,
  expenses: Receipt,
  payments: Wallet,
  bank: Landmark,
  cash: Banknote,
  reports: BarChart3,
  daybook: BookOpen,
  gst: FileText,
  settings: Settings,
};

// Keyed off the exact first path segment (not a startsWith prefix check) so
// "/purchase" and "/purchase-return" — or "/sales" and "/sale-return" —
// never cross-match each other's icon.
function iconForPath(path: string): LucideIcon {
  if (path === "/") return LayoutDashboard;
  const segment = path.split("/")[1];
  return ICON_BY_SEGMENT[segment] ?? FileText;
}

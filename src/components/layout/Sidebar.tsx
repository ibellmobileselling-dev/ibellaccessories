import { Link, useRouterState } from "@tanstack/react-router";
import { APP_NAME } from "@/lib/version";
import {
  LayoutDashboard,
  Users,
  Package,
  ShoppingCart,
  Truck,
  Receipt,
  Wallet,
  Landmark,
  Banknote,
  BarChart3,
  BookOpen,
  FileText,
  Settings,
  Boxes,
  Sparkles,
  ChevronsLeft,
  ChevronsRight,
  CornerDownLeft,
  CornerUpLeft,
  ChevronDown,
  ChevronRight,
  LogOut,
  UserSquare2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/store/workspace";
import { useState } from "react";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { stopRepos } from "@/repositories";
import { usePermissions } from "@/hooks/usePermissions";
import type { ModuleKey } from "@/types";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";

type NavItem = { path: string; label: string; icon: LucideIcon; key?: string };
type NavGroup = {
  title: string;
  items: NavItem[];
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Missing = always visible (Overview/Dashboard); "owner" = System/Settings,
   * never a configurable permission, gated by isOwner directly below. */
  module?: ModuleKey | "owner";
};

const groups: NavGroup[] = [
  {
    title: "Overview",
    items: [{ path: "/", label: "Dashboard", icon: LayoutDashboard, key: "1" }],
  },
  {
    title: "Master Data",
    module: "masterData",
    items: [
      { path: "/parties", label: "Parties", icon: Users, key: "2" },
      { path: "/items", label: "Items", icon: Package, key: "3" },
      { path: "/inventory", label: "Inventory", icon: Boxes },
    ],
  },
  {
    title: "Sales",
    collapsible: true,
    defaultOpen: false,
    module: "sales",
    items: [
      { path: "/sales", label: "Sales", icon: ShoppingCart, key: "4" },
      { path: "/sale-return", label: "Sale Return", icon: CornerDownLeft },
    ],
  },
  {
    title: "Purchase & Expenses",
    collapsible: true,
    defaultOpen: false,
    module: "purchaseExpenses",
    items: [
      { path: "/purchase", label: "Purchase", icon: Truck, key: "5" },
      { path: "/purchase-return", label: "Purchase Return", icon: CornerUpLeft },
      { path: "/expenses", label: "Expenses", icon: Receipt, key: "6" },
      { path: "/payees", label: "Expense Payees", icon: UserSquare2 },
    ],
  },
  // {
  //   title: "Payments",
  //   collapsible: true,
  //   defaultOpen: false,
  //   items: [],
  // },
  {
    title: "Cash & Bank",
    module: "cashBank",
    items: [
      { path: "/bank", label: "Bank Accounts", icon: Landmark },
      { path: "/cash", label: "Cash on Hand", icon: Banknote },
      { path: "/payments", label: "Payments", icon: Wallet },
    ],
  },
  {
    title: "Reports",
    module: "reports",
    items: [
      { path: "/reports", label: "Reports", icon: BarChart3, key: "7" },
      { path: "/daybook", label: "Daybook", icon: BookOpen },
      { path: "/gst", label: "GST Returns", icon: FileText },
    ],
  },
  {
    title: "System",
    module: "owner",
    items: [{ path: "/settings", label: "Settings", icon: Settings, key: "8" }],
  },
];

// Plain startsWith("/purchase") also matches "/purchase-return" — require a
// "/" boundary after the prefix so sibling routes with a shared prefix
// (purchase vs. purchase-return, sale vs. sale-return) don't both light up.
const matchesPath = (pathname: string, path: string) =>
  path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`);

export function Sidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const collapsed = useWorkspace((s) => s.sidebarCollapsed);
  const toggle = useWorkspace((s) => s.toggleSidebar);
  const mobileNavOpen = useWorkspace((s) => s.mobileNavOpen);
  const setMobileNavOpen = useWorkspace((s) => s.setMobileNavOpen);
  const { isOwner, canView } = usePermissions();

  const visibleGroups = groups.filter((g) => {
    if (!g.module) return true; // Overview/Dashboard — always visible
    if (isOwner) return true;
    if (g.module === "owner") return false; // System/Settings — owner only
    return canView(g.module);
  });

  const initOpen: Record<string, boolean> = {};
  groups.forEach((g) => {
    if (g.collapsible) initOpen[g.title] = g.defaultOpen ?? false;
  });
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(initOpen);

  const toggleGroup = (title: string) =>
    setOpenGroups((prev) => ({ ...prev, [title]: !prev[title] }));

  // Auto-expand group if the active route belongs to it
  const isGroupActive = (g: NavGroup) => g.items.some((it) => matchesPath(pathname, it.path));

  return (
    <>
      {/* Backdrop — mobile drawer only, tapping it closes the menu */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-60 border-r bg-sidebar text-sidebar-foreground flex flex-col transition-transform duration-200",
          "md:relative md:z-auto md:translate-x-0 md:transition-[width]",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full",
          collapsed && "md:w-14",
        )}
      >
        {/* Brand — installed on the home screen (standalone mode), iOS
            draws the status bar translucent right over the page instead of
            pushing it down, and this drawer spans the full viewport height
            (fixed inset-y-0), so without this top padding for the
            notch/status-bar's safe area, the logo renders partly hidden
            underneath it, same issue Topbar.tsx had before its own fix. */}
        <div
          className="bg-sidebar border-b border-sidebar-border shrink-0"
          style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
        >
          <div className="h-14 flex items-center gap-2.5 px-3">
            <div className="h-8 w-8 rounded-md bg-primary-soft text-primary flex items-center justify-center ring-1 ring-primary/10 shrink-0">
              <Sparkles className="h-4 w-4" />
            </div>
            {!collapsed && (
              <div className="flex flex-col leading-tight overflow-hidden">
                <span className="font-bold tracking-tight text-[15px] text-sidebar-foreground">
                  {APP_NAME}
                </span>
                <span className="text-[10px] uppercase tracking-widest text-sidebar-muted">
                  Billing · Inventory
                </span>
              </div>
            )}
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2 text-[13px]">
          {visibleGroups.map((g) => {
            const active = isGroupActive(g);
            const isOpen = g.collapsible ? openGroups[g.title] || active : true;

            return (
              <div key={g.title} className="mb-1">
                {!collapsed &&
                  (g.collapsible ? (
                    <button
                      onClick={() => toggleGroup(g.title)}
                      className={cn(
                        "w-full flex items-center justify-between px-4 pt-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors",
                        active
                          ? "text-primary"
                          : "text-sidebar-muted hover:text-sidebar-foreground",
                      )}
                    >
                      <span>{g.title}</span>
                      {isOpen && !active ? (
                        <ChevronDown className="h-3 w-3 opacity-60" />
                      ) : (
                        <ChevronRight className="h-3 w-3 opacity-60" />
                      )}
                    </button>
                  ) : (
                    <div className="px-4 pt-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-sidebar-muted">
                      {g.title}
                    </div>
                  ))}
                {collapsed && <div className="mx-3 my-1.5 border-t border-sidebar-border" />}

                {(collapsed || isOpen) &&
                  g.items.map((it) => {
                    const itemActive = matchesPath(pathname, it.path);
                    const Icon = it.icon;
                    return (
                      <Link
                        key={it.path}
                        to={it.path}
                        onClick={() => setMobileNavOpen(false)}
                        title={collapsed ? it.label : undefined}
                        className={cn(
                          "group flex items-center gap-2.5 py-2 border-l-[3px] border-transparent transition-colors",
                          collapsed ? "px-3 justify-center" : "px-4",
                          "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                          itemActive &&
                            "bg-sidebar-accent text-sidebar-accent-foreground border-primary font-semibold",
                        )}
                      >
                        <Icon
                          className={cn(
                            "h-4 w-4 shrink-0",
                            itemActive ? "opacity-100" : "opacity-70 group-hover:opacity-100",
                          )}
                        />
                        {!collapsed && <span className="flex-1 truncate">{it.label}</span>}
                      </Link>
                    );
                  })}
              </div>
            );
          })}
        </nav>

        {/* Logout — mobile drawer only; desktop keeps it in the Topbar. The
            home-indicator safe-area inset is padding on this wrapping div,
            not the button itself — padding inside the button pushed its
            centered icon/label up and left a tall dead strip underneath on
            phones with a tall safe area. The button now keeps a fixed,
            comfortable height with its content centered inside it. */}
        <div
          className="md:hidden shrink-0 border-t border-sidebar-border"
          style={{ paddingBottom: "min(env(safe-area-inset-bottom, 0px), 10px)" }}
        >
          <button
            onClick={async () => {
              if (!confirm(`Logout from ${APP_NAME}?`)) return;
              try {
                stopRepos();
                await signOut(auth);
              } catch {
                toast.error("Logout failed — check your connection");
              }
            }}
            className="w-full h-12 flex items-center justify-center gap-2 text-[13px] font-semibold text-rose-500 hover:bg-rose-50 transition"
          >
            <LogOut className="h-4 w-4" /> Logout
          </button>
        </div>

        <button
          onClick={toggle}
          className="hidden md:flex border-t border-sidebar-border h-10 items-center justify-center gap-2 text-[11px] text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4" />
          ) : (
            <>
              <ChevronsLeft className="h-4 w-4" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </aside>
    </>
  );
}

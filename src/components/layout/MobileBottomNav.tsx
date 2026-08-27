import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { LayoutDashboard, Package, Plus, Truck, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/hooks/usePermissions";

/**
 * Mobile-only bottom tab bar (hidden at md: and up, where the sidebar is
 * docked) — the single biggest thing that makes a responsive website start
 * feeling like a native billing app: thumb-reachable primary actions instead
 * of a hamburger menu for everything. No separate "More" tab here — the
 * header's own hamburger icon already opens the full nav drawer, so a
 * second one down here would just be a duplicate.
 *
 * A second, independent nav surface from the desktop Sidebar — its tabs need
 * the same permission filtering, or a restricted mobile user gets tap
 * targets into modules the desktop sidebar would have hidden.
 */
export function MobileBottomNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const { isOwner, canView, canEdit } = usePermissions();

  // Plain startsWith would also match a sibling route sharing the same
  // prefix (e.g. "/sales" matching "/sale-return") — require a "/" boundary.
  const isActive = (p: string) =>
    p === "/" ? pathname === "/" : pathname === p || pathname.startsWith(`${p}/`);

  const tabClass = (active: boolean) =>
    cn(
      "flex-1 flex flex-col items-center justify-center gap-0.5 py-1.5 transition-colors",
      active ? "text-primary" : "text-gray-400",
    );

  return (
    // Installed on the home screen (standalone mode), phones with a home
    // indicator (iPhone X and later) need clearance below the tab bar —
    // otherwise the icons/labels sit right against the gesture area, making
    // the bottom row easy to mis-tap. Height and (trimmed) safe-area
    // clearance both come from the :root variables in styles.css, shared
    // with AppShell's content padding so the two can never drift apart. The
    // clearance goes on the outer nav (so its background still fills to the
    // screen edge); the tab row keeps a fixed height inside it so the
    // icons/labels don't get squeezed by that padding.
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-gray-200"
      style={{ boxShadow: "0 -2px 10px rgba(0,0,0,0.06)", paddingBottom: "var(--mobile-nav-safe)" }}
    >
      <div className="flex items-stretch h-[var(--mobile-nav-height)]">
        <Link to="/" className={tabClass(isActive("/"))}>
          <LayoutDashboard className="h-5 w-5" />
          <span className="text-[10px] font-semibold">Home</span>
        </Link>
        {(isOwner || canView("masterData")) && (
          <Link to="/items" className={tabClass(isActive("/items"))}>
            <Package className="h-5 w-5" />
            <span className="text-[10px] font-semibold">Items</span>
          </Link>
        )}

        {/* Center FAB — the single most common action (billing a sale) always one tap away */}
        {(isOwner || canEdit("sales")) && (
          <div className="flex-1 flex items-start justify-center">
            <button
              onClick={() => navigate({ to: "/sales/new" })}
              className="-mt-4 h-12 w-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg ring-4 ring-white active:scale-95 transition-transform"
              title="Add Sale"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>
        )}

        {(isOwner || canView("purchaseExpenses")) && (
          <Link to="/purchase" className={tabClass(isActive("/purchase"))}>
            <Truck className="h-5 w-5" />
            <span className="text-[10px] font-semibold">Purchase</span>
          </Link>
        )}
        {(isOwner || canView("masterData")) && (
          <Link to="/parties" className={tabClass(isActive("/parties"))}>
            <Users className="h-5 w-5" />
            <span className="text-[10px] font-semibold">Parties</span>
          </Link>
        )}
      </div>
    </nav>
  );
}

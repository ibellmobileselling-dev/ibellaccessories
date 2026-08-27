import { Search, Plus, Menu, LogOut } from "lucide-react";
import { APP_NAME } from "@/lib/version";
import { useWorkspace } from "@/store/workspace";
import { useNavigate } from "@tanstack/react-router";
import { CompanyRepo, stopRepos } from "@/repositories";
import { useRepoMemo } from "@/hooks/useRepoData";
import { signOut } from "firebase/auth";
import { auth, isBrowser } from "@/lib/firebase";
import { toast } from "sonner";

export function Topbar() {
  const { setGlobalSearch, toggleMobileNav } = useWorkspace();
  const navigate = useNavigate();
  // Company settings now live in the reactive repo store, so this reads
  // straight through instead of polling every 2 seconds forever.
  const company = useRepoMemo(() => CompanyRepo.get());
  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  return (
    // Installed on the home screen (standalone mode), iOS draws the status
    // bar translucent right over the page instead of pushing it down — so
    // without this top padding for the notch/status-bar's safe area, the
    // header (menu button included) renders partly underneath it: only the
    // bottom sliver peeks out below the status bar, out of reach of taps.
    <div
      className="bg-card border-b border-border shrink-0"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <header className="h-14 text-foreground grid grid-cols-[auto_1fr_auto] md:flex items-center px-3 md:px-4 gap-2 md:gap-3">
        <button
          onClick={toggleMobileNav}
          className="md:hidden h-8 w-8 rounded-md hover:bg-accent flex items-center justify-center text-muted-foreground"
          title="Toggle menu"
        >
          <Menu className="h-4 w-4" />
        </button>

        {/* Full search bar — desktop only. Every list page already has its
          own page-specific search box right below the header, so a second
          generic search bar up here was redundant clutter on mobile. */}
        <button
          onClick={() => setGlobalSearch(true)}
          className="hidden md:flex flex-1 min-w-0 max-w-xl items-center gap-2 h-8 px-3.5 rounded-md bg-muted hover:bg-accent text-muted-foreground transition-colors ring-1 ring-border"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left text-sm truncate">Search customer, item, invoice…</span>
        </button>

        {/* Mobile — company name sits centered in the one header row,
          between the menu icon and the search/Sale actions. */}
        <span className="md:hidden text-center text-[13px] font-semibold text-foreground truncate px-2">
          {company.name}
        </span>

        <div className="hidden md:block flex-1" />

        {/* Mobile — compact search icon (opens the same global search
          overlay), on the right of the single row. The bottom nav's FAB is
          now the one and only "Add Sale" entry point on mobile, so a second
          Sale button up here was redundant clutter. */}
        <div className="md:hidden flex items-center gap-1.5 justify-self-end">
          <button
            onClick={() => setGlobalSearch(true)}
            className="h-8 w-8 rounded-md hover:bg-accent flex items-center justify-center text-muted-foreground shrink-0"
            title="Search"
          >
            <Search className="h-4 w-4" />
          </button>
        </div>

        {/* Primary actions — desktop only. Add Sale is the one saturated
          accent in an otherwise neutral bar, so it stays the obvious place
          to click instead of competing with a bold background. */}
        <button
          onClick={() => navigate({ to: "/sales/new" })}
          className="hidden md:flex h-8 px-4 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 font-semibold text-sm items-center gap-1.5 shadow-sm transition"
        >
          <Plus className="h-4 w-4" /> Add Sale
        </button>
        {/* Purchase entry is secondary on mobile — reachable via the bottom
          nav's "More" drawer — so it doesn't compete for space here. */}
        <button
          onClick={() => navigate({ to: "/purchase/new" })}
          className="hidden md:flex h-8 px-3 md:px-4 rounded-md border border-input bg-background hover:bg-accent text-foreground font-semibold text-sm items-center gap-1.5 transition"
        >
          <Plus className="h-4 w-4" /> Add Purchase
        </button>

        <div className="hidden lg:block h-6 w-px bg-border mx-1" />
        <span className="hidden lg:inline text-[11px] text-muted-foreground tabular-nums">
          {today}
        </span>

        {/* Logout — desktop only. On mobile it lives in the sidebar drawer.
          The company pill that used to sit here is gone: it spent header
          width restating something that doesn't change, and Settings is
          already one click away in the sidebar. */}
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
          className="hidden md:flex h-8 w-8 rounded-full hover:bg-accent text-muted-foreground hover:text-destructive items-center justify-center transition"
          title={`Logout${isBrowser && auth.currentUser?.email ? ` (${auth.currentUser.email})` : ""}`}
        >
          <LogOut className="h-4 w-4" />
        </button>
      </header>
    </div>
  );
}

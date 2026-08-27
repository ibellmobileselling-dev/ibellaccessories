import { type ReactNode, useEffect, useRef } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { MobileBottomNav } from "./MobileBottomNav";
import { GlobalSearch } from "@/components/GlobalSearch";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";

export function AppShell({ children }: { children: ReactNode }) {
  useGlobalShortcuts();
  const mainRef = useRef<HTMLElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // `<main>` below — not the browser window — is this app's real scrollable
  // area (it stays mounted across every route change, only its children
  // swap), and TanStack Router's scrollRestoration only tracks window
  // scroll by default. Without this, opening any page while scrolled down
  // on the previous one carried that same scroll offset straight into the
  // new page, cutting off its own header/top content.
  //
  // Most pages also have their OWN inner scrolling region (the repeated
  // `flex-1 overflow-auto` pattern used app-wide for a page's own list/
  // content area, separate from this outer `<main>`) — that's the element
  // that's actually scrolling on many pages, not `<main>` itself, which
  // often exactly fits its child and never scrolls at all. Rather than
  // wiring a reset into every individual page, this walks the freshly
  // rendered page for anything using that same overflow-auto convention and
  // resets it too, so this fix genuinely covers every page from one place.
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    main.scrollTo(0, 0);
    main
      .querySelectorAll<HTMLElement>('[class*="overflow-auto"], [class*="overflow-y-auto"]')
      .forEach((el) => {
        el.scrollTop = 0;
      });
  }, [pathname]);

  return (
    <div className="h-dvh w-screen flex bg-background text-foreground overflow-hidden overscroll-none">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar />
        <WorkspaceTabs />
        <main
          ref={mainRef}
          className="flex-1 overflow-auto overscroll-contain bg-[#f5f6fa] pb-[calc(var(--mobile-nav-height)+var(--mobile-nav-safe))] md:pb-0"
        >
          {children}
        </main>
      </div>
      <MobileBottomNav />
      <GlobalSearch />
    </div>
  );
}

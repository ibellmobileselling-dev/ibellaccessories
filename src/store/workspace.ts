import { create } from "zustand";

export interface Tab {
  id: string;
  title: string;
  path: string;
}

interface WorkspaceState {
  tabs: Tab[];
  activeId: string | null;
  openTab: (tab: Tab) => void;
  closeTab: (id: string) => void;
  /** Close a tab and say where to go next.
   *
   * Returns the path the app should navigate to, or null when the closed tab
   * was not the one on screen and the current page should stay put. The rule
   * for "next" is Chrome's: whichever tab now sits in the closed one's slot,
   * falling back to the new last tab when the closed one was rightmost —
   * never just "the last tab in the strip", which teleports you across the
   * others.
   *
   * It lives in the store because both the tab's × and the Escape key close
   * tabs, and two copies of this rule would drift. */
  closeTabAndNext: (id: string, currentPath: string) => string | null;
  setActive: (id: string) => void;
  globalSearchOpen: boolean;
  setGlobalSearch: (v: boolean) => void;
  quickAddOpen: null | "sale" | "purchase";
  setQuickAdd: (v: null | "sale" | "purchase") => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  /** Off-canvas drawer state on mobile — separate from `sidebarCollapsed`
   * (the desktop icon-only mode) since the two are mutually irrelevant: a
   * phone never shows the collapse button, and a laptop never opens a
   * drawer. */
  mobileNavOpen: boolean;
  setMobileNavOpen: (v: boolean) => void;
  toggleMobileNav: () => void;
}

const SIDEBAR_KEY = "bz.sidebarCollapsed";
const initialCollapsed = (() => {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
})();

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  tabs: [],
  activeId: null,
  globalSearchOpen: false,
  quickAddOpen: null,
  sidebarCollapsed: initialCollapsed,
  openTab: (tab) => {
    const exists = get().tabs.find((t) => t.id === tab.id);
    if (exists) {
      set({ activeId: tab.id });
    } else {
      set({ tabs: [...get().tabs, tab], activeId: tab.id });
    }
  },
  closeTab: (id) => {
    const tabs = get().tabs.filter((t) => t.id !== id);
    const activeId = get().activeId === id ? (tabs[tabs.length - 1]?.id ?? null) : get().activeId;
    set({ tabs, activeId });
  },
  closeTabAndNext: (id, currentPath) => {
    const { tabs, activeId } = get();
    const closedIndex = tabs.findIndex((t) => t.id === id);
    if (closedIndex < 0) return null;
    const closed = tabs[closedIndex];
    const wasActive = closed.path === currentPath || activeId === id;
    const remaining = tabs.filter((t) => t.id !== id);
    const next = remaining[Math.min(closedIndex, remaining.length - 1)] ?? null;
    set({ tabs: remaining, activeId: wasActive ? (next?.id ?? null) : activeId });
    return wasActive ? (next?.path ?? "/") : null;
  },
  setActive: (id) => set({ activeId: id }),
  setGlobalSearch: (v) => set({ globalSearchOpen: v }),
  setQuickAdd: (v) => set({ quickAddOpen: v }),
  toggleSidebar: () => {
    const v = !get().sidebarCollapsed;
    set({ sidebarCollapsed: v });
    try {
      localStorage.setItem(SIDEBAR_KEY, v ? "1" : "0");
    } catch {
      // Private browsing blocks localStorage — the sidebar just won't
      // remember its state, which is not worth failing the click over.
    }
  },
  setSidebarCollapsed: (v) => {
    set({ sidebarCollapsed: v });
    try {
      localStorage.setItem(SIDEBAR_KEY, v ? "1" : "0");
    } catch {
      // See toggleSidebar above.
    }
  },
  mobileNavOpen: false,
  setMobileNavOpen: (v) => set({ mobileNavOpen: v }),
  toggleMobileNav: () => set({ mobileNavOpen: !get().mobileNavOpen }),
}));

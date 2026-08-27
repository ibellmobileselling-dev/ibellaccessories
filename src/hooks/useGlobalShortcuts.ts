import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useWorkspace } from "@/store/workspace";

const paths = [
  "/",
  "/parties",
  "/items",
  "/sales",
  "/purchase",
  "/expenses",
  "/reports",
  "/settings",
];

export function useGlobalShortcuts() {
  const navigate = useNavigate();
  const { setGlobalSearch, setQuickAdd } = useWorkspace();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Never hijack these while the user is typing — Ctrl+N/Ctrl+P/Alt+1..8
      // navigate away, which would silently discard an unsaved form (e.g. an
      // in-progress invoice) with no confirmation.
      const el = e.target as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable);
      if (typing) return;

      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setGlobalSearch(true);
        return;
      }
      if (ctrl && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setQuickAdd("sale");
        navigate({ to: "/sales/new" });
        return;
      }
      if (ctrl && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setQuickAdd("purchase");
        navigate({ to: "/purchase/new" });
        return;
      }
      if (e.altKey && /^[1-8]$/.test(e.key)) {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 1;
        navigate({ to: paths[idx] });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate, setGlobalSearch, setQuickAdd]);
}

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { APP_NAME } from "@/lib/version";
import {
  Outlet,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  useNavigate,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { Sparkles, Loader2, AlertCircle, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import {
  isModuleLoadError,
  reloadOnceForChunkError,
  installChunkErrorAutoReload,
} from "@/lib/chunk-reload";
import { AppShell } from "@/components/layout/AppShell";
import { auth, isBrowser, isProductionData, DATABASE_ID } from "@/lib/firebase";
import {
  hydrateRepos,
  whenReposHydrated,
  migrateFromLocalStorage,
  stopRepos,
  TeamUserRepo,
} from "@/repositories";
import { usePermissions } from "@/hooks/usePermissions";
import { useAppEscape } from "@/hooks/useGoBack";
import type { ModuleKey } from "@/types";
import { LoginPage } from "./login";

/** Same modules as the Sidebar's own groupings — one central place decides
 * whether the current route is even reachable, instead of every one of the
 * ~15 route files needing its own check. Settings isn't listed here: it's
 * gated by isOwner directly below, never by a configurable permission. */
const PATH_MODULE: Record<string, ModuleKey> = {
  "/parties": "masterData",
  "/items": "masterData",
  "/inventory": "masterData",
  "/sales": "sales",
  "/sale-return": "sales",
  "/purchase": "purchaseExpenses",
  "/purchase-return": "purchaseExpenses",
  "/expenses": "purchaseExpenses",
  "/payees": "purchaseExpenses",
  "/bank": "cashBank",
  "/cash": "cashBank",
  "/payments": "cashBank",
  "/reports": "reports",
  "/daybook": "reports",
  "/gst": "reports",
};

function moduleForPath(pathname: string): ModuleKey | null {
  for (const [path, module] of Object.entries(PATH_MODULE)) {
    if (pathname === path || pathname.startsWith(`${path}/`)) return module;
  }
  return null;
}

/** Create/edit forms need `edit`, not just `view` — a view-only team member
 * could otherwise type /sales/new or /purchase/edit/<id> straight into the
 * URL bar and fully create or edit bills, completely bypassing the
 * correctly-gated buttons on the list pages (which only hide the button,
 * they don't stop direct navigation). Checked separately from moduleForPath
 * above since most of that map's routes only ever need `view`. */
const EDIT_ONLY_PATHS: { re: RegExp; module: ModuleKey }[] = [
  { re: /^\/sales\/new$/, module: "sales" },
  { re: /^\/sales\/edit\/[^/]+$/, module: "sales" },
  { re: /^\/purchase\/new$/, module: "purchaseExpenses" },
  { re: /^\/purchase\/edit\/[^/]+$/, module: "purchaseExpenses" },
  { re: /^\/sale-return\/new$/, module: "sales" },
  { re: /^\/purchase-return\/new$/, module: "purchaseExpenses" },
];

function editModuleForPath(pathname: string): ModuleKey | null {
  for (const { re, module } of EDIT_ONLY_PATHS) {
    if (re.test(pathname)) return module;
  }
  return null;
}

/** Remembers whether someone was signed in on this device, so the very first
 * paint can go straight to the right screen (login vs splash) with no blink. */
const AUTH_HINT_KEY = "bz.authHint";

function NotFoundComponent() {
  return (
    <div className="flex items-center justify-center h-full min-h-[60vh]">
      <div className="text-center">
        <h1 className="text-4xl font-bold">404</h1>
        <p className="text-muted-foreground">Page not found</p>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  // A stale-chunk error after a deploy is a browser-cache problem, not a real
  // app failure — auto-reload once to pull the fresh HTML + new chunks so the
  // user never even sees this screen. (Guarded so a truly broken deploy can't
  // loop.) Only if the reload is on cooldown do we fall through to the UI.
  const chunkError = isModuleLoadError(error);
  useEffect(() => {
    reportLovableError(error, { boundary: "root" });
    if (chunkError) reloadOnceForChunkError();
  }, [error, chunkError]);

  if (chunkError) {
    // Reload is in flight (or was just attempted) — show a neutral "updating"
    // state instead of a scary error, since this self-heals.
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="max-w-md text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
          <p className="mt-3 text-sm text-muted-foreground">Updating to the latest version…</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm"
          >
            Reload now
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">This page didn't load</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="mt-4 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover",
      },
      { title: `${APP_NAME} — Billing & Inventory ERP` },
      {
        name: "description",
        content: "Keyboard-first desktop billing, inventory, and accounting software.",
      },
      { property: "og:title", content: `${APP_NAME} — Billing & Inventory ERP` },
      {
        property: "og:description",
        content: "Keyboard-first desktop billing, inventory, and accounting software.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      // Without these, "Add to Home Screen" on iOS falls back to Safari's own
      // undocumented default for un-tagged bookmarks — which isn't guaranteed
      // consistent across iOS versions/devices (exactly the iPhone 13 Pro vs.
      // 17 Pro Max difference). These make standalone (no Safari chrome) the
      // explicit, declared behavior instead of a guess.
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "apple-mobile-web-app-title", content: APP_NAME },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "theme-color", content: "#0f172a" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon", sizes: "48x48" },
      // iOS does not reliably rasterize SVG for apple-touch-icon (unlike the
      // regular favicon above) — it wants a real PNG, ideally 180x180. Until
      // a proper PNG is added, this SVG is at least a functional fallback,
      // but the home-screen icon may not render as crisply as it should.
      { rel: "apple-touch-icon", href: "/favicon.svg" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  // One Escape rule for the whole app — see useAppEscape for the order of
  // who gets the key.
  useAppEscape();
  // Self-heal chunk import failures that happen during navigation (outside the
  // error boundary) — e.g. a deploy landed while the tab was open.
  useEffect(() => {
    installChunkErrorAutoReload();
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <TestDataBanner />
      <AuthGate />
      <Toaster position="bottom-right" duration={3000} closeButton richColors />
    </QueryClientProvider>
  );
}

/**
 * A strip across the top of every screen when this is not the shop's real
 * books.
 *
 * Two deployments of the same app look identical, and the person in front of
 * them is a shopkeeper part-way through a sale, not someone who reads the URL
 * bar. Without this, a real day's takings gets typed into a test site — and
 * the mistake is only found when the real books turn out to be short.
 */
export function TestDataBanner() {
  if (isProductionData) return null;
  return (
    <div
      role="status"
      className="fixed top-0 inset-x-0 z-[60] bg-amber-500 text-amber-950 text-[11px] font-bold uppercase tracking-wide text-center py-0.5 pointer-events-none"
    >
      Test data — not the shop's real books ({DATABASE_ID})
    </div>
  );
}

/**
 * Auth + data gate:
 *  - undefined user → checking session (splash)
 *  - no user → only /login is allowed
 *  - user → hydrate all cloud data (and one-time migrate old localStorage
 *    data) BEFORE rendering the app, since screens read repos synchronously.
 */
function AuthGate() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [dataReady, setDataReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [mounted, setMounted] = useState(false);
  const { isOwner, canView, canEdit } = usePermissions();

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isBrowser) return;
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      try {
        if (u) localStorage.setItem(AUTH_HINT_KEY, "1");
        else localStorage.removeItem(AUTH_HINT_KEY);
      } catch {
        /* private mode */
      }
      if (!u) {
        stopRepos();
        setDataReady(false);
      }
    });
  }, []);

  useEffect(() => {
    if (!user || dataReady) return;
    let cancelled = false;
    (async () => {
      try {
        // Resolves as soon as permissions + company are known and every
        // collection's live listener has been STARTED (not finished). The app
        // opens now; each screen fills in live as its data arrives.
        await hydrateRepos(user.uid, user.email ?? "");
        if (!cancelled) setDataReady(true);

        // Legacy localStorage → cloud migration only ever applies to the
        // owner's own original device/browser — a freshly created team
        // member's browser has no old data to migrate, and its repos are only
        // partially hydrated by design (permission-scoped). Run it in the
        // background AFTER all collections have loaded, since the "is the cloud
        // already populated?" guard is only meaningful once data is present —
        // running it early could wrongly re-upload localStorage as duplicates.
        if (TeamUserRepo.current()?.isOwner) {
          whenReposHydrated()
            .then(() => migrateFromLocalStorage())
            .then((migrated) => {
              if (migrated > 0 && !cancelled)
                toast.success(`Moved ${migrated} records from this device to cloud`);
            })
            .catch((err) => console.error("Background migration failed", err));
        }
      } catch (err) {
        console.error("Data load failed", err);
        if (!cancelled)
          setLoadError(
            "Could not load your data from the cloud. Check your internet connection " +
              "and that Firestore security rules allow signed-in access, then reload.",
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, dataReady]);

  useEffect(() => {
    if (user === undefined) return;
    if (!user && pathname !== "/login") navigate({ to: "/login" });
    if (user && pathname === "/login") navigate({ to: "/" });
  }, [user, pathname, navigate]);

  // SSR + first client paint: neutral splash (avoids hydration mismatch)
  if (!mounted) return <SplashScreen />;

  const wasSignedIn = (() => {
    try {
      return localStorage.getItem(AUTH_HINT_KEY) === "1";
    } catch {
      return false;
    }
  })();

  // Login page renders without the app shell
  if (pathname === "/login") {
    if (user) return <SplashScreen />; // already signed in — redirecting to dashboard
    return <Outlet />;
  }

  // Signed out (or almost certainly signed out while the session check runs):
  // render the login page immediately — no dashboard/splash blink.
  if (user === null || (user === undefined && !wasSignedIn)) {
    return <LoginPage />;
  }

  if (loadError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="max-w-md text-center">
          <AlertCircle className="h-10 w-10 text-destructive mx-auto mb-3" />
          <h1 className="text-lg font-semibold">Couldn't load your data</h1>
          <p className="mt-2 text-sm text-muted-foreground">{loadError}</p>
          <button
            onClick={() => location.reload()}
            className="mt-4 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }

  if (user === undefined || !dataReady) return <SplashScreen />;

  // One central gate instead of a check in each of the ~15 route files.
  // Dashboard ("/") has no module — any active signed-in user can see it.
  // Settings is never a configurable permission, owner-only always, so a
  // staff member editing their own permissions can never grant themselves
  // broader access through it.
  const isSettingsPath = pathname === "/settings" || pathname.startsWith("/settings/");
  const module = moduleForPath(pathname);
  const editModule = editModuleForPath(pathname);
  const blocked =
    !isOwner &&
    (isSettingsPath ||
      (module !== null && !canView(module)) ||
      (editModule !== null && !canEdit(editModule)));

  return <AppShell>{blocked ? <AccessRestricted /> : <Outlet />}</AppShell>;
}

function AccessRestricted() {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[60vh] text-center px-4">
      <ShieldAlert className="h-12 w-12 text-muted-foreground mb-3" />
      <h1 className="text-lg font-semibold">Access restricted</h1>
      <p className="mt-1.5 text-sm text-muted-foreground max-w-sm">
        You don't have permission to view this section. Contact your administrator if you need
        access.
      </p>
    </div>
  );
}

function SplashScreen() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-4">
      <div className="h-14 w-14 rounded-2xl bg-gradient-brand text-brand-foreground flex items-center justify-center shadow-elevated">
        <Sparkles className="h-6 w-6" />
      </div>
      <div className="text-center">
        <p className="font-bold tracking-tight text-[18px]">{APP_NAME}</p>
        <p className="text-[12px] text-muted-foreground flex items-center gap-1.5 justify-center mt-1">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading your workspace…
        </p>
      </div>
    </div>
  );
}

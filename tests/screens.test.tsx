/**
 * Screen render tests — run in a real browser (see tests/run-screens.cjs).
 *
 * audit.test.ts proves the MATH. This proves the SCREENS: that every page
 * actually renders seeded data, and that the numbers which reach the DOM are
 * the ones the ledger says they should be.
 *
 * It exists because the v50 refactor moved every repo-derived `useMemo` in
 * these pages onto `useRepoMemo`, and nothing but tsc was exercising them —
 * a blank page, or a stale zero, would have shipped unseen.
 *
 * Why a browser and not renderToString: most list screens load their rows in
 * a `useEffect`, which server rendering never runs, so they would all render
 * empty and the test would prove nothing. Mounting for real with createRoot
 * runs effects, which is exactly the code path being verified.
 *
 * Safety: `@/lib/firebase` is aliased to tests/stubs/firebase (isBrowser =
 * false), so the repositories are pure in-memory caches here and there is no
 * code path to the live database.
 */
import { createRoot, type Root } from "react-dom/client";
import { act, type ReactNode } from "react";
import { createRouter, createMemoryHistory, RouterProvider, Outlet } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "@/routeTree.gen";
import { BulkUpdateItemsDialog } from "@/components/BulkUpdateItemsDialog";
import { PrintablePartyStatement } from "@/components/PrintablePartyStatement";
import { CashBankTransferDialog } from "@/components/CashBankTransferDialog";
import { TestDataBanner } from "@/routes/__root";
import { PartyDialog } from "@/routes/parties";
import { DataTable } from "@/components/DataTable";
import { PrintableInvoice } from "@/components/PrintableInvoice";
import { PrintableReturn } from "@/components/PrintableReturn";
import { fmtMoney, today, ymd } from "@/lib/format";
import { planStockRepair } from "@/lib/dataRepair";
import { useEscapeToLeave } from "@/hooks/useFormKeys";
import { useAppEscape } from "@/hooks/useGoBack";
import { useWorkspace } from "@/store/workspace";
import { buildPartyStatement, cashFlows } from "@/lib/ledger";
import { commitBatch } from "@/repositories/base";
import {
  PartyRepo,
  ItemRepo,
  SalesRepo,
  PurchaseRepo,
  SaleReturnRepo,
  ExpenseRepo,
  PayeeRepo,
  BankRepo,
  LedgerEntryRepo,
  BankTxnRepo,
  PaymentRepo,
  CompanyRepo,
  StockAdjustmentRepo,
  PurchaseReturnRepo,
  CashAdjustmentRepo,
} from "@/repositories";

export interface Results {
  passed: number;
  failed: number;
  fails: string[];
}

const R: Results = { passed: 0, failed: 0, fails: [] };
const r2 = (n: number) => Math.round(n * 100) / 100;
function assert(cond: boolean, msg: string) {
  if (cond) R.passed++;
  else {
    R.failed++;
    R.fails.push(msg);
  }
}
/** Assert a rendered page contains a value, naming what was missing. */
function has(text: string, needle: string, label: string) {
  assert(text.includes(needle), `${label} — expected to find ${JSON.stringify(needle)}`);
}

/** Type into a controlled React input the way a person does — React listens
 * for the native `input` event, and setting `.value` alone never fires it. */
function setInput(el: HTMLInputElement | null | undefined, value: string) {
  // A missing control used to surface as "Illegal invocation" from deep in
  // the value setter, which says nothing about which control was missing.
  if (!el) throw new Error(`setInput: the control to type "${value}" into is not on screen`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The bulk-update grid row whose first cell holds this item name, as its
 * list of inputs: [name, ...the current tab's fields]. Returns null when the
 * row is not mounted — which the windowed list makes a normal state. */
function gridRow(name: string): HTMLInputElement[] | null {
  for (const table of Array.from(document.querySelectorAll("table"))) {
    for (const tr of Array.from(table.querySelectorAll("tbody tr"))) {
      const inputs = Array.from(tr.querySelectorAll("input")) as HTMLInputElement[];
      if (inputs.length && inputs[0].value === name) return inputs;
    }
  }
  return null;
}

/** The dialog under test: the LAST one in the document.
 *
 * Routes and dialogs mounted by earlier blocks are never torn down, and they
 * portal into document.body, so a bare document.querySelector('[role="dialog"]')
 * happily returns something another test opened. Portals append, so the newest
 * is last. */
function currentDialog(): Element {
  const all = document.querySelectorAll('[role="dialog"]');
  const el = all[all.length - 1];
  if (!el) throw new Error("currentDialog: no dialog is open");
  return el;
}

function findButton(re: RegExp): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((b) =>
    re.test((b.textContent ?? "").trim()),
  ) as HTMLButtonElement | undefined;
}

/** Let React's effects, timers and rAF-coalesced scroll handlers settle. */
async function settleMs(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

// Dates inside the CURRENT month, so the screens' default "this month"
// filters include them however long from now this test is run.
const now = new Date();
const inMonth = (day: number) =>
  ymd(new Date(now.getFullYear(), now.getMonth(), Math.min(day, now.getDate())));
const D2 = inMonth(2),
  D3 = inMonth(3),
  D4 = inMonth(4),
  D5 = inMonth(5);

/* ── A small but complete book ────────────────────────────────────────── */
function seed() {
  CompanyRepo.save({
    name: "IBELL MOBILE",
    currency: "INR",
    invoicePrefix: "INV-",
    purchasePrefix: "PUR-",
    enableGst: true,
    allowNegativeStock: true,
    expenseCategories: ["Rent"],
  } as never);

  PartyRepo.add({
    id: "P1",
    createdAt: "2026-01-01T00:00:00Z",
    name: "Ramesh Traders",
    type: "both",
    phone: "9876500001",
    openingBalance: 0,
  } as never);
  PartyRepo.add({
    id: "P2",
    createdAt: "2026-01-02T00:00:00Z",
    name: "Sunrise Supply",
    type: "both",
    phone: "9876500002",
    openingBalance: 0,
  } as never);

  ItemRepo.add({
    id: "I1",
    createdAt: "2026-01-01T00:00:00Z",
    name: "USB Cable",
    unit: "pcs",
    gstRate: 18,
    purchasePrice: 60,
    salePrice: 100,
    stock: 40,
    openingStock: 50,
    minStock: 5,
  } as never);
  ItemRepo.add({
    id: "I2",
    createdAt: "2026-01-01T00:00:00Z",
    name: "Phone Case",
    unit: "pcs",
    gstRate: 18,
    purchasePrice: 90,
    salePrice: 150,
    stock: 2,
    openingStock: 10,
    minStock: 5,
  } as never);

  BankRepo.add({
    id: "B1",
    createdAt: "2026-01-01T00:00:00Z",
    name: "HDFC Current",
    accountNumber: "1234",
    openingBalance: 10000,
    balance: 11400,
  } as never);

  // A 1000 sale with 400 of it settled at billing through bank B1.
  SalesRepo.add({
    id: "S1",
    createdAt: `${D2}T09:00:00Z`,
    number: "INV-0001",
    date: D2,
    partyId: "P1",
    partyName: "Ramesh Traders",
    partyPhone: "9876500001",
    gstEnabled: false,
    lineItems: [
      {
        id: "L1",
        itemId: "I1",
        name: "USB Cable",
        unit: "pcs",
        qty: 10,
        price: 100,
        discountPct: 0,
        gstRate: 0,
        costPrice: 60,
        amount: 1000,
      },
    ],
    subtotal: 1000,
    discount: 0,
    shippingCharge: 0,
    taxAmount: 0,
    total: 1000,
    paid: 400,
    paymentMode: "bank",
    bankId: "B1",
    bankPaidAmount: 400,
    notes: "",
  } as never);

  PurchaseRepo.add({
    id: "PU1",
    createdAt: `${D3}T09:00:00Z`,
    number: "PUR-0001",
    date: D3,
    partyId: "P2",
    partyName: "Sunrise Supply",
    gstEnabled: false,
    lineItems: [
      {
        id: "L2",
        itemId: "I2",
        name: "Phone Case",
        unit: "pcs",
        qty: 5,
        price: 90,
        discountPct: 0,
        gstRate: 0,
        amount: 450,
      },
    ],
    subtotal: 450,
    discount: 0,
    taxAmount: 0,
    total: 450,
    paid: 0,
    paymentMode: "credit",
    notes: "",
  } as never);

  SaleReturnRepo.add({
    id: "SR1",
    createdAt: `${D4}T09:00:00Z`,
    number: "CR-0001",
    date: D4,
    originalRef: "INV-0001",
    partyId: "P1",
    partyName: "Ramesh Traders",
    gstEnabled: false,
    lineItems: [
      {
        id: "L3",
        itemId: "I1",
        name: "USB Cable",
        unit: "pcs",
        qty: 1,
        price: 100,
        discountPct: 0,
        gstRate: 0,
        costPrice: 60,
        amount: 100,
      },
    ],
    subtotal: 100,
    taxAmount: 0,
    total: 100,
    notes: "",
  } as never);

  PaymentRepo.add({
    id: "PY1",
    createdAt: `${D5}T09:00:00Z`,
    date: D5,
    partyId: "P1",
    partyName: "Ramesh Traders",
    type: "in",
    amount: 300,
    mode: "cash",
  } as never);
  PayeeRepo.add({ id: "PE1", createdAt: "2026-01-01T00:00:00Z", name: "Landlord" } as never);
  ExpenseRepo.add({
    id: "E1",
    createdAt: `${D3}T09:00:00Z`,
    date: D3,
    category: "Rent",
    amount: 5000,
    paymentMode: "cash",
    payeeId: "PE1",
    payeeName: "Landlord",
  } as never);
  BankTxnRepo.add({
    id: "BT1",
    createdAt: `${D4}T09:00:00Z`,
    bankId: "B1",
    date: D4,
    type: "deposit",
    amount: 1000,
    notes: "Counter cash",
  } as never);
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

/** Mount one URL for real (effects included) and return its visible text. */
async function renderRoute(path: string | string[]): Promise<string> {
  // An ARRAY is the route you arrived through — the last entry is the page
  // being tested and the ones before it are real history, which is the only
  // way to exercise a back button for what it is.
  const entries = Array.isArray(path) ? path : [path];
  const router = createRouter({
    routeTree,
    context: { queryClient: new QueryClient() },
    history: createMemoryHistory({ initialEntries: entries }),
  });
  await router.load();

  if (root) root.unmount();
  if (host) host.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);

  await act(async () => {
    root!.render(<RouterProvider router={router} />);
  });
  // Let post-render effects (the list screens' data load) settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  return host.textContent ?? "";
}

/** Re-read the currently mounted page after letting React settle. */
async function readMounted(): Promise<string> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  return host?.textContent ?? "";
}

/**
 * Keep whatever passed when a step throws.
 *
 * A missing control aborts the rest of the run, and the harness used to
 * replace the entire result with the exception — so a single broken selector
 * reported "0 passed" and hid both the assertions that had already run AND
 * the ones that explain why. The count is now honest and the error is just
 * one more failure line.
 */
export async function run(): Promise<Results> {
  try {
    return await runAll();
  } catch (e) {
    R.failed++;
    R.fails.push(`aborted: ${(e as Error)?.stack ?? String(e)}`);
    return R;
  }
}

async function runAll(): Promise<Results> {
  const rootOptions = (routeTree as unknown as { options: Record<string, unknown> }).options;
  // Swap the root component for a bare Outlet: the real one is the auth gate,
  // which needs a live Firebase session this test deliberately cannot have.
  // The real root is the auth gate, which needs a live Firebase session this
  // test deliberately cannot have — but it also mounts the app-wide key
  // handling, so the stand-in has to keep THAT or every keyboard test here
  // would be exercising a page the shop never runs.
  rootOptions.component = function TestRoot() {
    useAppEscape();
    return <Outlet />;
  };
  // And drop the document shell — it renders <html><body>, which cannot be
  // mounted inside a container div.
  rootOptions.shellComponent = ({ children }: { children: ReactNode }) => <>{children}</>;
  // React refuses to run act() unless the environment opts in.
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__TEST_IS_OWNER__ = true;

  /* ── THE cold-open regression ─────────────────────────────────────────
     This is the bug the v50 refactor was about, and the only test here that
     reproduces it: the app now renders BEFORE the collections have loaded,
     so a screen must fill in when data arrives later — not stay frozen on
     whatever the cache held at mount. Deleting the repo-version dependency
     (which the lint rule actively suggests) makes exactly this fail, while
     every seeded-first assertion below would still pass.                  */
  // (a) a list screen, which fills in through `useEffect(refresh, [_repoV])`
  const emptyList = await renderRoute("/sales");
  assert(
    !emptyList.includes("INV-0001"),
    "cold open: the sales list must start empty before any data has arrived",
  );

  // (b) a derived screen, which fills in through `useRepoMemo` — this is the
  //     mechanism the refactor replaced, so it is the one that has to be
  //     pinned. Mount it empty FIRST, then let data arrive underneath it.
  const emptyPl = await renderRoute("/reports?r=pl");
  assert(
    !emptyPl.includes(fmtMoney(1000)),
    "cold open: P&L must start at zero before any data has arrived",
  );

  // Data lands afterwards, exactly as a Firestore snapshot would deliver it.
  await act(async () => {
    seed();
  });

  const plAfterArrival = await readMounted();
  has(plAfterArrival, fmtMoney(1000), "cold open: P&L fills in once data arrives (no remount)");
  has(plAfterArrival, fmtMoney(360), "cold open: derived gross profit fills in too");

  const listAfterArrival = await renderRoute("/sales");
  has(listAfterArrival, "INV-0001", "cold open: the list screen shows the arrived data");

  /* ── Expected values, derived by hand from the seed above ───────────── */
  // Sale 1000 − return 100 = 900 net revenue (neither bill carries GST).
  // COGS = 10x60 − 1x60 = 540. Gross profit 360. Expenses 5000 → net −4640.
  const pl = await renderRoute("/reports?r=pl");
  has(pl, "Sales Revenue (excl. GST)", "P&L: GST-exclusive revenue label");
  has(pl, fmtMoney(1000), "P&L: sales revenue 1000");
  has(pl, fmtMoney(540), "P&L: COGS 540");
  has(pl, fmtMoney(360), "P&L: gross profit 360");
  has(pl, fmtMoney(-4640), "P&L: net profit -4640");

  // Statement: 1000 invoiced − 100 returned − 400 settled − 300 advance = 200.
  const statement = await renderRoute("/parties/P1");
  has(statement, "Ramesh Traders", "statement: party name");
  has(statement, "INV-0001", "statement: the invoice row");
  has(statement, "CR-0001", "statement: the credit note row");
  has(statement, fmtMoney(200), "statement: closing balance 200");

  // Passbook: opening 10000 + 400 sale receipt + 1000 deposit = 11400, which
  // must equal the account's stored balance.
  const passbook = await renderRoute("/bank/B1");
  has(passbook, "HDFC Current", "passbook: account name");
  has(passbook, fmtMoney(11400), "passbook: derived balance 11400 matches stored");
  has(passbook, fmtMoney(400), "passbook: the sale receipt");
  has(passbook, fmtMoney(1000), "passbook: the deposit");

  // Item page: 10 sold, 1 returned, profit = 9 x (100 − 60) = 360.
  const item = await renderRoute("/items/I1");
  has(item, "USB Cable", "item page: name");
  has(item, "INV-0001", "item page: sale in history");
  has(item, fmtMoney(360), "item page: profit earned 360");

  const payee = await renderRoute("/payees/PE1");
  has(payee, "Landlord", "payee page: name");
  has(payee, fmtMoney(5000), "payee page: the rent expense");

  /* ── Dashboard: every figure on the home page, derived by hand ───────
     The client reports the home page totals as wrong, so each card is
     pinned to an independently-computed value rather than to whatever the
     code happens to produce. `fmt` mirrors the dashboard's own formatter
     (en-IN, no decimals). */
  const fmt = (n: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n);
  const home = await renderRoute("/");
  // P1: 1000 invoiced − 100 returned − 400 settled − 300 advance = 200
  has(home, `₹ ${fmt(200)}`, "dashboard: Total Receivable = 200");
  // P2: 450 purchased, nothing paid = 450
  has(home, `₹ ${fmt(450)}`, "dashboard: Total Payable = 450");
  // cash-mode only: +300 payment in, −5000 expense (the sale settled by bank)
  has(home, `₹ ${fmt(-4700)}`, "dashboard: Cash On Hand = −4700");
  // stored 11400; the sale is tied to account B1 so it is NOT added again
  has(home, `₹ ${fmt(11400)}`, "dashboard: Total Bank Balance = 11400");
  // 40×60 + 2×90
  has(home, `₹ ${fmt(2580)}`, "dashboard: Stock Value = 2580");
  has(home, `₹ ${fmt(450)}`, "dashboard: Purchases this period = 450");
  has(home, `₹ ${fmt(5000)}`, "dashboard: Expenses this period = 5000");
  // 1000 − 100 − 540 COGS − 5000 expenses (GST-exclusive, so unchanged here)
  has(home, `₹ ${fmt(-4640)}`, "dashboard: Net Profit = −4640");

  // Back belongs on DETAIL pages — the ones you drill into and have to get
  // out of. Main pages are reached from the sidebar/tab bar, so there is
  // nothing to go back to and a lone chevron beside the title just looks
  // broken. Both halves are asserted so neither drifts.
  const backCount = () => document.querySelectorAll('[aria-label="Go back"]').length;
  for (const url of ["/parties/P1", "/items/I1", "/bank/B1", "/payees/PE1"]) {
    await renderRoute(url);
    assert(backCount() > 0, url + ": detail page must offer a back control");
  }
  for (const url of ["/parties", "/items", "/expenses", "/reports", "/daybook", "/settings"]) {
    await renderRoute(url);
    assert(backCount() === 0, url + ": main page must NOT show a back arrow");
  }

  // Expenses: edit and delete must be visible controls, not just a row
  // click and a Ctrl+Delete nobody can discover.
  const expensesPage = await renderRoute("/expenses");
  has(expensesPage, "Action", "expenses: row actions column is present");

  // Items page: the old "apply one operation to everything" bulk edit was
  // replaced by the Bulk Update Items screen, reachable without selecting.
  const itemsPage = await renderRoute("/items");
  has(itemsPage, "Bulk Update", "items: the new bulk update entry point");
  assert(!itemsPage.includes("Bulk Edit"), "items: the replaced Bulk Edit button must be gone");

  const daybook = await renderRoute(`/daybook?date=${D3}`);
  has(daybook, "PUR-0001", "daybook: the purchase");
  has(daybook, fmtMoney(5000), "daybook: the expense");

  // Owner-only sections of Settings must be invisible to a non-owner and
  // present for an owner — both sides of the gate, on the same page.
  globalThis.__TEST_IS_OWNER__ = false;
  const staffSettings = await renderRoute("/settings");
  has(staffSettings, "Company Details", "settings (staff): ordinary section");
  assert(
    !staffSettings.includes("Fix Calculations"),
    "settings (staff): the owner-only recalculation tool must be hidden",
  );
  assert(!staffSettings.includes("Team"), "settings (staff): owner-only Team must be hidden");

  globalThis.__TEST_IS_OWNER__ = true;
  const ownerSettings = await renderRoute("/settings");
  has(ownerSettings, "Fix Calculations", "settings (owner): the recalculation tool");
  has(ownerSettings, "Check Calculations", "settings (owner): the recalculation action");
  has(ownerSettings, "Check Calculations", "settings (owner): the recalculation action");
  has(ownerSettings, "Team", "settings (owner): team section");

  /* ── Every remaining screen must render real content, not blow up ───── */
  const pages: [string, string][] = [
    ["/", "Total Receivable"],
    ["/parties", "Ramesh Traders"],
    ["/items", "USB Cable"],
    ["/inventory", "USB Cable"],
    ["/sales", "INV-0001"],
    ["/purchase", "PUR-0001"],
    ["/sale-return", "CR-0001"],
    ["/purchase-return", "Purchase Return"],
    ["/expenses", "Rent"],
    ["/payees", "Landlord"],
    ["/bank", "HDFC Current"],
    ["/cash", "Cash"],
    ["/payments", "Ramesh Traders"],
    ["/gst", "GST"],
    ["/reports?r=gst", "GST"],
    ["/reports?r=party-ledger", "Ramesh Traders"],
    ["/reports?r=stock", "USB Cable"],
    ["/settings", "Company Details"],
    ["/sales/S1", "INV-0001"],
    ["/purchase/PU1", "PUR-0001"],
    ["/sale-return/SR1", "CR-0001"],
  ];
  for (const [url, needle] of pages) {
    let text = "";
    try {
      text = await renderRoute(url);
    } catch (err) {
      assert(false, `${url} threw while rendering: ${(err as Error).message}`);
      continue;
    }
    assert(text.length > 100, `${url} rendered a suspiciously short page`);
    assert(!/NaN/.test(text), `${url} rendered NaN`);
    has(text, needle, `${url} content`);
  }

  /* ── A party must never appear in BOTH Receivable and Payable ─────────
     The production case: a payable opening plus a later sale. The party's
     statement netted it correctly while the dashboard counted the party on
     both tiles. */
  {
    PartyRepo.update("P2", { openingBalance: -9850 });
    SalesRepo.add({
      id: "NETS1",
      createdAt: `${D5}T10:00:00Z`,
      number: "INV-9002",
      date: D5,
      partyId: "P2",
      partyName: "Sunrise Supply",
      gstEnabled: false,
      lineItems: [],
      subtotal: 11000,
      discount: 0,
      taxAmount: 0,
      total: 11000,
      paid: 0,
      paymentMode: "credit",
      notes: "",
    } as never);

    // opening −9850 + 11000 sale − 450 purchase = 700 receivable, and the
    // party must be gone from Payable entirely.
    const netHome = await renderRoute("/");
    has(netHome, "₹ 900", "netting: receivable is P1's 200 + P2's netted 700");
    has(netHome, "From 2 Parties", "netting: both parties counted once");
    assert(
      !netHome.includes("₹ 9,850") && !netHome.includes("₹ 10,300"),
      "netting: the payable opening must NOT also stand on its own",
    );

    const netParties = await renderRoute("/parties");
    has(netParties, fmtMoney(700), "netting: Parties row shows the netted figure");

    SalesRepo.remove("NETS1");
    PartyRepo.update("P2", { openingBalance: 0 });
  }

  /* ── Changing a party's OPENING BALANCE must reach every screen ───────
     Reported: "they change client opening — receivable, payable, ledger,
     statement, nothing updates". Opening balance is a stored field that
     every derived view folds in, so a change has to surface everywhere. */
  {
    // P2 is the supplier side of the seed and starts at 0.
    PartyRepo.update("P2", { openingBalance: 7000 });

    // Sign convention (as labelled in the party form): POSITIVE means they
    // owe you. P2 also has a 450 purchase bill, and the two NET against each
    // other now — 7000 − 450 = 6550 receivable, plus P1's 200 = 6750. The
    // party no longer stands in Payable at the same time.
    const home = await renderRoute("/");
    has(
      home,
      "₹ 6,750",
      "opening balance: dashboard receivable nets the purchase (7000 − 450 + 200)",
    );

    const list = await renderRoute("/parties");
    has(list, fmtMoney(6550), "opening balance: Parties list row shows the netted figure");

    const stmt = await renderRoute("/parties/P2");
    has(stmt, fmtMoney(7000), "opening balance: statement shows the opening row");

    // A NEGATIVE opening is the "we owe them" side — it must land in payable.
    PartyRepo.update("P2", { openingBalance: -1000 });
    const home2 = await renderRoute("/");
    has(home2, "₹ 1,450", "opening balance: negative opening moves to payable (1000 + 450)");
    assert(
      !home2.includes("₹ 7,200"),
      "opening balance: the old value must be gone after editing it",
    );

    PartyRepo.update("P2", { openingBalance: 0 }); // restore for later assertions
  }

  /* ── Archived party holding money: do the two screens agree? ─────────
     Run LAST, because it mutates the seeded book. Archiving only hides a
     party from pickers — it does not forgive what they owe — so the money
     must not silently disappear from one screen while showing on another. */
  PartyRepo.update("P1", { archived: true });

  const homeAfterArchive = await renderRoute("/");
  has(
    homeAfterArchive,
    `₹ ${fmt(200)}`,
    "archived party: dashboard still counts money they owe (archiving is not forgiveness)",
  );

  const partiesAfterArchive = await renderRoute("/parties");
  assert(
    partiesAfterArchive.includes(fmtMoney(200)),
    "archived party: the Parties page hides ₹200 of receivable that the dashboard counts — " +
      "the two screens disagree",
  );

  /* ── The item dropdown must actually SCROLL ──────────────────────────
     It caps at MAX_SUGGESTIONS rows and is height-limited, so the list has
     to be scrollable — otherwise only the first handful are reachable and
     the rest may as well not exist, which is exactly what the shop saw. */
  {
    // Enough items to overflow the dropdown. Zero stock and zero price so
    // no money assertion above is disturbed.
    for (let i = 0; i < 40; i++) {
      ItemRepo.add({
        id: `DD${i}`,
        createdAt: "2026-01-01T00:00:00Z",
        name: `Dropdown Probe Item ${i}`,
        unit: "pcs",
        gstRate: 0,
        purchasePrice: 0,
        salePrice: 0,
        stock: 0,
        openingStock: 0,
      } as never);
    }

    await renderRoute("/sales/new");
    const input = Array.from(document.querySelectorAll("input")).find((el) =>
      (el.getAttribute("placeholder") ?? "").startsWith("Type item name"),
    );
    assert(!!input, "item dropdown: found the item search input");
    if (input) {
      await act(async () => {
        input.focus();
        input.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 80));
      });

      // The popup is portalled to <body>; find the scrolling list inside it.
      const rows = Array.from(document.querySelectorAll("div")).filter((d) =>
        (d.textContent ?? "").startsWith("Dropdown Probe Item 0"),
      );
      assert(rows.length > 0, "item dropdown: opened and rendered options");

      const scroller = rows[0]?.closest("div.overflow-auto") as HTMLElement | null;
      assert(!!scroller, "item dropdown: options sit inside a scrollable container");
      const popup = scroller?.parentElement as HTMLElement | null;

      // Real layout, measured against the compiled stylesheet.
      if (scroller && popup) {
        assert(
          popup.getBoundingClientRect().height <= 320,
          `item dropdown: popup must stay height-capped — measured ${Math.round(popup.getBoundingClientRect().height)}px`,
        );
        assert(
          scroller.scrollHeight > scroller.clientHeight + 4,
          `item dropdown: list must be scrollable — content ${scroller.scrollHeight}px in ${scroller.clientHeight}px`,
        );

        // Scrolling has to WORK, not merely be possible.
        scroller.scrollTop = 400;
        const immediate = scroller.scrollTop; // before React sees anything
        await act(async () => {
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        const afterScrollEvent = scroller.scrollTop;
        assert(
          immediate > 0,
          `item dropdown: setting scrollTop should stick immediately — got ${immediate}`,
        );
        assert(
          afterScrollEvent > 0,
          `item dropdown: a scroll event must not reset the list — was ${immediate}, became ${afterScrollEvent}`,
        );
        // Let every pending effect and timer settle: the position must
        // SURVIVE them. A re-render used to snap the list back to the top.
        await act(async () => {
          await new Promise((r) => setTimeout(r, 120));
        });
        assert(
          scroller.scrollTop > 0,
          `item dropdown: the scrolled position must survive re-renders — scrollTop fell to ${scroller.scrollTop}`,
        );

        // THE REPORTED BUG: reaching for the scrollbar blurs the input, and
        // the blur handler closes the popup 150ms later — so a long list is
        // unreachable by the one gesture people use to browse it. A mousedown
        // anywhere in the popup (its padding, its scrollbar gutter) must not
        // dismiss it.
        await act(async () => {
          popup.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 300));
        });
        assert(
          document.body.contains(scroller),
          "item dropdown: must stay open when the scrollbar/popup is pressed",
        );
      }
    }
  }

  /* ── Printed documents: every row must match the header ──────────────
     The line table has optional columns (Disc%, GST%, GST Amt). When the
     filler rows or the Item Total row hard-code their cell counts, the
     table grows a phantom empty column hanging off the right edge — which
     is exactly what a real bill looked like. Checked across all four
     combinations so no single flag can break the grid again. */
  {
    const line = (over: Record<string, unknown> = {}) => ({
      id: "PL1",
      itemId: "I1",
      name: "CARRING",
      unit: "pcs",
      qty: 1,
      price: 55000,
      discountPct: 0,
      gstRate: 0,
      amount: 55000,
      ...over,
    });
    const baseInv = (over: Record<string, unknown> = {}) =>
      ({
        id: "PI1",
        number: "0009",
        date: D2,
        partyId: "P1",
        partyName: "LOTUS",
        gstEnabled: false,
        lineItems: [line()],
        subtotal: 55000,
        discount: 0,
        taxAmount: 0,
        total: 55000,
        paid: 0,
        paymentMode: "credit",
        createdAt: `${D2}T09:00:00Z`,
        ...over,
      }) as never;

    const gridHost = document.createElement("div");
    document.body.appendChild(gridHost);
    const gridRoot = createRoot(gridHost);

    /** Widest row wins as the expected width; every row must equal it. */
    const checkGrid = (label: string) => {
      // These documents contain several tables (the Invoice #/Date block is
      // one). Pick the LINE table — the one whose header row has "Qty".
      const table = Array.from(gridHost.querySelectorAll("table")).find((t) =>
        (t.rows[0]?.textContent ?? "").includes("Qty"),
      );
      assert(!!table, `${label}: found the printed line table`);
      if (!table) return;
      const widthOf = (tr: HTMLTableRowElement) =>
        Array.from(tr.cells).reduce((n, c) => n + (c.colSpan || 1), 0);
      const widths = Array.from(table.rows).map(widthOf);
      const expected = Math.max(...widths);
      const bad = widths.filter((w) => w !== expected).length;
      assert(
        bad === 0,
        `${label}: ${bad} row(s) don't span ${expected} columns — got ${widths.join(",")}`,
      );
    };

    const cases: [string, Record<string, unknown>][] = [
      ["invoice no-GST no-discount", {}],
      ["invoice no-GST with line discount", { lineItems: [line({ discountPct: 10 })] }],
      [
        "invoice with GST",
        { gstEnabled: true, taxAmount: 9900, lineItems: [line({ gstRate: 18 })] },
      ],
      [
        "invoice GST + discount",
        { gstEnabled: true, taxAmount: 9900, lineItems: [line({ gstRate: 18, discountPct: 5 })] },
      ],
    ];
    for (const [label, over] of cases) {
      await act(async () => {
        gridRoot.render(
          <PrintableInvoice inv={baseInv(over)} company={CompanyRepo.get()} mode="sale" />,
        );
      });
      checkGrid(label);
    }

    // Return notes share the same layout and had the same fault.
    const baseRet = (over: Record<string, unknown> = {}) =>
      ({
        id: "PR1",
        number: "CR-0009",
        date: D4,
        partyId: "P1",
        partyName: "LOTUS",
        gstEnabled: false,
        lineItems: [line()],
        subtotal: 55000,
        taxAmount: 0,
        total: 55000,
        createdAt: `${D4}T09:00:00Z`,
        ...over,
      }) as never;
    for (const [label, over] of [
      ["return no-GST", {}],
      [
        "return with GST",
        { gstEnabled: true, taxAmount: 9900, lineItems: [line({ gstRate: 18 })] },
      ],
    ] as [string, Record<string, unknown>][]) {
      await act(async () => {
        gridRoot.render(
          <PrintableReturn ret={baseRet(over)} company={CompanyRepo.get()} mode="sale-return" />,
        );
      });
      checkGrid(label);
    }
    gridRoot.unmount();
    gridHost.remove();
  }

  /* ── Quick entry: one amount, settled oldest bill first ───────────────
     The counter takes a round figure off a customer's whole account. This
     drives the real dialog — pick the party, type the amount, type the
     write-off — and checks that the money lands on the right bills in the
     right order and that the bills actually close. spreadFifo's arithmetic is
     pinned in the audit suite; what is pinned HERE is the wiring, which is
     what silently breaks. */
  {
    PartyRepo.add({
      id: "QP",
      createdAt: "2026-01-01T00:00:00Z",
      name: "Quick Entry Customer",
      type: "customer",
      openingBalance: 0,
    } as never);
    // Two open bills, deliberately seeded newest-first so a save that just
    // walks the list in repo order would settle the WRONG one.
    for (const [id, number, date, total] of [
      ["QB2", "INV-QB2", "2026-03-02", 10500],
      ["QB1", "INV-QB1", "2026-03-01", 10000],
    ] as const) {
      SalesRepo.add({
        id,
        createdAt: "2026-01-01T00:00:00Z",
        number,
        date,
        partyId: "QP",
        partyName: "Quick Entry Customer",
        lineItems: [],
        subtotal: total,
        discount: 0,
        shippingCharge: 0,
        taxAmount: 0,
        total,
        paid: 0,
        paymentMode: "credit",
        gstEnabled: false,
      } as never);
    }

    await renderRoute("/payments");
    const receive = findButton(/Receive Payment/);
    assert(
      !!receive,
      `quick entry: found the Receive Payment button — buttons: ${JSON.stringify(
        Array.from(document.querySelectorAll("button"))
          .map((b) => (b.textContent ?? "").trim())
          .filter(Boolean)
          .slice(0, 12),
      )}`,
    );
    if (!receive) throw new Error("quick entry: no Receive button, cannot continue");
    await act(async () => {
      receive.click();
    });
    await settleMs(120);

    const partyBox = document.querySelector(
      'input[placeholder="Type to search party…"]',
    ) as HTMLInputElement | null;
    assert(
      !!partyBox,
      `quick entry: found the party box — inputs on screen: ${JSON.stringify(
        Array.from(document.querySelectorAll("input")).map((i) => i.placeholder || i.type),
      )}`,
    );
    if (!partyBox) throw new Error("quick entry: no party box, cannot continue");
    await act(async () => {
      setInput(partyBox, "Quick Entry");
    });
    await settleMs(80);
    // The DEEPEST div with this text, not the first: when a search narrows to
    // one result, the dropdown container's textContent equals the option's
    // too, and it comes first in document order. Clicking the container does
    // nothing, because React events bubble up, not down.
    const option = Array.from(document.querySelectorAll("div"))
      .filter((d) => d.textContent === "Quick Entry Customer")
      .pop();
    assert(!!option, "quick entry: the party is suggested");
    if (!option) throw new Error("quick entry: party not suggested, cannot continue");
    await act(async () => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await settleMs(120);

    const panel = document.body.textContent ?? "";
    assert(
      panel.includes(fmtMoney(20500)),
      "quick entry: the whole outstanding is shown, not a bill at a time",
    );
    assert(
      panel.includes("Settles oldest invoice first"),
      "quick entry: the allocation preview is on screen",
    );

    // 20,000 taken and 500 written off must close BOTH bills exactly.
    const amountBox = document.querySelector(
      'input[aria-label="Amount received"]',
    ) as HTMLInputElement | null;
    assert(!!amountBox, "quick entry: found the amount box");
    await act(async () => {
      setInput(amountBox, "20000");
    });
    await settleMs(80);
    const discountBox = document.querySelector(
      'input[aria-label="Discount or write-off"]',
    ) as HTMLInputElement | null;
    assert(!!discountBox, "quick entry: found the discount box");
    await act(async () => {
      setInput(discountBox, "500");
    });
    await settleMs(80);

    const preview = document.body.textContent ?? "";
    assert(
      preview.includes("closed") && !preview.includes("untouched"),
      "quick entry: 20,000 + 500 off closes both bills in the preview",
    );

    const confirm = findButton(/Confirm Receipt/);
    assert(!!confirm, "quick entry: found Confirm Receipt");
    await act(async () => {
      confirm!.click();
    });
    await settleMs(250);

    assert(
      SalesRepo.get("QB1")?.paid === 10000,
      `quick entry: the OLDEST bill is settled first — QB1 paid ${SalesRepo.get("QB1")?.paid} (want 10000)`,
    );
    assert(
      SalesRepo.get("QB2")?.paid === 10500,
      `quick entry: the newer bill takes the rest plus the write-off — QB2 paid ${SalesRepo.get("QB2")?.paid} (want 10500)`,
    );
    const rec = PaymentRepo.all().find((p) => p.partyId === "QP");
    assert(
      rec?.amount === 20000,
      `quick entry: the payment records the CASH taken, not the settled total — got ${rec?.amount}`,
    );
    assert(
      r2((rec?.allocations ?? []).reduce((s, a) => s + (a.discount ?? 0), 0)) === 500,
      `quick entry: the write-off is recorded as a discount — got ${JSON.stringify(rec?.allocations)}`,
    );
  }

  /* ── A rejected commit must be reported as one ───────────────────────
     Every write updates the in-memory cache the moment it is staged, so the
     screens show the new numbers before the cloud has agreed to them. When the
     commit is then rejected, Firestore rolls its own mutation back and the next
     snapshot restores the truth — but a dialog that already said "Updated 266
     items" and closed has told the shopkeeper something false, and what they
     see next looks like the app losing their work. commitBatch used to swallow
     the error, leaving callers no way to tell. */
  {
    const ok = { commit: () => Promise.resolve() } as unknown as Parameters<typeof commitBatch>[0];
    const rejected = {
      commit: () => Promise.reject(new Error("permission-denied")),
    } as unknown as Parameters<typeof commitBatch>[0];

    assert((await commitBatch(ok, "t19")) === true, "T19: a clean commit reports success");
    // The rejection is the point of the test, and commitBatch logs it — this
    // muffles the expected noise so the harness's "no console errors" rule
    // still means something for everything else.
    const realError = console.error;
    console.error = () => {};
    const rejectedResult = await commitBatch(rejected, "t19");
    console.error = realError;
    assert(rejectedResult === false, "T19: a rejected commit reports failure");
    assert((await commitBatch(null, "t19")) === true, "T19: the SSR no-op is not a failure");
  }

  /* ── Bulk Update actually writes what was typed ───────────────────────
     The client reported a bulk stock change disagreeing with the item's own
     page and the items list afterwards. This drives the real dialog the way
     a shopkeeper does — search, type, search again, type, save — and then
     checks the number on BOTH screens plus the audit trail, because those
     are the three places a stock correction has to reach.

     It also covers the flow that only a real catalogue produces: the edited
     rows are scrolled out of the window by the time Update is pressed, so a
     save that only looked at mounted rows would silently drop them. */
  {
    // Enough filler for the list to actually scroll — the window only drops a
    // row when there is something below it to scroll to, and without that the
    // "edits survive being unmounted" half of this test proves nothing.
    for (let i = 0; i < 120; i++) {
      ItemRepo.add({
        id: `FILL${i}`,
        createdAt: "2026-01-01T00:00:00Z",
        name: `Filler Item ${i}`,
        unit: "pcs",
        gstRate: 18,
        purchasePrice: 100,
        salePrice: 150,
        stock: 5,
        openingStock: 5,
      } as never);
    }
    // Added last, so these two sit at the top of the list: on page one of the
    // Items screen, and in the grid's first window until it is scrolled.
    for (const [id, stock] of [
      ["BU1", 17],
      ["BU2", 39],
    ] as const) {
      ItemRepo.add({
        id,
        createdAt: "2026-01-01T00:00:00Z",
        name: `Bulk Save ${id}`,
        unit: "pcs",
        gstRate: 18,
        purchasePrice: 100,
        salePrice: 150,
        stock,
        openingStock: stock,
      } as never);
    }

    const h = document.createElement("div");
    document.body.appendChild(h);
    const r = createRoot(h);
    await act(async () => {
      r.render(<BulkUpdateItemsDialog open onOpenChange={() => {}} onSaved={() => {}} />);
    });
    await settleMs(80);

    const stockTab = Array.from(document.querySelectorAll('[role="radio"]')).find((b) =>
      (b.textContent ?? "").trim().startsWith("Stock"),
    ) as HTMLButtonElement | undefined;
    assert(!!stockTab, "bulk save: found the Stock tab");
    await act(async () => {
      stockTab!.click();
    });
    await settleMs(60);

    const search = document.querySelector(
      'input[placeholder="Search items…"]',
    ) as HTMLInputElement | null;
    assert(!!search, "bulk save: found the search box");

    for (const [name, want] of [
      ["Bulk Save BU1", 111],
      ["Bulk Save BU2", 222],
    ] as const) {
      await act(async () => {
        setInput(search!, name);
      });
      await settleMs(60);
      const cells = gridRow(name);
      assert(!!cells, `bulk save: ${name} is findable by search`);
      if (cells) {
        await act(async () => {
          setInput(cells[1], String(want));
        });
        await settleMs(40);
      }
    }

    // Clear the search and scroll away, so NEITHER edited row is mounted when
    // Update is pressed. A save that walked the rendered rows instead of the
    // catalogue would drop both edits here and report success anyway.
    await act(async () => {
      setInput(search!, "");
    });
    await settleMs(60);
    // The grid's scroll container is the table's own parent — found that way
    // rather than by class, so a Tailwind rename cannot quietly turn this
    // into a no-op that still passes.
    const scroller = document.querySelector('[role="dialog"] table')
      ?.parentElement as HTMLDivElement | null;
    assert(!!scroller, "bulk save: found the grid scroller");
    await act(async () => {
      scroller!.scrollTop = scroller!.scrollHeight;
      scroller!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await settleMs(120);
    assert(
      !gridRow("Bulk Save BU1") && !gridRow("Bulk Save BU2"),
      "bulk save: the edited rows really are unmounted before saving",
    );

    const update = findButton(/^Update/);
    assert(
      (update?.textContent ?? "").includes("(2)"),
      `bulk save: both edits are counted — button says ${JSON.stringify(update?.textContent)}`,
    );
    await act(async () => {
      update!.click();
    });
    await settleMs(250);

    assert(
      ItemRepo.get("BU1")?.stock === 111 && ItemRepo.get("BU2")?.stock === 222,
      `bulk save: typed values land — BU1=${ItemRepo.get("BU1")?.stock} (want 111), BU2=${ItemRepo.get("BU2")?.stock} (want 222)`,
    );
    // Stock moves only through an audited adjustment, never an absolute write.
    const adjusted = StockAdjustmentRepo.all().filter(
      (a) => a.itemId === "BU1" || a.itemId === "BU2",
    );
    assert(
      adjusted.length === 2 &&
        adjusted.every((a) => a.type === "add" && a.reason === "Bulk update"),
      `bulk save: each stock change writes its audit row — got ${JSON.stringify(adjusted.map((a) => `${a.itemId}:${a.type}:${a.qty}`))}`,
    );
    // And the result must be self-consistent, or Fix Calculations would
    // "repair" a correction the shopkeeper just made on purpose.
    const drift = planStockRepair({
      items: ItemRepo.all(),
      sales: SalesRepo.all(),
      purchases: PurchaseRepo.all(),
      saleReturns: SaleReturnRepo.all(),
      purchaseReturns: [],
      stockAdjustments: StockAdjustmentRepo.all(),
    }).filter((d) => d.id === "BU1" || d.id === "BU2");
    assert(
      drift.length === 0,
      `bulk save: the corrected items must not read as drift — ${JSON.stringify(drift)}`,
    );

    r.unmount();
    h.remove();

    // The two screens the client compared.
    const itemsList = await renderRoute("/items");
    assert(itemsList.includes("111 pcs"), "bulk save: the items list shows the new stock");
    const itemPage = await renderRoute("/items/BU1");
    assert(itemPage.includes("111 pcs"), "bulk save: the item's own page shows the new stock");
    assert(
      itemPage.includes("Bulk update"),
      "bulk save: the item's history shows where the change came from",
    );
  }

  /* ── Bulk rename cannot manufacture two identical items ───────────────
     Renaming in bulk shipped with no guard, while the single-item form has
     always blocked duplicates. Two items sharing a name is precisely how the
     list and an item's own page start disagreeing about which one is which. */
  {
    const h = document.createElement("div");
    document.body.appendChild(h);
    const r = createRoot(h);
    await act(async () => {
      r.render(<BulkUpdateItemsDialog open onOpenChange={() => {}} onSaved={() => {}} />);
    });
    await settleMs(80);

    const infoTab = Array.from(document.querySelectorAll('[role="radio"]')).find((b) =>
      (b.textContent ?? "").trim().startsWith("Item Information"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      infoTab!.click();
    });
    await settleMs(60);

    const search = document.querySelector('input[placeholder="Search items…"]') as HTMLInputElement;
    await act(async () => {
      setInput(search, "Bulk Save BU2");
    });
    await settleMs(60);
    const row = gridRow("Bulk Save BU2");
    assert(!!row, "bulk rename: found the row to rename");
    // Rename it to the OTHER item's name. (Every step below re-finds the row
    // by its CURRENT name: if the guard under test is missing, the rename
    // goes through and the old handle would be stale — this must report the
    // broken guard, not crash the harness on it.)
    await act(async () => {
      setInput(row![0], "Bulk Save BU1");
    });
    await settleMs(60);
    await act(async () => {
      findButton(/^Update/)!.click();
    });
    await settleMs(200);
    assert(
      ItemRepo.get("BU2")?.name === "Bulk Save BU2",
      `bulk rename: a duplicate name is refused — BU2 is now ${JSON.stringify(ItemRepo.get("BU2")?.name)}`,
    );

    // A blank name is refused too.
    const stillThere = gridRow("Bulk Save BU1") ?? row;
    await act(async () => {
      setInput(stillThere![0], "   ");
    });
    await settleMs(60);
    await act(async () => {
      findButton(/^Update/)!.click();
    });
    await settleMs(200);
    assert(
      ItemRepo.get("BU2")?.name === "Bulk Save BU2",
      `bulk rename: a blank name is refused — BU2 is now ${JSON.stringify(ItemRepo.get("BU2")?.name)}`,
    );

    /* A legal rename made in the SAME save as a stock change: the audit row
       has to be filed under the new name. It used to copy the stored one, so
       the item's history showed a movement labelled with a name that item no
       longer had. */
    const toRename = gridRow("   ") ?? gridRow("Bulk Save BU1") ?? row;
    await act(async () => {
      setInput(toRename![0], "Bulk Save Renamed");
    });
    await settleMs(60);
    const stockTab2 = Array.from(document.querySelectorAll('[role="radio"]')).find((b) =>
      (b.textContent ?? "").trim().startsWith("Stock"),
    ) as HTMLButtonElement;
    await act(async () => {
      stockTab2.click();
    });
    await settleMs(60);
    const renamedRow = gridRow("Bulk Save Renamed");
    assert(!!renamedRow, "bulk rename: the renamed row keeps its edit across tabs");
    if (renamedRow) {
      await act(async () => {
        setInput(renamedRow[1], "500");
      });
      await settleMs(60);
    }
    await act(async () => {
      findButton(/^Update/)!.click();
    });
    await settleMs(250);
    assert(
      ItemRepo.get("BU2")?.name === "Bulk Save Renamed" && ItemRepo.get("BU2")?.stock === 500,
      `bulk rename: a legal rename saves alongside the stock change — ${JSON.stringify(ItemRepo.get("BU2")?.name)} / ${ItemRepo.get("BU2")?.stock}`,
    );
    const renameAdj = StockAdjustmentRepo.all().filter((a) => a.itemId === "BU2");
    assert(
      renameAdj.some((a) => a.itemName === "Bulk Save Renamed"),
      `bulk rename: the audit row carries the NEW name — got ${JSON.stringify(renameAdj.map((a) => a.itemName))}`,
    );

    r.unmount();
    h.remove();
  }

  /* ── A search survives opening a result and coming back ───────────────
     "I searched, opened one, pressed back, and it had forgotten everything."
     The list's search was component state, so it died with the unmount. */
  {
    const list = await renderRoute("/items");
    const box = document.querySelector('input[placeholder*="Search"]') as HTMLInputElement | null;
    assert(!!box, `sticky search: found the items search box — page has ${list.length} chars`);
    if (box) {
      await act(async () => {
        setInput(box, "Bulk Save BU1");
      });
      await settleMs(80);
      // Leave and come back the way the client does: open a result, return.
      await renderRoute("/items/BU1");
      const backAgain = await renderRoute("/items");
      const box2 = document.querySelector(
        'input[placeholder*="Search"]',
      ) as HTMLInputElement | null;
      assert(
        box2?.value === "Bulk Save BU1",
        `sticky search: the search is still there on return — got ${JSON.stringify(box2?.value)}`,
      );
      assert(
        backAgain.includes("Bulk Save BU1"),
        "sticky search: and the list is still filtered by it",
      );
      // Clearing it must actually clear it — remembered state, not stuck state.
      await act(async () => {
        setInput(box2, "");
      });
      await settleMs(60);
      await renderRoute("/items/BU1");
      await renderRoute("/items");
      const box3 = document.querySelector(
        'input[placeholder*="Search"]',
      ) as HTMLInputElement | null;
      assert(box3?.value === "", "sticky search: clearing it sticks too");
    }
  }

  /* ── Back is ONE step, by key as well as by button ────────────────────
     The detail pages used to navigate FORWARD to their list, which pushes a
     new history entry — so the browser's own Back button then returned to
     the detail page and the user was stuck in a loop. */
  {
    // Arrive at the item from the PARTIES page, so "back" has somewhere real
    // to go and we can prove it goes THERE — not to the items list, which is
    // what the old forward-navigation did regardless of where you came from.
    const detail = await renderRoute(["/parties", "/items/BU1"]);
    assert(detail.includes("Bulk Save BU1"), "back: the item detail page rendered");

    const backBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Go back",
    );
    assert(!!backBtn, "back: the detail page has a back button");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    const afterEsc = await readMounted();
    assert(!afterEsc.includes("Bulk Save BU1"), "back: Escape leaves the detail page");
    assert(
      afterEsc.includes("customers / suppliers"),
      `back: Escape returns to where we CAME FROM (parties), not the items list — landed on ${JSON.stringify(afterEsc.slice(0, 120))}`,
    );

    // Backspace is the other habit, and must behave identically.
    const detail2 = await renderRoute(["/parties", "/items/BU1"]);
    assert(detail2.includes("Bulk Save BU1"), "back: mounted the detail page again");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    });
    const afterBksp = await readMounted();
    assert(!afterBksp.includes("Bulk Save BU1"), "back: Backspace goes back too");

    // Typing must be untouchable: Backspace in a text box deletes a
    // character, it does not leave the page.
    const detail3 = await renderRoute(["/parties", "/items/BU1"]);
    const anyInput = document.querySelector("input") as HTMLInputElement | null;
    if (anyInput) {
      await act(async () => {
        anyInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
      });
      const afterTyping = await readMounted();
      assert(
        afterTyping.includes("Bulk Save BU1"),
        "back: Backspace while typing does NOT navigate",
      );
    } else {
      assert(detail3.length > 0, "back: (no input on the detail page to test typing with)");
    }

    // A key the shortcut must not clIBELL.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    const afterOrdinary = await readMounted();
    assert(afterOrdinary.includes("Bulk Save BU1"), "back: an ordinary key does nothing");
  }

  /* ── Category suggests what already exists, and still takes a new one ──
     Three spellings of one shelf ("Charger", "charger", "Chargers") is what a
     free-text box produces, and it makes the category filter meaningless. */
  {
    ItemRepo.add({
      id: "CAT1",
      createdAt: "2026-01-01T00:00:00Z",
      name: "Category Probe Item",
      unit: "pcs",
      gstRate: 18,
      purchasePrice: 10,
      salePrice: 20,
      stock: 1,
      openingStock: 1,
      category: "Chargers",
    } as never);

    const h = document.createElement("div");
    document.body.appendChild(h);
    const r = createRoot(h);
    await act(async () => {
      r.render(<BulkUpdateItemsDialog open onOpenChange={() => {}} onSaved={() => {}} />);
    });
    await settleMs(80);
    const infoTab = Array.from(document.querySelectorAll('[role="radio"]')).find((b) =>
      (b.textContent ?? "").trim().startsWith("Item Information"),
    ) as HTMLButtonElement;
    await act(async () => {
      infoTab.click();
    });
    await settleMs(60);
    const search = document.querySelector('input[placeholder="Search items…"]') as HTMLInputElement;
    await act(async () => {
      setInput(search, "Category Probe Item");
    });
    await settleMs(80);

    const catCell = document.querySelector(
      'input[aria-label="category for Category Probe Item"]',
    ) as HTMLInputElement | null;
    assert(!!catCell, "category: the grid cell is a picker");
    if (catCell) {
      await act(async () => {
        catCell.focus();
      });
      await settleMs(60);
      const listbox = document.querySelector('[role="listbox"]');
      assert(!!listbox, "category: focusing opens the list of existing categories");
      assert(
        (listbox?.textContent ?? "").includes("Chargers"),
        `category: an existing category is offered — saw ${JSON.stringify(listbox?.textContent)}`,
      );

      // A value nobody has used yet is offered as an explicit "add", so a new
      // shelf is possible without the box quietly inviting duplicates.
      await act(async () => {
        setInput(catCell, "Screen Guard");
      });
      await settleMs(60);
      const addRow = document.querySelector('[role="listbox"]')?.textContent ?? "";
      assert(
        addRow.includes("Add") && addRow.includes("Screen Guard"),
        `category: a brand new value can be added — saw ${JSON.stringify(addRow)}`,
      );

      // Typing something that ALREADY exists must not offer to add it again.
      await act(async () => {
        setInput(catCell, "Chargers");
      });
      await settleMs(60);
      assert(
        !(document.querySelector('[role="listbox"]')?.textContent ?? "").includes("Add"),
        "category: an existing value is not offered as a new one",
      );
    }
    r.unmount();
    h.remove();
  }

  /* ── The bulk ledger download is the SAME document as the party page's ──
     Selecting parties and downloading produced a cut-down six-column PDF with
     no item breakdown, while opening one party and downloading gave the full
     nine-column statement. Same words on the button, visibly different file.
     This pins the printable statement against the columns the party page
     actually shows, so the two cannot drift apart again. */
  {
    const statementParty = PartyRepo.get("P1")!;
    const built = buildPartyStatement(statementParty, {
      sales: SalesRepo.all(),
      purchases: PurchaseRepo.all(),
      saleReturns: SaleReturnRepo.all(),
      purchaseReturns: PurchaseReturnRepo.all(),
      payments: PaymentRepo.all(),
    });

    const h = document.createElement("div");
    document.body.appendChild(h);
    const r = createRoot(h);
    await act(async () => {
      r.render(
        <PrintablePartyStatement
          party={statementParty}
          rows={built.rows}
          company={CompanyRepo.get()}
          periodLabel="All transactions"
          format="full"
        />,
      );
    });
    await settleMs(60);
    const text = h.textContent ?? "";

    // Every column the statement page shows, by name.
    for (const col of [
      "Date",
      "Txn Type",
      "Ref No.",
      "Payment Status",
      "Total",
      "Received/Paid",
      "Txn Balance",
      "Receivable Balance",
      "Payable Balance",
    ]) {
      assert(text.includes(col), `bulk ledger: the full PDF has the "${col}" column`);
    }
    // And the per-transaction item breakdown, which was missing entirely.
    assert(
      text.includes("Item name") && text.includes("Price/Unit") && text.includes("Sub Total"),
      "bulk ledger: the full PDF breaks each bill down by item",
    );
    assert(
      text.includes("USB Cable"),
      `bulk ledger: a real line item reaches the page — ${JSON.stringify(text.slice(0, 200))}`,
    );
    // The numbers are the statement's own, not recomputed.
    const closing = built.rows.length ? built.rows[built.rows.length - 1].balance : 0;
    assert(
      text.includes(fmtMoney(Math.abs(closing))),
      `bulk ledger: it closes on the statement's balance ${fmtMoney(Math.abs(closing))}`,
    );

    // The simple format stays the plain six-column ledger.
    await act(async () => {
      r.render(
        <PrintablePartyStatement
          party={statementParty}
          rows={built.rows}
          company={CompanyRepo.get()}
          periodLabel="All transactions"
          format="simple"
        />,
      );
    });
    await settleMs(60);
    const simple = h.textContent ?? "";
    assert(
      simple.includes("Particulars") && simple.includes("Credit") && simple.includes("Debit"),
      "bulk ledger: the simple format is the plain Credit/Debit ledger",
    );
    assert(
      !simple.includes("Payment Status"),
      "bulk ledger: and does NOT carry the full statement's columns",
    );
    r.unmount();
    h.remove();
  }

  /* ── Transfers: cash → bank, bank → cash, bank → bank ─────────────────
     Modelled on Vyapar, which the client already knows: one FROM and one TO,
     and the three transfers are the same action with different endpoints.
     Money leaving one account and never arriving at the other is the single
     outcome here that silently costs the shop money, so both legs go on one
     batch — and the bank-to-bank case is the one the first version could not
     do at all. */
  {
    for (const [id, name, balance] of [
      ["TB1", "Transfer Test Bank", 5000],
      ["TB2", "Second Test Bank", 800],
    ] as const) {
      BankRepo.add({
        id,
        createdAt: "2026-01-01T00:00:00Z",
        name,
        openingBalance: 0,
        balance,
      } as never);
    }

    const cashNow = () =>
      cashFlows(
        SalesRepo.all(),
        PurchaseRepo.all(),
        ExpenseRepo.all(),
        PaymentRepo.all(),
        CashAdjustmentRepo.all(),
      ).reduce((s, e) => s + e.in - e.out, 0);

    const h = document.createElement("div");
    document.body.appendChild(h);
    const r = createRoot(h);
    await act(async () => {
      r.render(<CashBankTransferDialog open onOpenChange={() => {}} onSaved={() => {}} />);
    });
    await settleMs(80);

    const dlg = document.querySelector('[role="dialog"]')!;
    assert((dlg.textContent ?? "").includes("Transfer Money"), "transfer: the dialog rendered");

    // The two ends and the swap between them are one row, so they have to
    // line up. The balance used to hang UNDER each field as loose text, which
    // left the columns different heights and pushed the swap button out of
    // line with the fields it sits between.
    {
      const fromBtn = dlg.querySelector(
        '[role="combobox"][aria-label="From account"]',
      ) as HTMLElement;
      const toBtn = dlg.querySelector('[role="combobox"][aria-label="To account"]') as HTMLElement;
      const swapBtn = dlg.querySelector('[aria-label="Swap accounts"]') as HTMLElement;
      assert(!!fromBtn && !!toBtn && !!swapBtn, "transfer: found both fields and the swap button");
      if (fromBtn && toBtn && swapBtn) {
        const f = fromBtn.getBoundingClientRect();
        const t = toBtn.getBoundingClientRect();
        const w = swapBtn.getBoundingClientRect();
        assert(
          Math.abs(f.top - t.top) < 1 && Math.abs(f.height - t.height) < 1,
          `transfer: the two account fields line up — From ${Math.round(f.top)}/${Math.round(
            f.height,
          )}, To ${Math.round(t.top)}/${Math.round(t.height)}`,
        );
        assert(
          Math.abs(f.top - w.top) < 1 && Math.abs(f.height - w.height) < 1,
          `transfer: and the swap button lines up with them — swap ${Math.round(
            w.top,
          )}/${Math.round(w.height)} vs field ${Math.round(f.top)}/${Math.round(f.height)}`,
        );
        // The balance reads inside the field it belongs to, not beside it.
        assert(
          (fromBtn.textContent ?? "").includes("₹"),
          `transfer: each field shows its own balance — ${JSON.stringify(fromBtn.textContent)}`,
        );
      }
    }

    /** Choose an account on one side of the transfer. */
    const pick = async (side: "From" | "To", accountName: string) => {
      const btn = dlg.querySelector(
        `[role="combobox"][aria-label="${side} account"]`,
      ) as HTMLButtonElement | null;
      assert(!!btn, `transfer: found the ${side} picker`);
      if (!btn) return;
      await act(async () => {
        btn.click();
      });
      await settleMs(50);
      const list = dlg.querySelector(`[role="listbox"][aria-label="${side} accounts"]`);
      assert(!!list, `transfer: the ${side} list opens as the app's own popup`);
      const option = Array.from(list?.querySelectorAll('[role="option"]') ?? []).find((o) =>
        (o.textContent ?? "").includes(accountName),
      );
      assert(!!option, `transfer: ${accountName} is offered under ${side}`);
      await act(async () => {
        option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      await settleMs(50);
      assert(
        (btn.textContent ?? "").includes(accountName),
        `transfer: ${side} now reads ${accountName} — got ${JSON.stringify(btn.textContent)}`,
      );
    };

    const enterAndSend = async (n: string) => {
      const box = dlg.querySelector(
        'input[aria-label="Transfer amount"]',
      ) as HTMLInputElement | null;
      assert(!!box, "transfer: found the amount box");
      await act(async () => {
        setInput(box, n);
      });
      await settleMs(50);
      const go = Array.from(dlg.querySelectorAll("button")).find(
        (b) => (b.textContent ?? "").trim() === "Transfer",
      );
      assert(!!go, "transfer: found the Transfer button");
      await act(async () => {
        go?.click();
      });
      await settleMs(200);
    };

    /* 1. Cash → Bank. Both sides must move, by the same amount. */
    const cashBefore = cashNow();
    // TO first, always: the picker refuses the account already chosen on
    // the other side, so setting From to what is currently To is a no-op.
    await pick("To", "Transfer Test Bank");
    await pick("From", "Cash in Hand");
    await enterAndSend("1500");
    assert(
      BankRepo.get("TB1")?.balance === 6500,
      `transfer: cash→bank raises the account — ${BankRepo.get("TB1")?.balance} (want 6500)`,
    );
    assert(
      Math.abs(cashNow() - (cashBefore - 1500)) < 0.01,
      `transfer: and lowers the drawer by the same — ${cashNow()} (want ${cashBefore - 1500})`,
    );

    /* 2. Bank → Bank: the case that previously had to be done as a manual
          withdrawal plus a manual deposit, with nothing tying them together. */
    const cashUntouched = cashNow();
    await pick("To", "Second Test Bank");
    await pick("From", "Transfer Test Bank");
    await enterAndSend("500");
    assert(
      BankRepo.get("TB1")?.balance === 6000 && BankRepo.get("TB2")?.balance === 1300,
      `transfer: bank→bank moves between the two — TB1 ${BankRepo.get("TB1")?.balance} (want 6000), TB2 ${BankRepo.get("TB2")?.balance} (want 1300)`,
    );
    assert(
      Math.abs(cashNow() - cashUntouched) < 0.01,
      "transfer: bank→bank leaves the cash drawer alone",
    );
    // One record on each account, and the note says where the money went.
    const legs = BankTxnRepo.all().filter((t) => (t.notes ?? "").includes("Second Test Bank"));
    assert(
      legs.length === 2 &&
        legs.some((t) => t.bankId === "TB1" && t.type === "withdraw") &&
        legs.some((t) => t.bankId === "TB2" && t.type === "deposit"),
      `transfer: bank→bank writes both legs — ${JSON.stringify(legs.map((t) => `${t.bankId}:${t.type}:${t.amount}`))}`,
    );

    /* 3. Bank → Cash, the other direction of the pair. */
    const cashBefore3 = cashNow();
    await pick("To", "Cash in Hand");
    await pick("From", "Second Test Bank");
    await enterAndSend("300");
    assert(
      BankRepo.get("TB2")?.balance === 1000,
      `transfer: bank→cash lowers the account — ${BankRepo.get("TB2")?.balance} (want 1000)`,
    );
    assert(
      Math.abs(cashNow() - (cashBefore3 + 300)) < 0.01,
      `transfer: and raises the drawer — ${cashNow()} (want ${cashBefore3 + 300})`,
    );

    /* 4. The same account on both sides is not a transfer. After step 3 the
          TO side is Cash, so Cash must be visible but unselectable in the
          FROM list — offered, so you can see why it is out, rather than
          silently missing. */
    const fromBtn = dlg.querySelector(
      '[role="combobox"][aria-label="From account"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fromBtn.click();
    });
    await settleMs(50);
    const cashOption = Array.from(
      dlg.querySelectorAll('[role="listbox"][aria-label="From accounts"] [role="option"]') ?? [],
    ).find((o) => (o.textContent ?? "").includes("Cash in Hand"));
    assert(!!cashOption, "transfer: the other side's account is still listed");
    assert(
      cashOption?.getAttribute("aria-disabled") === "true",
      "transfer: the account already chosen on the other side cannot be picked",
    );
    await act(async () => {
      cashOption?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await settleMs(50);
    assert(
      (fromBtn.textContent ?? "").includes("Second Test Bank"),
      `transfer: and clicking it changes nothing — From reads ${JSON.stringify(fromBtn.textContent)}`,
    );

    r.unmount();
    h.remove();
  }

  /* ── Backspace walks back along a bill line ───────────────────────────
     Billing runs left to right — item, qty, unit, price — and the only way
     back was the mouse. Clearing a box and pressing Backspace again is what a
     person already does on realising they are in the wrong one; each step
     must land on the previous field with its contents selected, and stepping
     back off the front of the line reopens the item picker. */
  {
    await renderRoute("/sales/new");

    // Add a line by picking an item from the entry row.
    const addRow = document.querySelector(
      'input[placeholder="Type item name to add…"]',
    ) as HTMLInputElement | null;
    assert(!!addRow, "step back: found the item entry row");
    if (addRow) {
      await act(async () => {
        setInput(addRow, "USB Cable");
      });
      await settleMs(80);
      await act(async () => {
        addRow.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await settleMs(120);
    }

    const row = document.querySelector("tbody tr") as HTMLTableRowElement | null;
    assert(!!row, "step back: a bill line was added");
    if (row) {
      const fields = Array.from(row.querySelectorAll("input")) as HTMLInputElement[];
      assert(
        fields.length >= 2,
        `step back: the line has editable fields — found ${fields.length}`,
      );
      const [qty, ...rest] = fields;
      const price = rest[rest.length - 1] ?? rest[0];

      // From a LATER field back to an earlier one: clear it, then Backspace.
      await act(async () => {
        price.focus();
        setInput(price, "");
      });
      await settleMs(40);
      await act(async () => {
        price.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
      });
      await settleMs(40);
      assert(document.activeElement !== price, "step back: Backspace in an empty box moves off it");
      assert(
        row.contains(document.activeElement),
        "step back: and lands on another field in the SAME line, never another row",
      );

      // A box with something in it must still just delete a character.
      await act(async () => {
        qty.focus();
        setInput(qty, "5");
      });
      await settleMs(40);
      await act(async () => {
        qty.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
      });
      await settleMs(40);
      assert(
        document.activeElement === qty,
        "step back: Backspace with text in the box deletes, it does not navigate",
      );

      // Off the front of the line: the item picker comes back.
      await act(async () => {
        qty.focus();
        setInput(qty, "");
      });
      await settleMs(40);
      await act(async () => {
        qty.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
      });
      await settleMs(80);
      assert(
        !!row.querySelector('input[placeholder="Type to change item…"]'),
        "step back: stepping off the front of the line reopens the item picker",
      );
    }
  }

  /* ── Escape closes what is open, and only then leaves ─────────────────
     Escape was wired straight to "navigate away", so closing the item picker
     with it ALSO threw the whole bill away. */
  {
    // Arrive THROUGH the sales list, so there is somewhere to go back to.
    // With a single-entry history the app-wide Escape bails on its own and
    // this could never tell whether the form actually clIBELLed the key.
    await renderRoute(["/sales", "/sales/new"]);

    // Put something on the bill so leaving would cost work.
    const addRow2 = document.querySelector(
      'input[placeholder="Type item name to add…"]',
    ) as HTMLInputElement | null;
    if (addRow2) {
      await act(async () => {
        setInput(addRow2, "USB Cable");
      });
      await settleMs(80);
      await act(async () => {
        addRow2.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await settleMs(120);
    }
    assert(
      !!document.querySelector("tbody tr"),
      "escape: the bill has a line on it before we press Escape",
    );

    // Open the item picker on that line, then press Escape inside it.
    const nameCell = document.querySelector(
      'tbody tr [role="button"][tabindex]',
    ) as HTMLElement | null;
    assert(!!nameCell, "escape: found the item name cell");
    if (nameCell) {
      await act(async () => {
        nameCell.click();
      });
      await settleMs(80);
      const picker = document.querySelector(
        'input[placeholder="Type to change item…"]',
      ) as HTMLInputElement | null;
      assert(!!picker, "escape: the item picker opened");
      if (picker) {
        await act(async () => {
          picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        await settleMs(120);
        assert(
          !document.querySelector('input[placeholder="Type to change item…"]'),
          "escape: closes the picker",
        );
        // The whole point: the bill is still here.
        assert(
          !!document.querySelector("tbody tr"),
          "escape: and does NOT throw the bill away behind it",
        );
      }
    }
    /* On a form, Escape belongs to the FORM, not to the app-wide "go back".
       Both are window listeners and the app-wide one is registered first, so
       without an explicit clIBELL it would win the race and leave the page
       before the form could ask about the unsaved bill. */
    {
      let asked = 0;
      const realConfirm = window.confirm;
      window.confirm = () => {
        asked++;
        return false; // "no, stay here"
      };
      try {
        await act(async () => {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        await settleMs(80);
        assert(
          asked === 1,
          `escape on a form: the form asks about the unsaved bill — asked ${asked} times`,
        );
        assert(
          !!document.querySelector('input[placeholder="Type item name to add…"]'),
          "escape on a form: declining keeps us on the BILL (not the list, which also has rows)",
        );
      } finally {
        window.confirm = realConfirm;
      }
    }
  }

  /* ── The page-level Escape guard, on its own ──────────────────────────
     The bill test above proves the picker keeps Escape to itself. This proves
     the OTHER half — that the page listener also refuses an Escape something
     nearer already handled. Both layers are needed: relying on the popup to
     call stopPropagation means one picker written without it silently gets
     "Escape throws the invoice away" back, and that is exactly how this bug
     existed in the first place. */
  {
    // Land on a page with no unsaved form first: the previously mounted
    // route stays in the DOM, and a dirty bill form left there would answer
    // this Escape with its own confirm() before the probe ever sees it.
    await renderRoute("/items");
    let left = 0;
    let dirty = false;
    function EscProbe() {
      useEscapeToLeave(
        () => {
          left++;
        },
        () => dirty,
      );
      return <input aria-label="esc probe" />;
    }
    const h = document.createElement("div");
    document.body.appendChild(h);
    const r = createRoot(h);
    await act(async () => {
      r.render(<EscProbe />);
    });
    await settleMs(40);

    const press = async (init?: KeyboardEventInit & { handled?: boolean }) => {
      const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      if (init?.handled) ev.preventDefault();
      await act(async () => {
        window.dispatchEvent(ev);
      });
      await settleMs(20);
    };

    await press();
    assert(left === 1, `escape guard: a clean Escape leaves the page — fired ${left}`);

    // Already handled by something nearer the keyboard.
    await press({ handled: true });
    assert(left === 1, `escape guard: an Escape a popup already handled is ignored — ${left}`);

    // A dialog owns Escape while it is open.
    const fake = document.createElement("div");
    fake.setAttribute("role", "dialog");
    document.body.appendChild(fake);
    await press();
    assert(left === 1, `escape guard: an open dialog keeps Escape to itself — ${left}`);
    fake.remove();

    // Unsaved work asks first, and "cancel" means stay.
    dirty = true;
    const realConfirm = window.confirm;
    window.confirm = () => false;
    await press();
    assert(left === 1, `escape guard: declining the prompt stays on the page — ${left}`);
    window.confirm = () => true;
    await press();
    assert(left === 2, `escape guard: accepting it leaves — ${left}`);
    window.confirm = realConfirm;

    r.unmount();
    h.remove();
  }

  /* ── Escape closes the screen on EVERY page, not just detail pages ────
     It used to be wired to the back chevron, so the same key did something on
     a bill and nothing at all on the Items list. One key, one meaning. */
  {
    // A list page — no back chevron anywhere on it, by the client's own
    // instruction, yet Escape must still step back.
    const list = await renderRoute(["/parties", "/items"]);
    assert(list.includes("Items"), "escape anywhere: the items list mounted");
    assert(
      !Array.from(document.querySelectorAll("button")).some(
        (b) => b.getAttribute("aria-label") === "Go back",
      ),
      "escape anywhere: the list has no back button (main pages must not grow one)",
    );
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    const after = await readMounted();
    assert(
      after.includes("customers / suppliers"),
      `escape anywhere: Escape still goes back from a list — landed on ${JSON.stringify(
        after.slice(0, 90),
      )}`,
    );

    // Nothing behind the page: Escape must do nothing rather than try to
    // close the tab, which a page cannot do and should not attempt on a till.
    const alone = await renderRoute("/items");
    assert(alone.includes("Items"), "escape anywhere: mounted with no history behind it");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    const stillThere = await readMounted();
    assert(
      stillThere.includes("Items"),
      "escape anywhere: with nowhere to go back to, Escape leaves the page alone",
    );

    // And it stays out of the way while someone is typing.
    const back2 = await renderRoute(["/parties", "/items"]);
    assert(back2.includes("Items"), "escape anywhere: mounted again for the typing check");
    const search = document.querySelector(
      'input[placeholder*="Search"]',
    ) as HTMLInputElement | null;
    if (search) {
      await act(async () => {
        search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      const typed = await readMounted();
      assert(
        typed.includes("Items"),
        "escape anywhere: Escape in a search box does not leave the page",
      );
    }
  }

  /* ── Escape closes the open TAB ───────────────────────────────────────
     The app keeps its own Chrome-style tab strip, so "close this screen"
     means that tab — the same thing its × does — and you land on the tab
     that takes its place rather than wherever browser history happened to
     be. Escape used to step back through history instead, which left the
     tab sitting in the strip after the screen behind it had changed. */
  {
    const restore = useWorkspace.getState();
    try {
      useWorkspace.setState({
        tabs: [
          { id: "/parties", title: "Parties", path: "/parties" },
          { id: "/items/BU1", title: "Bulk Save BU1", path: "/items/BU1" },
        ],
        activeId: "/items/BU1",
      });
      const detail = await renderRoute(["/parties", "/items/BU1"]);
      assert(detail.includes("Bulk Save BU1"), "esc tab: the detail page is open");

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      const after = await readMounted();

      const left = useWorkspace.getState().tabs.map((t) => t.id);
      assert(
        !left.includes("/items/BU1"),
        `esc tab: the tab is actually closed — strip still holds ${JSON.stringify(left)}`,
      );
      assert(left.includes("/parties"), "esc tab: the other tab is left alone");
      assert(
        useWorkspace.getState().activeId === "/parties",
        `esc tab: the neighbouring tab becomes active — got ${useWorkspace.getState().activeId}`,
      );
      assert(
        after.includes("customers / suppliers"),
        `esc tab: and the screen follows it — landed on ${JSON.stringify(after.slice(0, 90))}`,
      );

      // Three tabs, closing the FIRST one: you land on the tab that takes
      // its slot, not on the far end of the strip. With only two tabs open
      // those two rules give the same answer, so this needs three.
      useWorkspace.setState({
        tabs: [
          { id: "/parties", title: "Parties", path: "/parties" },
          { id: "/items", title: "Items", path: "/items" },
          { id: "/payments", title: "Payments", path: "/payments" },
        ],
        activeId: "/parties",
      });
      const adjacent = useWorkspace.getState().closeTabAndNext("/parties", "/parties");
      assert(
        adjacent === "/items",
        `esc tab: you land on the neighbouring tab, not the last one — got ${adjacent}`,
      );

      // Closing the LAST tab has nowhere to go but the dashboard, and must
      // never leave the strip pointing at a tab that is gone.
      useWorkspace.setState({
        tabs: [{ id: "/items", title: "Items", path: "/items" }],
        activeId: "/items",
      });
      const only = useWorkspace.getState().closeTabAndNext("/items", "/items");
      assert(only === "/", `esc tab: closing the last tab goes to the dashboard — got ${only}`);
      assert(
        useWorkspace.getState().tabs.length === 0 && useWorkspace.getState().activeId === null,
        "esc tab: and the strip is left empty, not pointing at a closed tab",
      );

      // Closing a tab you are NOT looking at must not move you.
      useWorkspace.setState({
        tabs: [
          { id: "/parties", title: "Parties", path: "/parties" },
          { id: "/items", title: "Items", path: "/items" },
        ],
        activeId: "/items",
      });
      const stay = useWorkspace.getState().closeTabAndNext("/parties", "/items");
      assert(stay === null, `esc tab: closing a background tab stays put — got ${stay}`);
      assert(
        useWorkspace.getState().activeId === "/items",
        "esc tab: and the screen you were on is still the active one",
      );
    } finally {
      useWorkspace.setState({ tabs: restore.tabs, activeId: restore.activeId });
    }
  }

  /* ── A party is receivable OR payable, never both ─────────────────────
     The payment dialogs worked out their outstanding one side at a time —
     sales for a receipt, purchases for a payment — and an opening balance is
     counted by both. So a party carrying ₹2,000 was offered as ₹2,000
     RECEIVABLE on Receive Payment and ₹2,000 PAYABLE on Make Payment: the
     same money, twice, in opposite directions. */
  {
    PartyRepo.add({
      id: "OB1",
      createdAt: "2026-01-01T00:00:00Z",
      name: "Opening Only Customer",
      type: "customer",
      openingBalance: 2000, // they owe us, and there are no invoices at all
    } as never);

    const openDialog = async (which: "Receive Payment" | "Make Payment") => {
      await renderRoute("/payments");
      const btn = findButton(new RegExp(which));
      assert(!!btn, `two-sided: found the ${which} button`);
      await act(async () => {
        btn?.click();
      });
      await settleMs(120);
      const box = document.querySelector(
        'input[placeholder="Type to search party…"]',
      ) as HTMLInputElement | null;
      assert(!!box, "two-sided: found the party box");
      if (!box) return "";
      await act(async () => {
        setInput(box, "Opening Only");
      });
      await settleMs(80);
      const option = Array.from(document.querySelectorAll("div"))
        .filter((d) => d.textContent === "Opening Only Customer")
        .pop();
      assert(!!option, `two-sided: the party is suggested on ${which}`);
      await act(async () => {
        option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      await settleMs(120);
      return currentDialog().textContent ?? "";
    };

    const received = await openDialog("Receive Payment");
    assert(
      received.includes(fmtMoney(2000)),
      `two-sided: a receivable opening shows on Receive Payment — ${JSON.stringify(received.slice(0, 140))}`,
    );

    const paid = await openDialog("Make Payment");
    assert(
      !paid.includes(fmtMoney(2000)),
      `two-sided: and NOT as a payable on Make Payment — ${JSON.stringify(paid.slice(0, 160))}`,
    );
    assert(
      paid.includes(fmtMoney(0)),
      "two-sided: Make Payment shows nothing outstanding for a party who owes US",
    );
  }

  /* ── Opening balance: the side is a choice, not the sign of a number ──
     It used to be read back off the sign, so on a NEW party — amount 0 —
     picking "payable" stored -0, and -0 < 0 is false: the button lit up
     green again the instant it was clicked and the choice appeared to do
     nothing at all. */
  {
    const h = document.createElement("div");
    document.body.appendChild(h);
    const r = createRoot(h);
    await act(async () => {
      r.render(<PartyDialog open onOpenChange={() => {}} party={null} onSaved={() => {}} />);
    });
    await settleMs(80);
    const dlg = currentDialog();

    const sideBtn = (name: string) =>
      Array.from(
        dlg.querySelectorAll(
          '[role="radiogroup"][aria-label="Opening balance side"] [role="radio"]',
        ),
      ).find((b) => (b.textContent ?? "").trim() === name) as HTMLButtonElement | undefined;

    assert(!!sideBtn("Receivable"), "opening: the sides are named Receivable…");
    assert(!!sideBtn("Payable"), "opening: …and Payable, the words used everywhere else");
    assert(
      !dlg.textContent?.includes("They owe me") && !dlg.textContent?.includes("I owe them"),
      "opening: the conversational wording is gone",
    );

    // The choice must stick with the amount still empty — the case that broke.
    await act(async () => {
      sideBtn("Payable")?.click();
    });
    await settleMs(50);
    assert(
      sideBtn("Payable")?.getAttribute("aria-checked") === "true",
      "opening: Payable can be chosen BEFORE any amount is typed",
    );
    assert(
      sideBtn("Receivable")?.getAttribute("aria-checked") === "false",
      "opening: and choosing one clears the other",
    );

    // Typing now follows the side that was chosen.
    const amt = dlg.querySelector(
      'input[aria-label="Opening balance amount"]',
    ) as HTMLInputElement | null;
    assert(!!amt, "opening: found the amount box");
    await act(async () => {
      setInput(amt, "750");
    });
    await settleMs(50);
    assert(
      (dlg.textContent ?? "").includes("Payable"),
      "opening: 750 entered under Payable reads back as payable",
    );

    // And switching sides re-signs what is already there.
    await act(async () => {
      sideBtn("Receivable")?.click();
    });
    await settleMs(50);
    assert(
      sideBtn("Receivable")?.getAttribute("aria-checked") === "true" &&
        (amt?.value ?? "") === "750",
      `opening: switching side keeps the amount — ${JSON.stringify(amt?.value)}`,
    );
    r.unmount();
    h.remove();
  }

  /* ── Rows per page: 500 by default, changed once, remembered ──────────
     1,400 items at 50 a page meant paging to find something, or reading a
     total off one page and believing it was the whole list. */
  {
    const KEY = "bz.pageSize.items";
    window.localStorage.removeItem(KEY);

    /** The rows-per-page control, which is the app's own dropdown rather than
     *  a native <select> — the OS popup ignored every colour and radius on
     *  the page, and this bar sits at the bottom where it opened over the
     *  content in its own grey and blue. */
    const perPage = () =>
      document.querySelector(
        '[role="combobox"][aria-label="Rows per page"]',
      ) as HTMLButtonElement | null;

    const list = await renderRoute("/items");
    assert(list.includes("Items"), "page size: the items list mounted");
    assert(
      !document.querySelector("select"),
      "page size: the per-page control is not a native select",
    );
    assert(!!perPage(), "page size: found the per-page control");
    assert(
      (perPage()?.textContent ?? "").includes("500"),
      `page size: and starts at 500 — reads ${JSON.stringify(perPage()?.textContent)}`,
    );

    // Open it: the choices reach past the default in both directions.
    await act(async () => {
      perPage()?.click();
    });
    await settleMs(60);
    const menu = document.querySelector('[role="listbox"][aria-label="Rows per page"]');
    assert(!!menu, "page size: the list opens as the app's own popup");
    const labels = Array.from(menu?.querySelectorAll('[role="option"]') ?? []).map((o) =>
      (o.textContent ?? "").trim(),
    );
    assert(
      labels.includes("25") && labels.includes("1000"),
      `page size: the choices span 25 to 1000 — got ${JSON.stringify(labels)}`,
    );

    // Pick one, and it is written down.
    const twentyFive = Array.from(menu?.querySelectorAll('[role="option"]') ?? []).find(
      (o) => (o.textContent ?? "").trim() === "25",
    );
    await act(async () => {
      twentyFive?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await settleMs(60);
    assert(
      window.localStorage.getItem(KEY) === "25",
      `page size: the choice is saved — stored ${JSON.stringify(window.localStorage.getItem(KEY))}`,
    );

    // Leave, come back: still 25. This is a preference, not a detail of one
    // visit, so it has to survive a reload — hence localStorage, not memory.
    await renderRoute("/parties");
    await renderRoute("/items");
    assert(
      (perPage()?.textContent ?? "").includes("25"),
      `page size: and is still there on return — reads ${JSON.stringify(perPage()?.textContent)}`,
    );

    // Per screen, not one global setting: Parties keeps its own.
    window.localStorage.removeItem(KEY);
    assert(
      window.localStorage.getItem("bz.pageSize.parties") !== "25",
      "page size: changing Items did not change Parties",
    );
  }

  /* ── Cash rows get the action that is safe for them ───────────────────
     Cash in hand is DERIVED. A manual adjustment is the only row that owns
     itself; every other line is the cash side of a bill, an expense or a
     payment, where "editing the cash" would mean editing that document while
     leaving it saying something else. */
  {
    CashAdjustmentRepo.add({
      id: "CA1",
      createdAt: "2026-01-01T00:00:00Z",
      date: D2,
      type: "add",
      amount: 700,
      reason: "Counter float",
    } as never);

    const page = await renderRoute("/cash");
    assert(page.includes("Counter float"), "cash rows: the manual entry is listed");
    // Short dates, so the Action column is not pushed off the right edge.
    assert(
      /\d{2}-\d{2}-\d{2}/.test(page),
      `cash rows: dates are the short dd-mm-yy form — ${JSON.stringify(page.slice(0, 90))}`,
    );

    const table = document.querySelector(".data-table table") as HTMLTableElement | null;
    assert(!!table, "cash rows: found the table");
    const headers = Array.from(table?.querySelectorAll("thead th") ?? []).map((th) =>
      (th.textContent ?? "").trim(),
    );
    assert(headers.includes("Action"), `cash rows: there is an Action column — ${headers}`);

    // The Action column is PINNED, so it stays put however far the rest of a
    // wide table scrolls sideways.
    // Measure a BODY cell, not the header. The header row is sticky in its
    // own right — it stays put while you scroll DOWN — so asking a <th> about
    // position answers a different question and says nothing about whether
    // the COLUMN is pinned. This assertion passed a mutation because of it.
    const lastTd = table?.querySelector("tbody tr td:last-child") as HTMLElement | null;
    const tdStyle = lastTd && getComputedStyle(lastTd);
    assert(
      tdStyle?.position === "sticky" && tdStyle?.right === "0px",
      `cash rows: the Action column is pinned to the right — position ${tdStyle?.position}, right ${tdStyle?.right}`,
    );

    // The manual row can be edited and deleted; a derived row cannot.
    const rowFor = (text: string) =>
      Array.from(table?.querySelectorAll("tbody tr") ?? []).find((tr) =>
        (tr.textContent ?? "").includes(text),
      );
    const manual = rowFor("Counter float");
    assert(!!manual, "cash rows: found the manual row");
    /* Dated earlier this month, so the destructive action is Void, not
       Delete — its month has already been counted. The button says what it
       will actually do; "Delete" on a control that cannot delete is the kind
       of small lie that stops people trusting a screen. */
    assert(
      !!manual?.querySelector('[title="Edit entry"]') &&
        !!manual?.querySelector('[title="Void entry"]'),
      `cash rows: an older manual entry offers Edit and Void — ${Array.from(
        manual?.querySelectorAll("[title]") ?? [],
      )
        .map((el) => el.getAttribute("title"))
        .join(" / ")}`,
    );
    assert(
      !manual?.querySelector('[title="Delete entry"]'),
      "cash rows: and does NOT offer to delete something that has been counted",
    );

    const derived = Array.from(table?.querySelectorAll("tbody tr") ?? []).find((tr) =>
      (tr.textContent ?? "").includes("INV-0001"),
    );
    if (derived) {
      assert(
        !derived.querySelector('[title="Edit entry"]'),
        "cash rows: a row that belongs to a bill is NOT editable here",
      );
      assert(
        !!derived.querySelector('[title*="open it to change it"]'),
        "cash rows: it offers to open the bill instead",
      );
    }

    /* Voiding it moves cash-in-hand by exactly its amount — the same as a
       delete would — while the entry itself stays on file. Both halves
       matter: the money has to be right, and the record has to survive. */
    const cashNow = () =>
      cashFlows(
        SalesRepo.all(),
        PurchaseRepo.all(),
        ExpenseRepo.all(),
        PaymentRepo.all(),
        CashAdjustmentRepo.all(),
      ).reduce((s, e) => s + e.in - e.out, 0);
    const cashBefore = cashNow();

    await act(async () => {
      (manual?.querySelector('[title="Void entry"]') as HTMLElement)?.click();
    });
    await settleMs(150);

    /* A reason is required. Voiding without one would leave "why is this
       entry cancelled" unanswerable, which is the question somebody asks six
       months later and nothing else can answer. */
    const dlg = currentDialog();
    assert(
      (dlg.textContent ?? "").includes("Void this cash entry"),
      `cash rows: the void dialog opens — ${JSON.stringify(dlg.textContent?.slice(0, 80))}`,
    );
    const confirmBtn = Array.from(dlg.querySelectorAll("button")).find((b) =>
      /^Void this cash entry$/.test((b.textContent ?? "").trim()),
    ) as HTMLButtonElement | undefined;
    assert(!!confirmBtn, "cash rows: found the confirm button");
    assert(
      confirmBtn?.disabled === true,
      "cash rows: and it refuses to void until a reason is given",
    );

    const reasonBox = Array.from(dlg.querySelectorAll("input")).find((i) =>
      (i.getAttribute("placeholder") ?? "").startsWith("Entered twice"),
    ) as HTMLInputElement | undefined;
    assert(!!reasonBox, "cash rows: there is somewhere to say why");
    await act(async () => {
      setInput(reasonBox, "Counted twice");
    });
    await settleMs(60);
    await act(async () => {
      confirmBtn?.click();
    });
    await settleMs(200);

    // The record survives, marked, with the reason and the person on it.
    const voided = CashAdjustmentRepo.allWithVoided().find((a) => a.id === "CA1");
    assert(!!voided, "cash rows: the entry is still on file — that is the point");
    assert(!!voided?.voidedAt, "cash rows: marked as voided");
    assert(
      voided?.voidReason === "Counted twice",
      `cash rows: with the reason that was given — ${voided?.voidReason}`,
    );
    assert(!!voided?.voidedBy, "cash rows: and who cancelled it");
    // ...but stops counting, everywhere, without any caller having to
    // remember to filter it.
    assert(
      !CashAdjustmentRepo.all().some((a) => a.id === "CA1"),
      "cash rows: and every ordinary read of the collection skips it",
    );
    assert(
      Math.abs(cashNow() - (cashBefore - 700)) < 0.01,
      `cash rows: cash in hand drops by its amount, exactly as a delete would — ${cashNow()} (want ${cashBefore - 700})`,
    );

    /* And the figure the PAGE prints, with the cancelled row on screen.
       The check above recomputes cash from the repositories — it proves the
       data is right and says nothing about the page, which keeps its own
       running total and could happily add a voided row back into it. */
    await renderRoute("/cash");
    const voidToggle = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Voided",
    ) as HTMLButtonElement | undefined;
    assert(!!voidToggle, "cash rows: there is a way to see cancelled entries");
    await act(async () => {
      voidToggle?.click();
    });
    await settleMs(200);

    const shownCash = await readMounted();
    assert(
      shownCash.includes("Counted twice") || shownCash.includes("Counter float"),
      "cash rows: turning it on brings the cancelled entry back onto the list",
    );
    const foot = document.querySelector(".data-table table tfoot tr");
    const footNum = (idx: number) =>
      Number(
        ((foot?.children[idx]?.textContent ?? "").match(/[\d,.-]+/g) ?? [])
          .pop()
          ?.replace(/,/g, "") ?? "NaN",
      );
    assert(
      Math.abs(footNum(0) - cashNow()) < 0.01,
      `cash rows: the page's own total still ignores the cancelled row it is showing — ${footNum(0)} (want ${cashNow()})`,
    );
  }

  /* ── Deleting one leg of a transfer takes the other with it ───────────
     Half a transfer is money out of one account and never into the other,
     which is the single outcome here that quietly costs the shop money. */
  {
    BankRepo.add({
      id: "XB1",
      createdAt: "2026-01-01T00:00:00Z",
      name: "Transfer Delete Bank",
      openingBalance: 0,
      balance: 2000,
    } as never);
    const transferId = "TR-TEST-1";
    CashAdjustmentRepo.add({
      id: "XCA",
      createdAt: "2026-01-01T00:00:00Z",
      date: D2,
      type: "reduce",
      amount: 400,
      reason: "Transfer Cash in Hand → Transfer Delete Bank",
      transferId,
    } as never);
    BankTxnRepo.add({
      id: "XBT",
      createdAt: "2026-01-01T00:00:00Z",
      bankId: "XB1",
      date: D2,
      type: "deposit",
      amount: 400,
      notes: "Transfer Cash in Hand → Transfer Delete Bank",
      transferId,
    } as never);
    BankRepo.adjustField("XB1", "balance", 400); // as the transfer itself would

    await renderRoute("/cash");
    const table2 = document.querySelector(".data-table table");
    const leg = Array.from(table2?.querySelectorAll("tbody tr") ?? []).find((tr) =>
      (tr.textContent ?? "").includes("Transfer Delete Bank"),
    );
    assert(!!leg, "transfer delete: the cash leg is on the Cash page");
    // A transfer leg cannot be edited on its own — the two ends would disagree.
    assert(
      (leg?.querySelector("[title]") as HTMLElement)?.getAttribute("title")?.includes("transfer"),
      "transfer delete: the row says it is part of a transfer",
    );

    /* Dated earlier this month, so it is voided rather than destroyed — and
       BOTH legs go, because half a cancelled transfer is money out of one
       account and never into the other. That is the same failure the pairing
       exists to prevent, reappearing at the other end of the document's
       life. */
    await act(async () => {
      (leg?.querySelector('[title="Void this transfer on both accounts"]') as HTMLElement)?.click();
    });
    await settleMs(200);
    const tDlg = currentDialog();
    const tReason = Array.from(tDlg.querySelectorAll("input")).find((i) =>
      (i.getAttribute("placeholder") ?? "").startsWith("Entered twice"),
    ) as HTMLInputElement | undefined;
    assert(!!tReason, "transfer void: the dialog asks why");
    assert(
      (tDlg.textContent ?? "").includes("bank side of the transfer is voided with it"),
      `transfer void: and says the bank side goes too — ${JSON.stringify(tDlg.textContent?.slice(0, 200))}`,
    );
    await act(async () => {
      setInput(tReason, "Never happened");
    });
    await settleMs(60);
    await act(async () => {
      (
        Array.from(tDlg.querySelectorAll("button")).find((b) =>
          /^Void this cash entry$/.test((b.textContent ?? "").trim()),
        ) as HTMLButtonElement | undefined
      )?.click();
    });
    await settleMs(250);

    assert(
      !CashAdjustmentRepo.all().some((a) => a.id === "XCA"),
      "transfer void: the cash leg stops counting",
    );
    assert(
      !BankTxnRepo.all().some((t) => t.id === "XBT"),
      "transfer void: AND the bank leg with it — never one without the other",
    );
    assert(
      !!CashAdjustmentRepo.allWithVoided().find((a) => a.id === "XCA")?.voidedAt &&
        !!BankTxnRepo.allWithVoided().find((t) => t.id === "XBT")?.voidedAt,
      "transfer void: both are still on file, marked",
    );
    assert(
      BankRepo.get("XB1")?.balance === 2000,
      `transfer void: the account balance is put back — ${BankRepo.get("XB1")?.balance} (want 2000)`,
    );
  }

  /* ── The summary strip reaches the table's right edge ─────────────────
     Screens hand in their own footer <tr>, counting columns by hand. Adding
     the Action column left every one of them a cell short, so the strip
     stopped before the edge — and with the last column pinned, the ROW
     BENEATH showed through the gap. That is how a totals strip ended up with
     a stray pencil and bin floating off its end. */
  {
    await renderRoute("/payments");
    const table = document.querySelector(".data-table table") as HTMLTableElement | null;
    assert(!!table, "footer: found the table");
    const colCount = table?.querySelectorAll("thead th").length ?? 0;
    const footRow = table?.querySelector("tfoot tr");
    assert(!!footRow, "footer: the totals row is rendered");

    const spanOf = (row: Element) =>
      Array.from(row.children).reduce((n, c) => n + (Number(c.getAttribute("colspan")) || 1), 0);
    assert(
      !!footRow && spanOf(footRow) === colCount,
      `footer: it covers every column — spans ${footRow && spanOf(footRow)} of ${colCount}`,
    );

    // Measured, not just counted: the strip has to reach as far right as the
    // header does, or there is a gap for the rows below to show through.
    const lastTh = table?.querySelector("thead th:last-child") as HTMLElement | null;
    const lastFootCell = footRow?.lastElementChild as HTMLElement | null;
    if (lastTh && lastFootCell) {
      assert(
        Math.abs(
          lastTh.getBoundingClientRect().right - lastFootCell.getBoundingClientRect().right,
        ) < 1.5,
        `footer: and ends where the table ends — header right ${Math.round(
          lastTh.getBoundingClientRect().right,
        )}, footer right ${Math.round(lastFootCell.getBoundingClientRect().right)}`,
      );
      // The pinned footer cell must be painted, or rows scroll under it.
      const bg = getComputedStyle(lastFootCell).backgroundColor;
      assert(
        bg !== "" && !bg.includes("rgba(0, 0, 0, 0)"),
        `footer: the pinned corner is opaque — background ${bg}`,
      );
    }

    /* WHAT IS ON TOP, asked of the browser rather than inferred — and asked
     * under the condition that actually produces the bug.
     *
     * Two earlier versions of this assertion were worthless. The first checked
     * the footer cell's background COLOUR: right colour, but a pinned body
     * cell was painted over it, so what a person saw in the footer's Action
     * corner was a row's pencil and bin. The second asked elementFromPoint
     * but on an UNSCROLLED table — nothing passes under a sticky footer until
     * the content is taller than its container, so there was nothing to be
     * covered by and the check could not fail.
     *
     * So: enough rows to overflow a short container, scrolled, then ask. */
    {
      const h3 = document.createElement("div");
      h3.style.cssText = "position:fixed;left:0;top:0;width:640px;height:340px;display:flex;";
      document.body.appendChild(h3);
      const r3 = createRoot(h3);
      await act(async () => {
        r3.render(
          <DataTable
            columns={[
              { key: "name", label: "Name", render: (r: { id: string }) => r.id },
              { key: "amount", label: "Amount", render: () => "1,000" },
              { key: "action", label: "Action", render: () => <button>edit</button> },
            ]}
            rows={Array.from({ length: 40 }, (_, i) => ({ id: `Row ${i}` }))}
            rowKey={(r) => r.id}
            footer={
              <tr>
                <td colSpan={2}>Total</td>
              </tr>
            }
          />,
        );
      });
      await settleMs(80);

      const scroller = h3.querySelector(".data-table") as HTMLElement | null;
      const table3 = h3.querySelector("table") as HTMLElement | null;
      assert(!!scroller && !!table3, "stacking: the probe table mounted");
      if (scroller && table3) {
        assert(
          scroller.scrollHeight > scroller.clientHeight + 20,
          `stacking: the probe table really overflows — content ${scroller.scrollHeight} vs box ${scroller.clientHeight}`,
        );
        await act(async () => {
          scroller.scrollTop = Math.floor(scroller.scrollHeight / 3);
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        await settleMs(60);

        const foot = table3.querySelector("tfoot td:last-child") as HTMLElement | null;
        assert(!!foot, "stacking: the pinned footer corner exists");
        if (foot) {
          const fr = foot.getBoundingClientRect();
          const onTop = document.elementFromPoint(fr.left + fr.width / 2, fr.top + fr.height / 2);
          assert(
            !!onTop && !!onTop.closest("tfoot"),
            `stacking: the FOOTER owns its own corner while rows scroll under it — found <${onTop?.tagName.toLowerCase()}> in ${
              onTop?.closest("tfoot")
                ? "tfoot"
                : onTop?.closest("tbody")
                  ? "tbody (a row is painted over the totals)"
                  : "neither"
            }`,
          );
        }

        const head = table3.querySelector("thead th:last-child") as HTMLElement | null;
        if (head) {
          const hr = head.getBoundingClientRect();
          const onTopHead = document.elementFromPoint(
            hr.left + hr.width / 2,
            hr.top + hr.height / 2,
          );
          assert(
            !!onTopHead && !!onTopHead.closest("thead"),
            `stacking: and the HEADER owns its corner too — found <${onTopHead?.tagName.toLowerCase()}> in ${
              onTopHead?.closest("thead")
                ? "thead"
                : onTopHead?.closest("tbody")
                  ? "tbody"
                  : "neither"
            }`,
          );
        }
      }
      r3.unmount();
      h3.remove();
    }

    // A footer that IS short gets padded out. Every screen's footer happens to
    // be right today, so nothing on a real page exercises this — but they are
    // counted by hand, and the next column added to any table would leave one
    // of them a cell short with the pinned column's row showing through the
    // gap. Worth holding still.
    {
      const h2 = document.createElement("div");
      document.body.appendChild(h2);
      const r2root = createRoot(h2);
      await act(async () => {
        r2root.render(
          <DataTable
            columns={[
              { key: "a", label: "A", render: () => "a" },
              { key: "b", label: "B", render: () => "b" },
              { key: "action", label: "Action", render: () => "x" },
            ]}
            rows={[{ id: "1" }]}
            rowKey={(r) => r.id}
            footer={
              <tr>
                <td>Total</td>
              </tr>
            }
          />,
        );
      });
      await settleMs(60);
      const shortFoot = h2.querySelector("tfoot tr");
      assert(!!shortFoot, "footer: the short-footer probe rendered");
      assert(
        (shortFoot?.children.length ?? 0) === 3,
        `footer: a one-cell footer is padded to the column count — got ${shortFoot?.children.length}`,
      );
      r2root.unmount();
      h2.remove();
    }

    // A pinned cell has to carry the row's OWN colour, or a hovered row shows
    // a white block where its buttons are.
    const firstTd = table?.querySelector("tbody tr td:last-child") as HTMLElement | null;
    assert(
      !!firstTd && getComputedStyle(firstTd).backgroundColor !== "rgba(0, 0, 0, 0)",
      `footer: pinned body cells are opaque — ${firstTd && getComputedStyle(firstTd).backgroundColor}`,
    );
  }

  /* ── An old transfer is EDITED as a whole, and both legs follow ────────
     Editing one side on its own must not happen — the cash would move and
     the account would still say the old figure. Refusing the edit was the
     safe answer but not a good one: correcting a mistyped transfer meant
     deleting it and entering it again from memory. So the pencil opens the
     TRANSFER, and saving rewrites both legs on one batch.

     Seeded WITHOUT a shared id, exactly as transfers were written before
     that field existed — those are the ones the client was being offered a
     one-sided edit of. */
  {
    BankRepo.add({
      id: "OLDB",
      createdAt: "2026-01-01T00:00:00Z",
      name: "Legacy Transfer Bank",
      openingBalance: 0,
      balance: 5000, // already includes the 1200 below
    } as never);
    const NOTE = "Transfer to Legacy Transfer Bank — OLD ENTRY";
    CashAdjustmentRepo.add({
      id: "OLDCA",
      createdAt: "2026-01-01T00:00:00Z",
      date: D2,
      type: "reduce",
      amount: 1200,
      reason: NOTE,
    } as never);
    BankTxnRepo.add({
      id: "OLDBT",
      createdAt: "2026-01-01T00:00:00Z",
      bankId: "OLDB",
      date: D2,
      type: "deposit",
      amount: 1200,
      notes: NOTE,
    } as never);

    await renderRoute("/cash");
    const legRow = () =>
      Array.from(
        document.querySelector(".data-table table")?.querySelectorAll("tbody tr") ?? [],
      ).find((tr) => (tr.textContent ?? "").includes("OLD ENTRY"));
    assert(!!legRow(), "old transfer: the leg is listed on the Cash page");

    const pencil = legRow()?.querySelector(
      '[title="Edit this transfer (both accounts)"]',
    ) as HTMLButtonElement | null;
    assert(!!pencil && !pencil.disabled, "old transfer: it CAN be edited, as a transfer");

    await act(async () => {
      pencil?.click();
    });
    await settleMs(150);
    const dlg = currentDialog();
    assert(
      (dlg.textContent ?? "").includes("Edit Transfer"),
      `old transfer: the TRANSFER editor opens, not the cash form — ${JSON.stringify(
        dlg.textContent?.slice(0, 80),
      )}`,
    );
    // Pre-filled from the pair: cash out means cash was the source.
    const sideText = (side: "From" | "To") =>
      dlg.querySelector(`[role="combobox"][aria-label="${side} account"]`)?.textContent ?? "";
    assert(
      sideText("From").includes("Cash in Hand") && sideText("To").includes("Legacy Transfer Bank"),
      `old transfer: both ends are worked out from the legs — From ${JSON.stringify(
        sideText("From"),
      )}, To ${JSON.stringify(sideText("To"))}`,
    );
    const amt = dlg.querySelector('input[aria-label="Transfer amount"]') as HTMLInputElement | null;
    assert(amt?.value === "1200", `old transfer: and the amount — got ${amt?.value}`);

    // Correct it to 900: BOTH legs and BOTH balances have to follow.
    const cashBefore = cashFlows(
      SalesRepo.all(),
      PurchaseRepo.all(),
      ExpenseRepo.all(),
      PaymentRepo.all(),
      CashAdjustmentRepo.all(),
    ).reduce((s, e) => s + e.in - e.out, 0);
    await act(async () => {
      setInput(amt, "900");
    });
    await settleMs(60);
    await act(async () => {
      (
        Array.from(dlg.querySelectorAll("button")).find(
          (b) => (b.textContent ?? "").trim() === "Transfer",
        ) as HTMLButtonElement
      )?.click();
    });
    await settleMs(250);

    const cashLegs = CashAdjustmentRepo.all().filter((a) => (a.reason ?? "").includes("OLD ENTRY"));
    const bankLegs = BankTxnRepo.all().filter((t) => (t.notes ?? "").includes("OLD ENTRY"));
    assert(
      cashLegs.length === 1 && cashLegs[0].amount === 900,
      `old transfer: the cash leg is now 900 — ${JSON.stringify(cashLegs.map((a) => a.amount))}`,
    );
    assert(
      bankLegs.length === 1 && bankLegs[0].amount === 900,
      `old transfer: and so is the bank leg — ${JSON.stringify(bankLegs.map((t) => t.amount))}`,
    );
    assert(
      BankRepo.get("OLDB")?.balance === 4700,
      `old transfer: the account moved by the DIFFERENCE only — ${BankRepo.get("OLDB")?.balance} (want 4700)`,
    );
    const cashAfter = cashFlows(
      SalesRepo.all(),
      PurchaseRepo.all(),
      ExpenseRepo.all(),
      PaymentRepo.all(),
      CashAdjustmentRepo.all(),
    ).reduce((s, e) => s + e.in - e.out, 0);
    assert(
      Math.abs(cashAfter - (cashBefore + 300)) < 0.01,
      `old transfer: and cash keeps the 300 that is no longer being moved — ${cashAfter} (want ${cashBefore + 300})`,
    );
    // Both legs now share an id, so they stay a pair from here on.
    assert(
      !!cashLegs[0].transferId && cashLegs[0].transferId === bankLegs[0].transferId,
      "old transfer: editing it also pairs the two legs properly",
    );

    /* Cancelling it still clears both sides and puts the balance back — the
       pair holds at the end of the document's life as well as during it. It
       is dated in the past, so it voids rather than deletes. */
    await renderRoute("/cash");
    const del = legRow()?.querySelector(
      '[title="Void this transfer on both accounts"]',
    ) as HTMLButtonElement | null;
    assert(!!del, "old transfer: the action says it will clear both accounts");
    await act(async () => {
      del?.click();
    });
    await settleMs(200);
    const oDlg = currentDialog();
    const oReason = Array.from(oDlg.querySelectorAll("input")).find((i) =>
      (i.getAttribute("placeholder") ?? "").startsWith("Entered twice"),
    ) as HTMLInputElement | undefined;
    assert(!!oReason, "old transfer: the void dialog asks why");
    await act(async () => {
      setInput(oReason, "Wrong account");
    });
    await settleMs(60);
    await act(async () => {
      (
        Array.from(oDlg.querySelectorAll("button")).find((b) =>
          /^Void this cash entry$/.test((b.textContent ?? "").trim()),
        ) as HTMLButtonElement | undefined
      )?.click();
    });
    await settleMs(250);
    assert(
      CashAdjustmentRepo.all().every((a) => !(a.reason ?? "").includes("OLD ENTRY")),
      "old transfer: the cash leg stops counting",
    );
    assert(
      BankTxnRepo.all().every((t) => !(t.notes ?? "").includes("OLD ENTRY")),
      "old transfer: AND the bank leg with it",
    );
    assert(
      CashAdjustmentRepo.allWithVoided().some(
        (a) => (a.reason ?? "").includes("OLD ENTRY") && !!a.voidedAt,
      ),
      "old transfer: and both are still on file, marked",
    );
    assert(
      BankRepo.get("OLDB")?.balance === 3800,
      `old transfer: the account is put back — ${BankRepo.get("OLDB")?.balance} (want 3800)`,
    );
  }

  /* ── The edit dialog says what its button will do ─────────────────────── */
  {
    CashAdjustmentRepo.add({
      id: "PLAINCA",
      createdAt: "2026-01-01T00:00:00Z",
      date: D2,
      type: "add",
      amount: 500,
      reason: "Till top-up",
    } as never);
    await renderRoute("/cash");
    const t2 = document.querySelector(".data-table table");
    const plain = Array.from(t2?.querySelectorAll("tbody tr") ?? []).find((tr) =>
      (tr.textContent ?? "").includes("Till top-up"),
    );
    const edit = plain?.querySelector('[title="Edit entry"]') as HTMLButtonElement | null;
    assert(!!edit && !edit.disabled, "edit label: an ordinary entry IS editable");
    await act(async () => {
      edit?.click();
    });
    await settleMs(120);
    const dlg = currentDialog();
    assert(
      (dlg.textContent ?? "").includes("Edit Cash Entry"),
      "edit label: the dialog is titled for editing",
    );
    assert(
      (dlg.textContent ?? "").includes("Save Changes"),
      `edit label: and its button says Save Changes, not "Adjust Cash" — ${JSON.stringify(
        dlg.textContent?.slice(0, 160),
      )}`,
    );
  }

  /* ── Cash that says WHY it moved ──────────────────────────────────────
     "CASH ADD TILL TODAY FROM VYAPAR ₹29,000" is real money in the drawer
     with nothing saying whether the shop earned it, the owner put it in, or
     it was carried over — so the P&L absorbs it as profit and that month is
     wrong by ₹29,000 with nothing on screen to say so. The form now asks for
     the second side of the movement, the way every accounting system does. */
  {
    // An entry from before the app asked, kept as the shop's real one reads.
    CashAdjustmentRepo.add({
      id: "OLDCASH",
      createdAt: "2026-01-01T00:00:00Z",
      date: D2,
      type: "add",
      amount: 29000,
      reason: "CASH ADD TILL TODAY FROM VYAPAR",
    } as never);

    await renderRoute("/cash");
    const openBtn = findButton(/Adjust Cash/);
    assert(!!openBtn, "cash reason: found the Adjust Cash button");
    await act(async () => {
      openBtn?.click();
    });
    await settleMs(120);
    const dlg = currentDialog();

    const group = dlg.querySelector(
      '[role="radiogroup"][aria-label="Reason for the cash movement"]',
    );
    assert(!!group, "cash reason: the form asks why the cash moved");
    const choices = Array.from(
      group?.querySelectorAll('[role="radio"]') ?? [],
    ) as HTMLButtonElement[];
    const labels = choices.map((b) => (b.textContent ?? "").trim());
    assert(
      labels.includes("Owner took out") &&
        labels.includes("Owner put in") &&
        labels.includes("Opening balance") &&
        labels.includes("Counting difference"),
      `cash reason: the reasons a shop actually has are offered — ${labels}`,
    );
    assert(
      !labels.includes("Transfer"),
      "cash reason: 'Transfer' is not offered here — the app writes that side itself",
    );
    assert(
      choices.every((b) => b.getAttribute("aria-checked") === "false"),
      "cash reason: nothing is pre-picked — a guessed reason is worse than a missing one",
    );

    const pickReason = async (label: string) => {
      const btn = choices.find((b) => (b.textContent ?? "").trim() === label);
      assert(!!btn, `cash reason: found the "${label}" choice`);
      await act(async () => {
        btn?.click();
      });
      await settleMs(60);
    };
    const dirBtn = (label: string) =>
      Array.from(
        dlg.querySelectorAll('[role="radiogroup"][aria-label="Direction"] [role="radio"]'),
      ).find((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement | undefined;
    const amountBox = Array.from(dlg.querySelectorAll("input")).find(
      (i) => i.getAttribute("inputmode") === "decimal",
    ) as HTMLInputElement | undefined;
    const reasonBox = Array.from(dlg.querySelectorAll("input")).find((i) =>
      (i.getAttribute("placeholder") ?? "").startsWith("Opening cash"),
    ) as HTMLInputElement | undefined;
    const submit = () =>
      Array.from(dlg.querySelectorAll("button")).find((b) =>
        /Add Entry|Save Changes/.test((b.textContent ?? "").trim()),
      ) as HTMLButtonElement | undefined;
    assert(!!amountBox && !!reasonBox && !!submit(), "cash reason: found amount, note and submit");

    /* An amount with no reason is exactly the entry this exists to stop, so
       it must not save — and the form must stay open holding the typed
       figure rather than closing and losing it. */
    const before = CashAdjustmentRepo.all().length;
    await act(async () => {
      setInput(amountBox, "4000");
    });
    await settleMs(60);
    await act(async () => {
      submit()?.click();
    });
    await settleMs(180);
    assert(
      CashAdjustmentRepo.all().length === before,
      `cash reason: cash with no stated reason is refused — ${CashAdjustmentRepo.all().length - before} appeared`,
    );
    assert(
      document.body.contains(dlg) && (dlg.textContent ?? "").includes("Why did the cash move"),
      "cash reason: and the form is still open with the amount typed, not thrown away",
    );

    /* The reason sets the direction, because "owner took out" already says
       which way the money went. Asking twice is asking the same question
       twice — and lets the two answers contradict each other. */
    await pickReason("Owner took out");
    assert(
      dirBtn("Cash Out")?.getAttribute("aria-checked") === "true",
      "cash reason: 'Owner took out' is cash OUT without being asked again",
    );
    assert(dirBtn("Cash In")?.disabled === true, "cash reason: and it cannot be contradicted");
    await pickReason("Owner put in");
    assert(
      dirBtn("Cash In")?.getAttribute("aria-checked") === "true",
      "cash reason: 'Owner put in' flips it the other way",
    );
    /* A counting difference genuinely goes either way, so that one leaves the
       direction to the person counting. */
    await pickReason("Counting difference");
    assert(
      dirBtn("Cash In")?.disabled === false && dirBtn("Cash Out")?.disabled === false,
      "cash reason: a counting difference can still go either way",
    );

    await pickReason("Owner took out");
    await act(async () => {
      setInput(reasonBox, "Owner personal use");
    });
    await settleMs(60);
    await act(async () => {
      submit()?.click();
    });
    await settleMs(220);
    const saved = CashAdjustmentRepo.all().find((a) => a.reason === "Owner personal use");
    assert(!!saved, "cash reason: with a reason stated, it saves");
    assert(
      saved?.purpose === "owner-out",
      `cash reason: and the reason is STORED, not just shown — ${JSON.stringify(saved?.purpose)}`,
    );
    assert(
      saved?.type === "reduce" && saved?.amount === 4000,
      `cash reason: as cash out of 4000 — ${saved?.type} ${saved?.amount}`,
    );

    /* Both legs of a transfer are tagged by the app. Nobody should have to
       state the reason for a movement whose other side is a real account. */
    const legs = CashAdjustmentRepo.all().filter((a) => !!a.transferId);
    assert(legs.length > 0, "cash reason: there are transfer legs to check");
    assert(
      legs.every((a) => a.purpose === "transfer"),
      `cash reason: transfer legs are tagged by the app — ${JSON.stringify(
        legs.map((a) => a.purpose),
      )}`,
    );

    /* On the page: the reason is on the row, and an entry from before this
       existed says so rather than being guessed at. */
    await renderRoute("/cash");
    const tbl = document.querySelector(".data-table table");
    const headerNames = Array.from(tbl?.querySelectorAll("thead th") ?? []).map((th) =>
      (th.textContent ?? "").trim(),
    );
    assert(
      headerNames.includes("Reason"),
      `cash reason: the table has a Reason column — ${headerNames}`,
    );
    const rowWith = (text: string) =>
      Array.from(tbl?.querySelectorAll("tbody tr") ?? []).find((tr) =>
        (tr.textContent ?? "").includes(text),
      );
    const newRow = rowWith("Owner personal use");
    const oldRow = rowWith("CASH ADD TILL TODAY FROM VYAPAR");
    assert(!!newRow && !!oldRow, "cash reason: both rows are on the page");
    assert(
      (newRow?.textContent ?? "").includes("Owner took out"),
      `cash reason: the stated reason reads on its row — ${JSON.stringify(newRow?.textContent)}`,
    );
    assert(
      (oldRow?.textContent ?? "").includes("Uncategorised"),
      `cash reason: the older entry is marked uncategorised, not guessed — ${JSON.stringify(
        oldRow?.textContent,
      )}`,
    );
    /* And it LOOKS different, because "nobody knows where ₹29,000 came from"
       is something to chase, not a neutral fact. Identical chips would make
       that row read as filed-and-fine. */
    const chipIn = (row: Element | undefined, text: string) =>
      Array.from(row?.querySelectorAll("span") ?? []).find(
        (s) => (s.textContent ?? "").trim() === text,
      ) as HTMLElement | undefined;
    const okChip = chipIn(newRow, "Owner took out");
    const badChip = chipIn(oldRow, "Uncategorised");
    assert(!!okChip && !!badChip, "cash reason: found both chips");
    if (okChip && badChip) {
      const ok = getComputedStyle(okChip);
      const bad = getComputedStyle(badChip);
      assert(
        ok.backgroundColor !== bad.backgroundColor,
        `cash reason: an unexplained entry is flagged, not painted like the rest — both ${bad.backgroundColor}`,
      );
      assert(
        parseFloat(bad.borderTopWidth) > 0,
        `cash reason: and it carries a border to say so — ${bad.borderTopWidth}`,
      );
      assert(
        (badChip.getAttribute("title") ?? "").length > 10,
        "cash reason: hovering it explains what to do about it",
      );
    }

    /* The summary is what makes stating a reason worth something today,
       before there is a ledger to post it to: how much of the month's cash
       movement was the owner's own money — and how much nobody can explain. */
    const strip = document.querySelector('[aria-label="Cash movement by reason"]');
    assert(!!strip, "cash reason: the page totals the movements by reason");
    const stripText = (strip?.textContent ?? "").replace(/\s+/g, " ");
    const unexplained = /Uncategorised\((\d+)\)([+-])₹([\d,]+)/.exec(stripText);
    assert(
      !!unexplained,
      `cash reason: unexplained cash is called out on its own line — ${JSON.stringify(stripText)}`,
    );
    assert(
      unexplained?.[2] === "+" && Number((unexplained?.[3] ?? "0").replace(/,/g, "")) >= 29000,
      `cash reason: with its figure, signed as money in — ${JSON.stringify(unexplained?.[0])}`,
    );
    assert(
      stripText.includes("Owner took out") && stripText.includes("4,000"),
      `cash reason: and the stated ones are totalled too — ${JSON.stringify(stripText)}`,
    );
    /* Signed, so the figures read the way the drawer moved. Unsigned, the
       owner's ₹4,000 withdrawal would show exactly like a ₹4,000 deposit. */
    assert(
      /[-−]₹?\s?4,000/.test(stripText),
      `cash reason: cash out reads as a fall, not a rise — ${JSON.stringify(stripText)}`,
    );
    assert(
      stripText.includes("+"),
      `cash reason: and cash in reads as a rise — ${JSON.stringify(stripText)}`,
    );
  }

  /* ── The Trial Balance, on a real screen ──────────────────────────────
     The report an accountant asks for first, and the one this shop has never
     been able to produce. Driven against whatever every block above has
     already put in the repos — a book with sales, purchases, returns,
     payments, expenses, transfers and manual cash in it. */
  {
    const page = await renderRoute("/reports?r=trial-balance");
    assert(page.includes("Trial Balance"), "trial balance: the report opened");

    const table = document.querySelector("table");
    assert(!!table, "trial balance: there is a table");
    const headers = Array.from(table?.querySelectorAll("thead th") ?? []).map((th) =>
      (th.textContent ?? "").trim(),
    );
    assert(
      headers.join("|") === "Code|Account|Debit|Credit",
      `trial balance: the four columns an accountant expects — ${headers}`,
    );

    // The groups are what make it readable as a balance sheet and a P&L.
    for (const group of ["Assets", "Liabilities", "Income", "Expenses"]) {
      assert(page.includes(group), `trial balance: the ${group} section is on the page`);
    }

    /* The one invariant the report exists to show. Read off the rendered
       footer rather than recomputed, because a total that is right in the
       library and wrong on screen is still wrong on screen. */
    const foot = Array.from(table?.querySelectorAll("tfoot td") ?? []).map((td) =>
      (td.textContent ?? "").trim(),
    );
    const num = (s: string) => Number((s || "").replace(/[^\d.-]/g, ""));
    assert(foot.length === 3, `trial balance: the footer totals both columns — ${foot}`);
    assert(
      foot[0] === "Total" && num(foot[1]) > 0,
      `trial balance: there is a real total to check — ${foot}`,
    );
    assert(
      Math.abs(num(foot[1]) - num(foot[2])) < 0.02,
      `trial balance: total debits equal total credits — ${foot[1]} vs ${foot[2]}`,
    );
    /* And each total against the column it is under, cell by cell as
       rendered. Comparing the two totals to each other only proves they were
       computed the same way — including the same wrong way. */
    const columnSum = (nth: number) =>
      Array.from(table?.querySelectorAll("tbody tr") ?? []).reduce((sum, tr) => {
        const cells = tr.querySelectorAll("td");
        // Group heading rows span all four columns and hold no figures.
        if (cells.length < 4) return sum;
        return sum + num((cells[nth].textContent ?? "").trim());
      }, 0);
    assert(
      Math.abs(columnSum(2) - num(foot[1])) < 0.02,
      `trial balance: the debit total is the sum of the debits shown — ${columnSum(2)} vs ${foot[1]}`,
    );
    assert(
      Math.abs(columnSum(3) - num(foot[2])) < 0.02,
      `trial balance: and the credit total the sum of the credits shown — ${columnSum(3)} vs ${foot[2]}`,
    );

    assert(
      !page.includes("The books are out by"),
      "trial balance: and nothing is flagged as out of balance",
    );
    assert(
      !page.includes("accounts that do not exist"),
      "trial balance: every posting points at an account in the chart",
    );

    // Cash in Hand is the row a shopkeeper looks for first.
    const rowFor = (name: string) =>
      Array.from(table?.querySelectorAll("tbody tr") ?? []).find((tr) =>
        (tr.textContent ?? "").includes(name),
      );
    assert(!!rowFor("Cash in Hand"), "trial balance: Cash in Hand is listed");
    assert(!!rowFor("Accounts Receivable"), "trial balance: so is Accounts Receivable");
    /* Accounts that exist to expose a gap carry an explanation on the row.
       "Suspense: 4,000" with nothing saying what it means would be worse than
       not showing it. */
    const suspense = rowFor("Suspense");
    if (suspense) {
      assert(
        !!suspense.querySelector("[title]"),
        "trial balance: an account that means something needs explaining says so on hover",
      );
    }
  }

  /* ── Reconciliation: does the ledger agree with the app? ──────────────
     The screen that decides whether to believe the other one. What matters
     is not that this book happens to reconcile — the harness seeds bank
     balances by hand — but that a difference is CAUGHT, named, and put in
     front of the shop instead of averaging away in a total. */
  {
    const page = await renderRoute("/reports?r=reconcile");
    assert(page.includes("Ledger Reconciliation"), "reconcile: the report opened");
    assert(
      page.includes("Total Receivable") && page.includes("Total Payable"),
      "reconcile: receivables and payables are checked",
    );
    assert(page.includes("Cash in Hand"), "reconcile: so is cash");
    assert(page.includes("Net Profit"), "reconcile: and the profit figure");

    const table = document.querySelector("table");
    const headers = Array.from(table?.querySelectorAll("thead th") ?? []).map((th) =>
      (th.textContent ?? "").trim(),
    );
    assert(
      headers.join("|") === "Figure|Ledger|App today|Difference",
      `reconcile: both answers side by side, with the gap — ${headers}`,
    );

    const rowFor = (name: string) =>
      Array.from(table?.querySelectorAll("tbody tr") ?? []).find((tr) =>
        (tr.textContent ?? "").includes(name),
      );
    const cells = (tr: Element | undefined) =>
      Array.from(tr?.querySelectorAll("td") ?? []).map((td) => (td.textContent ?? "").trim());
    const num = (s: string) => Number((s || "").replace(/[^\d.-]/g, ""));

    /* Every entry balancing is the first row, because nothing below it means
       anything if the journal does not add up. */
    const balanced = rowFor("Every entry balances");
    assert(!!balanced, "reconcile: the journal's own arithmetic is the first thing checked");
    const bc = cells(balanced);
    assert(
      Math.abs(num(bc[1]) - num(bc[2])) < 0.02,
      `reconcile: and it does balance — ${bc[1]} vs ${bc[2]}`,
    );

    /* Receivables and cash are derived twice by completely separate code —
       the ledger's postings, and netPartyPositions/cashFlows. On this book
       they must agree, and this is the assertion that would have caught the
       dashboard double-count. */
    for (const figure of ["Total Receivable", "Total Payable", "Cash in Hand"]) {
      const c = cells(rowFor(figure));
      assert(
        c.length === 4 && Math.abs(num(c[1]) - num(c[2])) < 0.02,
        `reconcile: ${figure} — ledger ${c[1]} vs app ${c[2]}`,
      );
    }
    assert(
      !page.includes("Parties where the two disagree"),
      "reconcile: no party's position differs between the two derivations",
    );

    /* Now break it on purpose, on an account built for the job.
       A stored bank balance drifting from the documents is the single most
       likely real-world failure here — it is one of only two running totals
       the app stores, and lib/bankRepair.ts exists because it has happened.
       The screen must NAME the account and the amount, not average it away.

       A purpose-built account, because the blocks above seed bank balances by
       hand with no documents behind them, so most accounts in this book are
       ALREADY drifting — which the screen is right to report and which is
       asserted just below. Measuring a deliberate 777 against a figure that
       is already off by something else would prove nothing. */
    BankRepo.add({
      id: "RECONB",
      createdAt: "2026-01-01T00:00:00Z",
      name: "Recon Test Bank",
      // Opening balance and stored balance agree and nothing has moved since,
      // so the ledger and the stored figure must land on the same number.
      openingBalance: 12000,
      balance: 12000,
    } as never);

    const bankRowCells = async () => {
      await renderRoute("/reports?r=reconcile");
      const t = document.querySelector("table");
      const tr = Array.from(t?.querySelectorAll("tbody tr") ?? []).find((row) =>
        (row.textContent ?? "").includes("Recon Test Bank"),
      );
      assert(!!tr, "reconcile: the account is listed by name");
      return Array.from(tr?.querySelectorAll("td") ?? []).map((td) =>
        (td.textContent ?? "").trim(),
      );
    };

    {
      const c = await bankRowCells();
      assert(
        Math.abs(num(c[1]) - 12000) < 0.02 && Math.abs(num(c[2]) - 12000) < 0.02,
        `reconcile: an untouched account agrees with its own opening balance — ${c[1]} vs ${c[2]}`,
      );
      assert(c[3] === "—", `reconcile: and shows no difference — ${c[3]}`);
    }

    BankRepo.update("RECONB", { balance: 12777 });
    {
      const c = await bankRowCells();
      assert(
        Math.abs(Math.abs(num(c[3])) - 777) < 0.02,
        `reconcile: drift is reported as the exact amount — ${c[3]}`,
      );
      assert(
        !document.body.textContent?.includes("The ledger agrees with every screen"),
        "reconcile: and the screen does not also clIBELL everything is fine",
      );
    }

    // Put it back: a fixed problem must stop shouting, or the warning stops
    // being read.
    BankRepo.update("RECONB", { balance: 12000 });
    {
      const c = await bankRowCells();
      assert(c[3] === "—", `reconcile: once it is put right, the row clears — ${c[3]}`);
    }

    /* The drift the harness left behind by seeding balances with no documents
       is itself reported. This is what the screen is FOR: money on a stored
       balance that nothing explains. */
    assert(
      document.body.textContent?.includes("Something does not agree"),
      "reconcile: a balance no document explains is reported, not quietly accepted",
    );
  }

  /* ── The Balance Sheet, and closing a year, on a real screen ──────────
     The statement a business is measured by, and the one irreversible action
     in this application. Driven against the book every block above has built
     up, plus one bill dated inside the year being closed so there is
     something real to close. */
  {
    // Inside financial year 2025-26 (April 2025 – March 2026), which is the
    // most recent finished year, so it is the one the panel offers.
    SalesRepo.add({
      id: "FYSALE",
      createdAt: "2025-12-15T00:00:00Z",
      number: "INV-FY",
      date: "2025-12-15",
      partyId: "P1",
      partyName: "Acme Traders",
      gstEnabled: false,
      lineItems: [],
      subtotal: 9000,
      discount: 0,
      taxAmount: 0,
      total: 9000,
      paid: 0,
      paymentMode: "credit",
    } as never);

    const page = await renderRoute("/reports?r=balance-sheet");
    assert(page.includes("Balance Sheet"), "balance sheet: the report opened");
    for (const section of [
      "Assets — what the shop owns",
      "Liabilities — what the shop owes",
      "Equity — what is left over",
    ]) {
      assert(page.includes(section), `balance sheet: the ${section} section is there`);
    }

    /* The clIBELL a balance sheet lives or dies by, read off the rendered
       figures rather than recomputed — a total that is right in the library
       and wrong on screen is still wrong on screen. */
    const num = (s: string) => Number((s || "").replace(/[^\d.-]/g, ""));
    const figureAfter = (label: string) => {
      const el = Array.from(document.querySelectorAll("span")).find(
        (s) => (s.textContent ?? "").trim() === label,
      );
      assert(!!el, `balance sheet: found the "${label}" line`);
      const value = el?.parentElement?.querySelector("span:last-child");
      return num((value?.textContent ?? "").trim());
    };
    const assets = figureAfter("Total Assets");
    const bothSides = figureAfter("Total Liabilities + Equity");
    assert(assets !== 0, `balance sheet: there are real figures on it — ${assets}`);
    assert(
      Math.abs(assets - bothSides) < 0.02,
      `balance sheet: what the shop owns equals what it owes plus what is left — ${assets} vs ${bothSides}`,
    );
    assert(
      !page.includes("This does not balance"),
      "balance sheet: and it is not flagged as out of balance",
    );
    /* Profit that has not been closed shows as equity. Without that line the
       statement would only balance on the day the year is closed. */
    assert(
      page.includes("Profit for the period (not yet closed)"),
      "balance sheet: unclosed profit is shown as equity, not left out",
    );

    /* ── The year close ───────────────────────────────────────────────── */
    assert(page.includes("Year close — 2025-26"), `balance sheet: the finished year is offered`);
    const closeBtn = findButton(/^Close 2025-26$/);
    assert(!!closeBtn && !closeBtn.disabled, "year close: the button is offered and enabled");

    // The entry is shown BEFORE anything is written. Closing a year on a
    // figure nobody checked is how a wrong year becomes permanent.
    assert(
      page.includes("To Retained Earnings") || page.includes("Loss to Retained Earnings"),
      "year close: what will move, and where, is on screen first",
    );
    const beforeCount = LedgerEntryRepo.all().length;

    await act(async () => {
      closeBtn?.click();
    });
    await settleMs(250);

    const closes = LedgerEntryRepo.all().filter((e) => e.docKind === "year-close");
    assert(
      LedgerEntryRepo.all().length === beforeCount + 1 && closes.length === 1,
      `year close: exactly one closing entry was written — ${LedgerEntryRepo.all().length - beforeCount}`,
    );
    const doc = closes[0];
    assert(doc.date === "2026-03-31", `year close: dated the last day of the year — ${doc.date}`);
    assert(doc.fyLabel === "2025-26", `year close: and labelled with the year — ${doc.fyLabel}`);
    assert(
      Math.abs(
        doc.lines.reduce((s, l) => s + l.debit, 0) - doc.lines.reduce((s, l) => s + l.credit, 0),
      ) < 0.005,
      "year close: the stored entry balances",
    );
    assert(
      doc.lines.some((l) => l.accountId === "retained"),
      `year close: and moves the year's result to Retained Earnings — ${JSON.stringify(doc.lines.map((l) => l.accountId))}`,
    );
    // Phase 0a: every write says who made it.
    assert(!!doc.createdBy, "year close: the closing entry records who closed it");

    const after = await readMounted();
    assert(
      after.includes("Reopen 2025-26"),
      "year close: a closed year offers to be reopened, not closed again",
    );
    assert(!findButton(/^Close 2025-26$/), "year close: and cannot be closed a second time");
    assert(
      after.includes("Retained Earnings"),
      "year close: the profit now shows on the balance sheet as Retained Earnings",
    );
    assert(
      !after.includes("This does not balance"),
      "year close: and the balance sheet still balances",
    );

    /* Reopening is the more dangerous direction — it changes a figure already
       reported — so unlike closing it goes through the period lock. Here the
       books are open, so it is allowed, and it must put everything back. */
    const reopenBtn = findButton(/^Reopen 2025-26$/);
    const realConfirm = window.confirm;
    window.confirm = () => true;
    try {
      await act(async () => {
        reopenBtn?.click();
      });
      await settleMs(250);
    } finally {
      window.confirm = realConfirm;
    }
    assert(
      LedgerEntryRepo.all().filter((e) => e.docKind === "year-close").length === 0,
      "year close: reopening removes the closing entry",
    );
    const reopened = await readMounted();
    assert(
      reopened.includes("Profit for the period (not yet closed)"),
      "year close: and the profit goes back to being this period's",
    );
    assert(!reopened.includes("This does not balance"), "year close: still balancing either way");
  }

  /* ── Profit & Loss off the ledger ─────────────────────────────────────
     The same postings as the Balance Sheet, so the two cannot disagree. What
     matters on screen is the warning: switching the old report to this one
     would move the profit figure the owner has been reading for months, and
     standing rule 5 says that gets flagged before it reaches the shop. */
  {
    const page = await renderRoute("/reports?r=pl-ledger");
    assert(page.includes("Profit & Loss (from the ledger)"), "ledger P&L: the report opened");
    assert(
      page.includes("Income") && page.includes("Expenses"),
      "ledger P&L: both halves are there",
    );
    assert(
      page.includes("Net Profit") || page.includes("Net Loss"),
      "ledger P&L: and the figure they add up to",
    );
    /* The harness's book contains cash movements with no stated reason, which
       land in Cash Short/Over — an account the old report has never counted.
       The screen must say so with the amount, rather than quietly printing a
       different profit than the report next to it. */
    assert(
      page.includes("the old Profit & Loss report has never counted"),
      "ledger P&L: what this counts that the old report does not is stated on the statement",
    );
    assert(
      page.includes("Cash Short/Over") || page.includes("Stock Written Off"),
      `ledger P&L: and named — ${JSON.stringify(page.slice(page.indexOf("never counted"), page.indexOf("never counted") + 200))}`,
    );
  }

  /* ── Correcting a bill that has already been counted ──────────────────
     The behaviour change the shop will notice. A bill from an earlier day is
     cancelled, not destroyed: it stays on its list, stops counting
     everywhere, and the stock goes back exactly as a delete would have put
     it back. Today's mistake is still deleted outright — nothing has been
     reported on, and a shop forced to keep every mis-tap would stop using
     the software. */
  {
    ItemRepo.add({
      id: "VITEM",
      createdAt: "2026-01-01T00:00:00Z",
      name: "Void Test Item",
      unit: "PCS",
      gstRate: 0,
      purchasePrice: 60,
      salePrice: 100,
      stock: 50,
      openingStock: 50,
    } as never);
    const mkBill = (id: string, number: string, date: string, qty: number) =>
      SalesRepo.add({
        id,
        createdAt: "2026-01-01T00:00:00Z",
        number,
        date,
        partyId: "P1",
        partyName: "Acme Traders",
        gstEnabled: false,
        lineItems: [
          {
            id: "L1",
            itemId: "VITEM",
            name: "Void Test Item",
            qty,
            unit: "PCS",
            price: 100,
            discountPct: 0,
            gstRate: 0,
            amount: qty * 100,
          },
        ],
        subtotal: qty * 100,
        discount: 0,
        taxAmount: 0,
        total: qty * 100,
        paid: 0,
        paymentMode: "credit",
      } as never);
    mkBill("VOLD", "INV-VOLD", D2, 4);
    mkBill("VNEW", "INV-VNEW", today(), 3);

    await renderRoute("/sales");
    const table = document.querySelector(".data-table table");
    const rowFor = (text: string) =>
      Array.from(table?.querySelectorAll("tbody tr") ?? []).find((tr) =>
        (tr.textContent ?? "").includes(text),
      );

    /* The action says what it will actually do. Two bills, two different
       words, decided by nothing but the date. */
    assert(
      !!rowFor("INV-VOLD")?.querySelector('[title="Void invoice"]'),
      "void sale: a bill from an earlier day offers Void",
    );
    assert(
      !rowFor("INV-VOLD")?.querySelector('[title="Delete invoice"]'),
      "void sale: and does not offer to delete it",
    );
    assert(
      !!rowFor("INV-VNEW")?.querySelector('[title="Delete invoice"]'),
      "void sale: today's bill can still be deleted outright",
    );

    const stockBefore = ItemRepo.get("VITEM")?.stock ?? 0;

    await act(async () => {
      (rowFor("INV-VOLD")?.querySelector('[title="Void invoice"]') as HTMLElement)?.click();
    });
    await settleMs(150);

    assert(
      !!document.querySelector('[role="dialog"]'),
      "void sale: clicking Void asks for confirmation instead of destroying the bill",
    );
    const dlg = currentDialog();
    assert(
      (dlg.textContent ?? "").includes("Void invoice INV-VOLD"),
      `void sale: the dialog names the bill — ${JSON.stringify(dlg.textContent?.slice(0, 80))}`,
    );
    /* It says what will happen before it happens — what survives, what stops
       counting, and what gets put back. */
    assert(
      (dlg.textContent ?? "").includes("stays on the list"),
      "void sale: it says the bill survives",
    );
    assert(
      (dlg.textContent ?? "").includes("Sold quantities go back into stock"),
      "void sale: and that the stock comes back",
    );

    const confirmBtn = Array.from(dlg.querySelectorAll("button")).find((b) =>
      /^Void invoice INV-VOLD$/.test((b.textContent ?? "").trim()),
    ) as HTMLButtonElement | undefined;
    assert(!!confirmBtn, "void sale: found the confirm button");
    assert(
      confirmBtn?.disabled === true,
      "void sale: which refuses until a reason is given — 'why is INV-VOLD voided' is the question nothing else can answer",
    );

    const reasonBox = Array.from(dlg.querySelectorAll("input")).find((i) =>
      (i.getAttribute("placeholder") ?? "").startsWith("Entered twice"),
    ) as HTMLInputElement | undefined;
    await act(async () => {
      setInput(reasonBox, "Billed to the wrong customer");
    });
    await settleMs(60);
    assert(confirmBtn?.disabled === false, "void sale: with a reason, it will go through");
    await act(async () => {
      confirmBtn?.click();
    });
    await settleMs(250);

    // The record survives, marked, with the reason and the person on it.
    const voided = SalesRepo.allWithVoided().find((s) => s.id === "VOLD");
    assert(!!voided?.voidedAt, "void sale: the bill is still on file, marked as voided");
    assert(
      voided?.voidReason === "Billed to the wrong customer",
      `void sale: with the reason given — ${voided?.voidReason}`,
    );
    assert(!!voided?.voidedBy, "void sale: and who cancelled it");
    // ...and stops counting, without any caller having to remember to filter.
    assert(
      !SalesRepo.all().some((s) => s.id === "VOLD"),
      "void sale: every ordinary read of the collection skips it",
    );
    assert(
      (ItemRepo.get("VITEM")?.stock ?? 0) === stockBefore + 4,
      `void sale: and the stock goes back, exactly as a delete would have put it back — ${ItemRepo.get("VITEM")?.stock} (want ${stockBefore + 4})`,
    );

    // Off the list by default: cancelled bills never stop existing, but they
    // are not in the way.
    const afterList = await readMounted();
    assert(!afterList.includes("INV-VOLD"), "void sale: the cancelled bill is off the list");
    assert(afterList.includes("INV-VNEW"), "void sale: and the live one is still on it");

    // ...and one click away, struck through and badged.
    const toggle = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Voided",
    ) as HTMLButtonElement | undefined;
    assert(!!toggle, "void sale: there is a way to see cancelled bills");
    await act(async () => {
      toggle?.click();
    });
    await settleMs(200);
    const shown = await readMounted();
    assert(shown.includes("INV-VOLD"), "void sale: turning it on brings the cancelled bill back");
    const voidedRow = Array.from(
      document.querySelectorAll(".data-table table tbody tr") ?? [],
    ).find((tr) => (tr.textContent ?? "").includes("INV-VOLD"));
    assert(
      (voidedRow?.textContent ?? "").includes("Voided"),
      `void sale: marked as cancelled on the row — ${JSON.stringify(voidedRow?.textContent?.slice(0, 60))}`,
    );
    const numberCell = Array.from(voidedRow?.querySelectorAll("span") ?? []).find(
      (sp) => (sp.textContent ?? "").trim() === "INV-VOLD",
    ) as HTMLElement | undefined;
    assert(
      !!numberCell && getComputedStyle(numberCell).textDecorationLine.includes("line-through"),
      `void sale: and struck through, so it cannot be mistaken for a live bill — ${
        numberCell && getComputedStyle(numberCell).textDecorationLine
      }`,
    );
    const badge = Array.from(voidedRow?.querySelectorAll("[title]") ?? []).find((el) =>
      (el.getAttribute("title") ?? "").includes("Billed to the wrong customer"),
    );
    assert(!!badge, "void sale: hovering it says why, and when");
  }

  /* ── A test deployment says so, on every screen ───────────────────────
     The test site and the real one are the same application. The person in
     front of them is a shopkeeper part-way through a sale, not somebody who
     reads the URL bar — so without a mark on the screen a real day's takings
     gets typed into the test site, and the mistake is only found when the
     real books turn out to be short.

     Rendered on its own rather than through a route: this harness swaps the
     real root component for a bare Outlet, because the real one is the auth
     gate. That it is actually MOUNTED on every screen is checked against the
     source in run-screens.cjs — the same split the period lock uses. */
  {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const r = createRoot(host);
    await act(async () => {
      r.render(<TestDataBanner />);
    });
    await settleMs(60);

    const strip = host.querySelector('[role="status"]');
    assert(!!strip, "test banner: a non-production database is marked on screen");
    assert(
      (strip?.textContent ?? "").toLowerCase().includes("test data"),
      `test banner: in words, not a colour — ${JSON.stringify(strip?.textContent)}`,
    );
    assert(
      (strip?.textContent ?? "").includes("test-only-never-a-real-database"),
      `test banner: and it names which database, so two test sites cannot be confused — ${JSON.stringify(
        strip?.textContent,
      )}`,
    );
    if (strip) {
      const box = strip.getBoundingClientRect();
      const style = getComputedStyle(strip);
      assert(
        style.position === "fixed" && box.top < 2,
        `test banner: pinned to the top of the window, not scrolled away with the page — ${style.position} at ${Math.round(box.top)}`,
      );
      assert(
        box.width > window.innerWidth * 0.9,
        `test banner: across the full width — ${Math.round(box.width)} of ${window.innerWidth}`,
      );
      /* It must never eat a click meant for the app underneath. A warning
         that blocks the toolbar it sits over gets removed within a day, and
         then there is no warning. */
      assert(
        style.pointerEvents === "none",
        `test banner: and it does not swallow clicks meant for the app — ${style.pointerEvents}`,
      );
    }
    r.unmount();
    host.remove();
  }

  /* ── A closed period actually refuses, on a real screen ───────────────
     lib/periodLock is unit-tested, but a rule that is never asked is not a
     lock. This drives the Cash screen with the books closed and checks that
     nothing lands — and that the same screen still works either side of the
     boundary, because a lock that blocks everything is just an outage. */
  {
    const LOCKED_DAY = "2026-06-15";
    const OPEN_DAY = "2026-09-20";
    const company = CompanyRepo.get();
    CompanyRepo.save({ ...company, booksLockedUpto: "2026-06-30" });
    try {
      await renderRoute("/cash");
      const before = CashAdjustmentRepo.all().length;

      /** Fill in and submit the Adjust Cash form. */
      const enter = async (day: string, amount: string) => {
        const openBtn = findButton(/Adjust Cash/);
        assert(!!openBtn, "lock: found the Adjust Cash button");
        await act(async () => {
          openBtn?.click();
        });
        await settleMs(120);
        const dlg = currentDialog();
        const dateBox = dlg.querySelector('input[type="date"]') as HTMLInputElement | null;
        const amountBox = Array.from(dlg.querySelectorAll("input")).find(
          (i) => i.getAttribute("inputmode") === "decimal",
        ) as HTMLInputElement | undefined;
        assert(!!dateBox && !!amountBox, "lock: found the date and amount boxes");
        // The form refuses cash with no stated reason (see the block above),
        // so say one — this test is about dates, not about that.
        const why = Array.from(
          dlg.querySelectorAll(
            '[role="radiogroup"][aria-label="Reason for the cash movement"] [role="radio"]',
          ),
        ).find((b) => (b.textContent ?? "").trim() === "Owner put in") as
          | HTMLButtonElement
          | undefined;
        assert(!!why, "lock: found a reason to state");
        await act(async () => {
          why?.click();
        });
        await act(async () => {
          setInput(amountBox, amount);
        });
        await act(async () => {
          setInput(dateBox, day);
        });
        await settleMs(60);
        const submit = Array.from(dlg.querySelectorAll("button")).find((b) =>
          /Add Entry|Save Changes/.test((b.textContent ?? "").trim()),
        ) as HTMLButtonElement | undefined;
        assert(!!submit, `lock: found the submit button — ${submit?.textContent}`);
        await act(async () => {
          submit?.click();
        });
        await settleMs(180);
      };

      // Inside the closed period: refused, and nothing written.
      await enter(LOCKED_DAY, "500");
      assert(
        CashAdjustmentRepo.all().length === before,
        `lock: an entry dated inside a closed period is not written — ${CashAdjustmentRepo.all().length - before} appeared`,
      );

      // Outside it: the same screen still works. A lock that blocks
      // everything is an outage, not a lock.
      await renderRoute("/cash");
      await enter(OPEN_DAY, "500");
      assert(
        CashAdjustmentRepo.all().length === before + 1,
        `lock: an entry dated outside it still saves — ${CashAdjustmentRepo.all().length - before}`,
      );
      const saved = CashAdjustmentRepo.all().find((a) => a.date === OPEN_DAY);
      assert(!!saved, "lock: and it is the one that was entered");
      // Phase 0b's other half, seen through a real screen rather than a unit:
      assert(
        /^CV-\d{4}$/.test(saved?.voucherNo ?? ""),
        `lock: a cash entry gets a voucher reference — ${saved?.voucherNo}`,
      );

      /* Deleting inside a closed period is refused too. A delete changes a
         filed month's totals exactly as much as an edit does. */
      CashAdjustmentRepo.add({
        id: "LOCKED-CA",
        createdAt: "2026-01-01T00:00:00Z",
        date: LOCKED_DAY,
        type: "add",
        amount: 99,
        reason: "Inside the closed period",
      } as never);
      await renderRoute("/cash");
      const lockedRow = Array.from(
        document.querySelector(".data-table table")?.querySelectorAll("tbody tr") ?? [],
      ).find((tr) => (tr.textContent ?? "").includes("Inside the closed period"));
      assert(!!lockedRow, "lock: the entry inside the closed period is listed");
      const realConfirm = window.confirm;
      let asked = 0;
      window.confirm = () => {
        asked++;
        return true;
      };
      try {
        await act(async () => {
          (lockedRow?.querySelector('[title="Delete entry"]') as HTMLElement)?.click();
        });
        await settleMs(180);
      } finally {
        window.confirm = realConfirm;
      }
      assert(
        !!CashAdjustmentRepo.get("LOCKED-CA"),
        "lock: deleting inside a closed period leaves the entry alone",
      );
      assert(
        asked === 0,
        "lock: and refuses before asking — a prompt you cannot act on is worse than none",
      );
    } finally {
      CompanyRepo.save({ ...company, booksLockedUpto: undefined });
    }
  }

  /* ── Bulk Update with a real-sized catalogue ──────────────────────────
     The client's shop has ~1,400 items and the screen froze on open,
     because every row mounted at once and each carries several live
     inputs. It pages now — this proves only a page reaches the DOM, and
     that mounting stays fast enough to be usable. */
  for (let i = 0; i < 1400; i++) {
    ItemRepo.add({
      id: `BULK${i}`,
      createdAt: "2026-01-01T00:00:00Z",
      name: `Bulk Test Item ${i}`,
      unit: "pcs",
      gstRate: 18,
      purchasePrice: 100,
      salePrice: 150,
      stock: 5,
      openingStock: 5,
    } as never);
  }

  const bulkHost = document.createElement("div");
  document.body.appendChild(bulkHost);
  const bulkRoot = createRoot(bulkHost);
  const startedAt = performance.now();
  await act(async () => {
    bulkRoot.render(<BulkUpdateItemsDialog open onOpenChange={() => {}} onSaved={() => {}} />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 120));
  });
  const mountMs = performance.now() - startedAt;

  // The dialog portals into document.body, so count across the document.
  // The list is no longer paged — the whole catalogue scrolls — but only the
  // rows on screen are mounted (see useWindowedRows). Both the desktop table
  // and the phone card list exist at once (switched by CSS), so a window of
  // ~30 rows each with a name + several fields lands well under this ceiling.
  // Mounting all 1400 would be ~11,000 controls, which is what froze it.
  const inputCount = document.querySelectorAll("input").length;
  assert(
    inputCount > 0 && inputCount < 600,
    `bulk update: only a page of rows may mount — found ${inputCount} inputs for 1400+ items`,
  );
  assert(
    mountMs < 4000,
    `bulk update: opening with 1400 items must not hang — took ${Math.round(mountMs)}ms`,
  );
  // The dialog renders through a portal, so it is NOT inside bulkHost.
  assert(
    (document.body.textContent ?? "").includes("Bulk Update Items"),
    "bulk update: dialog actually rendered",
  );

  // The dialog's close button is absolutely positioned in the corner, so the
  // header content must not run underneath it — the tab group did, leaving
  // the X sitting on top of "Item Information".
  {
    const closeBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Close",
    );
    // Target THIS dialog's tab group by its label — other radiogroups
    // (payment ModePills) can still be in the document from earlier mounts.
    const tabs = document.querySelector('[role="radiogroup"][aria-label="What to update"]');
    assert(!!closeBtn, "bulk update: found the close button");
    assert(!!tabs, "bulk update: found the mode tabs");
    if (closeBtn && tabs) {
      const c = closeBtn.getBoundingClientRect();
      const t = tabs.getBoundingClientRect();
      const overlaps = t.right > c.left && t.left < c.right && t.bottom > c.top && t.top < c.bottom;
      assert(
        !overlaps,
        `bulk update: tabs must not sit under the close button — tabs ${Math.round(t.left)}..${Math.round(t.right)} x ${Math.round(t.top)}..${Math.round(t.bottom)}; X ${Math.round(c.left)}..${Math.round(c.right)} x ${Math.round(c.top)}..${Math.round(c.bottom)}; vw=${window.innerWidth}`,
      );
    }
  }
  bulkRoot.unmount();
  bulkHost.remove();

  if (root) root.unmount();
  if (host) host.remove();
  return R;
}

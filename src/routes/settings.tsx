import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import {
  CompanyRepo,
  REPO_BY_KEY,
  areReposHydrated,
  SalesRepo,
  PurchaseRepo,
  PaymentRepo,
  BankRepo,
  BankTxnRepo,
  ExpenseRepo,
  ItemRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  StockAdjustmentRepo,
  AuditLogRepo,
  SerialRepo,
} from "@/repositories";
import { newBatch, commitBatch } from "@/repositories/base";
import { planDataRepair, type DataRepairPlan, type DataRepairData } from "@/lib/dataRepair";
import { checkSerialIntegrity, type SerialAuditResult } from "@/lib/serialAudit";
import { useRepoData, useRepoMemo } from "@/hooks/useRepoData";
import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { today, fmtMoney, fmtDate } from "@/lib/format";
import { APP_NAME, APP_VERSION } from "@/lib/version";
import { auth, isBrowser } from "@/lib/firebase";
import { usePermissions } from "@/hooks/usePermissions";
import { TeamSection } from "@/components/TeamSection";
import { WhatsAppSection } from "@/components/WhatsAppSection";
import type { Company } from "@/types";
import {
  Settings as SettingsIcon,
  Building2,
  Database,
  Keyboard,
  Download,
  Upload,
  Trash2,
  ShieldCheck,
  Receipt,
  X,
  Plus,
  Users2,
  MessageCircle,
  Landmark,
  AlertTriangle,
  Lock,
} from "lucide-react";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  useRepoData();
  const [c, setC] = useState<Company>(() => CompanyRepo.get());
  const [busy, setBusy] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const userEmail = isBrowser ? (auth.currentUser?.email ?? "") : "";
  const { isOwner } = usePermissions();

  // Bank reconciliation (owner-only). A bug shipped for months stored the
  // WHOLE of invoice.paid as a bill's bank snapshot, so re-saving a
  // part-bank-paid bill after a Payment landed on it credited the account
  // with that payment's money a second time. The save path is fixed, but
  // balances already inflated in the live data stay inflated until they're
  // re-derived from the documents — that's what this does.
  const [bankPlan, setBankPlan] = useState<DataRepairPlan | null>(null);
  const [checkingBank, setCheckingBank] = useState(false);

  const bankRepairData = (): DataRepairData => ({
    sales: SalesRepo.all(),
    purchases: PurchaseRepo.all(),
    payments: PaymentRepo.all(),
    banks: BankRepo.all(),
    bankTxns: BankTxnRepo.all(),
    expenses: ExpenseRepo.all(),
    items: ItemRepo.all(),
    saleReturns: SaleReturnRepo.all(),
    purchaseReturns: PurchaseReturnRepo.all(),
    stockAdjustments: StockAdjustmentRepo.all(),
  });

  const checkBanks = () => {
    if (!areReposHydrated()) {
      toast.error("Still loading your data from the cloud — wait a moment and try again");
      return;
    }
    setCheckingBank(true);
    try {
      const plan = planDataRepair(bankRepairData());
      setBankPlan(plan);
      if (!plan.hasWork) toast.success("All bank balances match your transactions");
    } finally {
      setCheckingBank(false);
    }
  };

  const applyBankRepair = async () => {
    if (!areReposHydrated()) {
      toast.error("Still loading your data from the cloud — wait a moment and try again");
      return;
    }
    // Re-plan against the live cache rather than trusting the on-screen
    // report, which may have been produced minutes ago on another device's
    // data. This also makes the button safe to press twice.
    const plan = planDataRepair(bankRepairData());
    if (!plan.hasWork) {
      setBankPlan(plan);
      toast.success("Nothing to correct — balances already match");
      return;
    }
    if (
      !confirm(
        `Recalculate ${plan.accounts.length} bank balance(s), ${plan.items.length} item stock(s) and ${plan.bills.length} bill record(s)?

` +
          "These are the only running totals the app stores. They are rebuilt from your own " +
          "bills, payments, returns, deposits and adjustments. No bill, payment or return is " +
          "added, changed or deleted.",
      )
    )
      return;
    setBusy(true);
    try {
      const batch = newBatch();
      for (const b of plan.bills) {
        const repo = b.kind === "sale" ? SalesRepo : PurchaseRepo;
        repo.updateBatched(batch, b.id, { bankPaidAmount: b.correct });
      }
      for (const a of plan.accounts) {
        // Atomic increment of the shortfall, matching every other
        // bank-balance write in the app — never an absolute overwrite.
        BankRepo.adjustFieldBatched(batch, a.id, "balance", a.delta);
      }
      for (const it of plan.items) {
        // Same rule for stock: nudge by the difference so a sale landing
        // mid-repair still counts, rather than overwriting the total.
        ItemRepo.adjustFieldBatched(batch, it.id, "stock", it.delta);
      }
      if (!(await commitBatch(batch, "recalculate stored totals"))) {
        // The cache already holds the corrected figures, so claiming success
        // here would be the worst possible lie: the totals look repaired
        // until the rollback lands and puts the wrong ones back.
        setBankPlan(planDataRepair(bankRepairData()));
        toast.error("The corrections did not reach the cloud — reload the app and try again");
        return;
      }
      setBankPlan(planDataRepair(bankRepairData()));
      toast.success(
        `Corrected ${plan.accounts.length} bank balance(s), ${plan.items.length} item stock(s) and ${plan.bills.length} bill record(s)`,
      );
    } finally {
      setBusy(false);
    }
  };

  const companyRef = useRef<HTMLFormElement>(null);
  const categoriesRef = useRef<HTMLDivElement>(null);
  const teamRef = useRef<HTMLDivElement>(null);
  const whatsappRef = useRef<HTMLDivElement>(null);
  const bankRef = useRef<HTMLDivElement>(null);
  const [serialAudit, setSerialAudit] = useState<SerialAuditResult | null>(null);

  /**
   * Reports; never repairs.
   *
   * Every finding here has two possible fixes — move the unit, or correct the
   * document — and which is right depends on what physically happened in the
   * shop. An "Apply Corrections" button would have to guess, turning a
   * visible disagreement into an invisible wrong answer.
   *
   * Live documents only: a cancelled bill has stopped counting, so a unit it
   * names is not evidence of anything.
   */
  const runSerialCheck = () => {
    setSerialAudit(
      checkSerialIntegrity({
        serials: SerialRepo.all(),
        items: ItemRepo.all(),
        sales: SalesRepo.all(),
        purchases: PurchaseRepo.all(),
        saleReturns: SaleReturnRepo.all(),
        purchaseReturns: PurchaseReturnRepo.all(),
      }),
    );
  };
  const booksRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef<HTMLDivElement>(null);
  const shortcutsRef = useRef<HTMLDivElement>(null);

  const sections = [
    { key: "company", label: "Company Details", icon: Building2, ref: companyRef },
    { key: "categories", label: "Expense Categories", icon: Receipt, ref: categoriesRef },
    ...(isOwner ? [{ key: "team", label: "Team", icon: Users2, ref: teamRef }] : []),
    ...(isOwner
      ? [{ key: "whatsapp", label: "WhatsApp", icon: MessageCircle, ref: whatsappRef }]
      : []),
    ...(isOwner ? [{ key: "banks", label: "Fix Calculations", icon: Landmark, ref: bankRef }] : []),
    ...(isOwner ? [{ key: "books", label: "Close the Books", icon: Lock, ref: booksRef }] : []),
    { key: "data", label: "Account & Data", icon: Database, ref: dataRef },
    { key: "shortcuts", label: "Keyboard Shortcuts", icon: Keyboard, ref: shortcutsRef },
  ];
  const [activeSection, setActiveSection] = useState("company");

  // The lock date, edited before it is applied — typing into a date box should
  // not close the books on every keystroke.
  const [lockDate, setLockDate] = useState(c.booksLockedUpto ?? "");
  useEffect(() => {
    setLockDate(c.booksLockedUpto ?? "");
  }, [c.booksLockedUpto]);

  /* Deleted records, newest first.
   *
   * Hydrated HERE rather than at login: the log only grows, nobody needs it to
   * bill a customer, and loading it would slow every sign-in for a screen that
   * is opened once a month. */
  useEffect(() => {
    if (!isOwner) return;
    AuditLogRepo.hydrate().catch((err) => {
      console.error("Could not load the deletion log", err);
    });
  }, [isOwner]);
  const auditRows = useRepoMemo(() =>
    AuditLogRepo.all()
      .slice()
      .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")),
  );

  useEffect(() => {
    const els = sections
      .map((s) => ({ key: s.key, el: s.ref.current }))
      .filter((s): s is { key: string; el: HTMLDivElement } => !!s.el);
    if (!els.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length) {
          const top = visible.reduce((a, b) =>
            a.boundingClientRect.top < b.boundingClientRect.top ? a : b,
          );
          const match = els.find((s) => s.el === top.target);
          if (match) setActiveSection(match.key);
        }
      },
      { rootMargin: "-10% 0px -70% 0px" },
    );
    els.forEach((s) => observer.observe(s.el));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner]);

  // Category add/remove save immediately (like Export/Import below), rather
  // than waiting on the Company Details card's separate Save button, which
  // sits far enough away to feel disconnected from this action.
  const addCategory = () => {
    const name = newCategory.trim();
    if (!name) return;
    const existing = c.expenseCategories ?? [];
    if (existing.some((x) => x.toLowerCase() === name.toLowerCase())) {
      toast.error(`"${name}" is already in the list`);
      return;
    }
    const next = { ...c, expenseCategories: [...existing, name] };
    setC(next);
    CompanyRepo.save(next);
    setNewCategory("");
    toast.success(`"${name}" added`);
  };

  const removeCategory = (name: string) => {
    const next = { ...c, expenseCategories: (c.expenseCategories ?? []).filter((x) => x !== name) };
    setC(next);
    CompanyRepo.save(next);
    toast.success(`"${name}" removed`);
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    CompanyRepo.save(c);
    toast.success("Settings saved");
  };

  // Same file format as the old localStorage backups, so old backup files still restore
  const exportData = () => {
    // The app opens before the collections finish loading, so a backup taken
    // in those first seconds would quietly be missing whole sections while
    // still reporting success — the worst possible failure for a backup.
    if (!areReposHydrated()) {
      toast.error("Still loading your data from the cloud — wait a moment and try again");
      return;
    }
    const dump: Record<string, string> = {};
    for (const [key, repo] of Object.entries(REPO_BY_KEY)) {
      // Cancelled documents included, or a restored backup would bring
      // voided bills back to life — and the ledger's reversals with them.
      dump[key] = JSON.stringify(repo.allWithVoided());
    }
    dump["bz.company"] = JSON.stringify(CompanyRepo.get());
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bizdesk-backup-${today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Backup downloaded");
  };

  // A hand-edited or old/partial backup can carry invoice/return line items
  // missing numeric fields (qty, price, discountPct, gstRate). Left as-is,
  // those turn every GST/report total that touches them into NaN. Coerce to
  // 0 at the import boundary so bad data can never enter the system.
  type LooseRecord = Record<string, unknown> & { id: string };
  const sanitizeRecords = (records: LooseRecord[]): LooseRecord[] =>
    records.map((r) => {
      const lineItems = r?.lineItems;
      if (!Array.isArray(lineItems)) return r;
      return {
        ...r,
        lineItems: lineItems.map((l: LooseRecord) => ({
          ...l,
          qty: Number(l?.qty) || 0,
          price: Number(l?.price) || 0,
          discountPct: Number(l?.discountPct) || 0,
          gstRate: Number(l?.gstRate) || 0,
        })),
      };
    });

  const importData = async (file: File) => {
    try {
      const dump = JSON.parse(await file.text());
      if (typeof dump !== "object" || dump === null) throw new Error("Invalid file");
      const known = Object.keys(REPO_BY_KEY).filter((k) => dump[k] != null);
      const hasCompany = dump["bz.company"] != null;
      if (!known.length && !hasCompany) {
        toast.error(`No ${APP_NAME} data found in this file`);
        return;
      }
      if (
        !confirm(
          `Restore ${known.length + (hasCompany ? 1 : 0)} data sections from backup into the cloud? Records with the same ID will be overwritten.`,
        )
      )
        return;
      setBusy(true);
      for (const k of known) {
        const v = dump[k];
        const records = typeof v === "string" ? JSON.parse(v) : v;
        if (Array.isArray(records) && records.length) {
          await REPO_BY_KEY[k].importAll(sanitizeRecords(records));
        }
      }
      if (hasCompany) {
        const v = dump["bz.company"];
        CompanyRepo.save(typeof v === "string" ? JSON.parse(v) : v);
      }
      toast.success("Backup restored to cloud — reloading…");
      setTimeout(() => location.reload(), 800);
    } catch {
      setBusy(false);
      toast.error(`Could not read backup file — is it a valid ${APP_NAME} backup?`);
    }
  };

  const clearAll = async () => {
    // Same reason as exportData: on a partial cache this would delete only
    // what happens to have loaded and report "All data cleared".
    if (!areReposHydrated()) {
      toast.error("Still loading your data from the cloud — wait a moment and try again");
      return;
    }
    if (!confirm("Delete ALL business data from the cloud? This cannot be undone.")) return;
    if (
      !confirm(
        "Are you really sure? Every invoice, party, item and payment will be permanently deleted.",
      )
    )
      return;
    setBusy(true);
    try {
      for (const repo of Object.values(REPO_BY_KEY)) {
        await repo.clearAll();
      }
      toast.success("All data cleared");
      setTimeout(() => location.reload(), 600);
    } catch {
      setBusy(false);
      toast.error("Could not clear all data — check your connection");
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#f5f6fa]">
      <PageHeader
        title="Settings"
        subtitle="Company & preferences"
        icon={<SettingsIcon className="h-5 w-5" />}
      />
      <div className="flex-1 min-h-0 flex overflow-hidden">
        <nav className="w-56 shrink-0 border-r border-gray-100 bg-white/60 py-6 px-3 hidden md:block overflow-y-auto">
          <ul className="space-y-0.5">
            {sections.map((s) => (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() =>
                    s.ref.current?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] font-medium transition text-left ${
                    activeSection === s.key
                      ? "bg-primary-soft text-primary"
                      : "text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                  }`}
                >
                  <s.icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{s.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex-1 min-w-0 overflow-auto">
          <div className="p-4 sm:p-6 space-y-4 max-w-3xl mx-auto">
            <form
              ref={companyRef}
              onSubmit={save}
              className="bg-white border border-gray-100 rounded-lg shadow-sm overflow-hidden scroll-mt-6"
            >
              <SectionHeader
                icon={<Building2 className="h-4 w-4" />}
                title="Company Details"
                description="Shown on every invoice, bill, and printed document"
              />
              <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <Field
                    label="Company Name *"
                    value={c.name}
                    onChange={(e) => setC({ ...c, name: e.target.value })}
                  />
                </div>
                <Field
                  label="GSTIN"
                  value={c.gstin ?? ""}
                  onChange={(e) => setC({ ...c, gstin: e.target.value.toUpperCase() })}
                />
                <Field
                  label="Phone"
                  value={c.phone ?? ""}
                  onChange={(e) => setC({ ...c, phone: e.target.value })}
                />
                <Field
                  label="Email"
                  value={c.email ?? ""}
                  onChange={(e) => setC({ ...c, email: e.target.value })}
                />
                <Field
                  label="Currency"
                  value={c.currency}
                  onChange={(e) => setC({ ...c, currency: e.target.value.toUpperCase() })}
                />
                <Field
                  label="Invoice Prefix"
                  value={c.invoicePrefix}
                  onChange={(e) => setC({ ...c, invoicePrefix: e.target.value })}
                />
                <Field
                  label="Purchase Prefix"
                  value={c.purchasePrefix}
                  onChange={(e) => setC({ ...c, purchasePrefix: e.target.value })}
                />
                <div className="sm:col-span-2">
                  <Field
                    label="Address"
                    value={c.address ?? ""}
                    onChange={(e) => setC({ ...c, address: e.target.value })}
                  />
                </div>
                <div className="sm:col-span-2 space-y-2 pt-1">
                  <ToggleRow
                    checked={c.enableRoundOff !== false}
                    onChange={(v) => setC({ ...c, enableRoundOff: v })}
                    label="Round off invoice totals to nearest rupee"
                    hint="e.g. ₹487.37 → ₹487"
                  />
                  <ToggleRow
                    checked={c.allowNegativeStock !== false}
                    onChange={(v) => setC({ ...c, allowNegativeStock: v })}
                    label="Allow selling below available stock"
                    hint="Turn off to block sales/returns that would take stock negative"
                  />
                </div>
              </div>
              <div className="px-5 py-3 border-t bg-gray-50/60 flex justify-end">
                <Button type="submit">Save</Button>
              </div>
            </form>

            <div
              ref={categoriesRef}
              className="bg-white border border-gray-100 rounded-lg shadow-sm overflow-hidden scroll-mt-6"
            >
              <SectionHeader
                icon={<Receipt className="h-4 w-4" />}
                title="Expense Categories"
                description="The only categories staff can pick when recording an expense — add or remove them here, like a Chart of Accounts"
              />
              <div className="p-5">
                <div className="flex flex-wrap gap-2 mb-4">
                  {(c.expenseCategories ?? []).length === 0 && (
                    <p className="text-xs text-gray-400">No categories yet — add one below.</p>
                  )}
                  {(c.expenseCategories ?? []).map((cat) => (
                    <span
                      key={cat}
                      className="inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-full bg-primary-soft text-primary text-xs font-semibold"
                    >
                      {cat}
                      <button
                        type="button"
                        onClick={() => removeCategory(cat)}
                        className="rounded-full p-0.5 hover:bg-primary/20 transition"
                        title={`Remove "${cat}"`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCategory();
                      }
                    }}
                    placeholder="e.g. Marketing, Insurance…"
                    className="h-9 px-3 border rounded-md bg-background text-sm flex-1 focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none"
                  />
                  <Button type="button" onClick={addCategory}>
                    <Plus className="h-3.5 w-3.5" /> Add
                  </Button>
                </div>
              </div>
            </div>

            {isOwner && (
              <div
                ref={teamRef}
                className="bg-white border border-gray-100 rounded-lg shadow-sm overflow-hidden scroll-mt-6"
              >
                <SectionHeader
                  icon={<Users2 className="h-4 w-4" />}
                  title="Team"
                  description="Give staff their own login with only the sections they need — never a configurable permission for this Team page itself, so no one can grant themselves broader access"
                />
                <div className="p-5">
                  <TeamSection />
                </div>
              </div>
            )}

            {isOwner && (
              <div
                ref={whatsappRef}
                className="bg-white border border-gray-100 rounded-lg shadow-sm overflow-hidden scroll-mt-6"
              >
                <SectionHeader
                  icon={<MessageCircle className="h-4 w-4" />}
                  title="WhatsApp"
                  description="Send bills and party ledgers straight to a customer's WhatsApp with one click, from your own shop number"
                />
                <div className="p-5">
                  <WhatsAppSection />
                </div>
              </div>
            )}

            {isOwner && (
              <div
                ref={bankRef}
                className="bg-white border border-gray-100 rounded-lg shadow-sm overflow-hidden scroll-mt-6"
              >
                <SectionHeader
                  icon={<Landmark className="h-4 w-4" />}
                  title="Fix Calculations"
                  description="Rebuild stored totals from your own bills, payments and returns"
                />
                <div className="p-5">
                  <p className="text-xs text-gray-500 mb-4">
                    Rebuilds every <span className="font-semibold">stored running total</span> —
                    bank balances and item stock — from your own bills, purchases, returns,
                    payments, deposits and adjustments, and reports anything that has drifted from
                    what the documents say. Everything else (party balances, ledgers, statements,
                    P&amp;L, GST) is worked out fresh each time it's shown, so there is nothing
                    stored there to repair. Safe to run any time — checking changes nothing.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-2 sm:flex-wrap">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy || checkingBank}
                      onClick={checkBanks}
                      className="w-full sm:w-auto"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      {checkingBank ? "Checking…" : "Check Calculations"}
                    </Button>
                    {bankPlan?.hasWork && (
                      <Button
                        type="button"
                        disabled={busy}
                        onClick={applyBankRepair}
                        className="w-full sm:w-auto"
                      >
                        {busy ? "Correcting…" : "Apply Corrections"}
                      </Button>
                    )}
                  </div>

                  {/* Serial-tracked items have no stored total to rebuild —
                      their stock IS the unit list — so what can go wrong for
                      them is a different question, asked separately. */}
                  <div className="mt-5 pt-4 border-t border-gray-100">
                    <p className="text-xs text-gray-500 mb-3">
                      Items tracked by <span className="font-semibold">serial number</span> have no
                      stored total to rebuild — their stock is the list of units itself. What can go
                      wrong there is a unit and a document disagreeing, which this checks for. It
                      only ever reports: fixing one means either moving the unit or correcting the
                      document, and only you know which actually happened.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={runSerialCheck}
                      className="w-full sm:w-auto"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      Check Serial Numbers
                    </Button>

                    {serialAudit && !serialAudit.issues.length && (
                      <div className="mt-4 flex items-start gap-2 text-xs bg-emerald-50/60 border border-emerald-100 rounded-md px-3 py-2.5">
                        <ShieldCheck className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                        <p className="text-gray-700">
                          All {serialAudit.checked} unit{serialAudit.checked === 1 ? "" : "s"} agree
                          with the documents that moved them.
                          {serialAudit.untrackedLines > 0 && (
                            <>
                              {" "}
                              {serialAudit.untrackedLines} older bill line
                              {serialAudit.untrackedLines === 1 ? "" : "s"} carr
                              {serialAudit.untrackedLines === 1 ? "ies" : "y"} no units, from before
                              those items were switched on — expected, and nothing to fix.
                            </>
                          )}
                        </p>
                      </div>
                    )}

                    {serialAudit && serialAudit.issues.length > 0 && (
                      <div className="mt-4">
                        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                          Units that disagree with the documents ({serialAudit.issues.length})
                        </p>
                        <div className="border border-gray-100 rounded-md overflow-hidden max-h-64 overflow-y-auto">
                          {serialAudit.issues.map((iss, n) => (
                            <div
                              key={`${iss.kind}-${iss.serial ?? n}`}
                              className="px-3 py-2 text-xs border-b border-gray-100 last:border-b-0"
                            >
                              <span className="text-gray-800">{iss.message}</span>
                              {iss.itemName && (
                                <span className="text-gray-500"> · {iss.itemName}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {bankPlan && !bankPlan.hasWork && (
                    <div className="mt-4 flex items-start gap-2 text-xs bg-emerald-50/60 border border-emerald-100 rounded-md px-3 py-2.5">
                      <ShieldCheck className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                      <p className="text-gray-700">
                        Every stored total matches your documents exactly. Nothing to correct.
                      </p>
                    </div>
                  )}

                  {bankPlan?.hasWork && (
                    <div className="mt-4 space-y-4">
                      {bankPlan.items.length > 0 && (
                        <div>
                          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                            Item stock that doesn't match its movements ({bankPlan.items.length})
                          </p>
                          <div className="border border-gray-100 rounded-md overflow-hidden max-h-64 overflow-y-auto">
                            {bankPlan.items.map((i) => (
                              <div
                                key={i.id}
                                className="flex items-center justify-between gap-3 px-3 py-2 text-xs border-b border-gray-100 last:border-b-0"
                              >
                                <span className="font-medium text-gray-800 truncate">{i.name}</span>
                                <span className="tabular-nums shrink-0 text-gray-500">
                                  shows {i.stored} → should be{" "}
                                  <span
                                    className={
                                      i.delta < 0
                                        ? "font-semibold text-rose-600"
                                        : "font-semibold text-emerald-600"
                                    }
                                  >
                                    {i.correct} {i.unit}
                                  </span>
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {bankPlan.accounts.length > 0 && (
                        <div>
                          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                            Account balances that don't match ({bankPlan.accounts.length})
                          </p>
                          <div className="border border-gray-100 rounded-md overflow-hidden">
                            {bankPlan.accounts.map((a) => (
                              <div
                                key={a.id}
                                className="flex items-center justify-between gap-3 px-3 py-2 text-xs border-b border-gray-100 last:border-b-0"
                              >
                                <span className="font-medium text-gray-800 truncate">{a.name}</span>
                                <span className="tabular-nums shrink-0 text-gray-500">
                                  shows {fmtMoney(a.stored)} → should be{" "}
                                  <span
                                    className={
                                      a.delta < 0
                                        ? "font-semibold text-rose-600"
                                        : "font-semibold text-emerald-600"
                                    }
                                  >
                                    {fmtMoney(a.correct)}
                                  </span>
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {bankPlan.bills.length > 0 && (
                        <div>
                          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                            Bills whose recorded bank amount is wrong ({bankPlan.bills.length})
                          </p>
                          <div className="border border-gray-100 rounded-md overflow-hidden max-h-64 overflow-y-auto">
                            {bankPlan.bills.map((b) => (
                              <div
                                key={b.id}
                                className="flex items-center justify-between gap-3 px-3 py-2 text-xs border-b border-gray-100 last:border-b-0"
                              >
                                <span className="truncate">
                                  <span className="font-mono font-semibold text-gray-800">
                                    {b.number}
                                  </span>{" "}
                                  <span className="text-gray-500">{b.partyName}</span>
                                </span>
                                <span className="tabular-nums shrink-0 text-gray-500">
                                  {fmtMoney(b.stored)} → {fmtMoney(b.correct)}
                                </span>
                              </div>
                            ))}
                          </div>
                          <p className="text-[11px] text-gray-400 mt-1.5">
                            These bills were part-paid by bank and later settled through the
                            Payments page. Only the amount that genuinely went through the bank
                            counts against the account — the rest already moved under its own
                            payment mode.
                          </p>
                        </div>
                      )}
                      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-md px-3 py-2.5">
                        Take a backup (Account &amp; Data below) before applying, so you always have
                        a copy of the current figures.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {isOwner && (
              <div
                ref={booksRef}
                className="bg-white border border-gray-100 rounded-lg shadow-sm overflow-hidden scroll-mt-6"
              >
                <SectionHeader
                  icon={<Lock className="h-4 w-4" />}
                  title="Close the Books"
                  description="Stop a filed period from changing, and see what has been deleted"
                />
                <div className="p-5 space-y-6">
                  {/* Period lock. The one control in the app that exists for an
                      outside party: once GSTR-1 and 3B are filed for a month,
                      that month is a statement to the tax authority, and a bill
                      inside it that can still be edited means the books stop
                      matching the return that was filed. */}
                  <div>
                    <p className="text-xs text-gray-500 mb-3">
                      Nothing dated on or before this can be added, changed or deleted. Set it to
                      the last day of the period you have filed GST for. Leave it empty while you
                      are still working on the current month.
                    </p>
                    <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3">
                      <label className="flex flex-col gap-1 text-[12px]">
                        <span className="font-semibold text-gray-600">Books locked up to</span>
                        <input
                          type="date"
                          aria-label="Books locked up to"
                          value={lockDate}
                          onChange={(e) => setLockDate(e.target.value)}
                          className="h-9 px-2 border border-gray-200 rounded-md bg-white text-sm focus:border-primary outline-none"
                        />
                      </label>
                      <Button
                        size="sm"
                        onClick={() => {
                          CompanyRepo.save({
                            ...CompanyRepo.get(),
                            booksLockedUpto: lockDate || undefined,
                          });
                          toast.success(
                            lockDate
                              ? `Books locked up to ${fmtDate(lockDate)}`
                              : "Books unlocked — every period can be changed again",
                          );
                        }}
                      >
                        {lockDate ? "Lock" : "Unlock"}
                      </Button>
                      {c.booksLockedUpto && (
                        <p className="text-[12px] text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-md px-3 py-2">
                          Currently locked up to{" "}
                          <span className="font-semibold">{fmtDate(c.booksLockedUpto)}</span>
                        </p>
                      )}
                    </div>
                    <p className="text-[11px] text-gray-400 mt-2">
                      Fix Calculations above is deliberately exempt: it only corrects stored totals
                      to match the documents that are already there, and never changes a document.
                    </p>
                  </div>

                  {/* Deleted records. The record itself is gone; this is the
                      only place its contents still exist. */}
                  <div className="border-t border-gray-100 pt-5">
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <div>
                        <p className="text-[13px] font-semibold text-gray-700">Deleted records</p>
                        <p className="text-xs text-gray-500">
                          Who deleted what, and what it said at the time
                        </p>
                      </div>
                      <span className="text-[12px] text-gray-400 tabular-nums shrink-0">
                        {auditRows.length} {auditRows.length === 1 ? "entry" : "entries"}
                      </span>
                    </div>
                    {auditRows.length === 0 ? (
                      <p className="text-xs text-gray-400 bg-gray-50 border rounded-md px-3 py-2.5">
                        Nothing has been deleted since this started being recorded.
                      </p>
                    ) : (
                      <div className="border rounded-md divide-y divide-gray-100 max-h-72 overflow-auto">
                        {auditRows.map((e) => (
                          <details key={e.id} className="group">
                            <summary className="px-3 py-2 flex items-center gap-3 cursor-pointer hover:bg-gray-50 text-[12px]">
                              <span className="tabular-nums text-gray-500 shrink-0">
                                {fmtDate(e.at)}
                              </span>
                              <span className="font-medium text-gray-700 shrink-0">
                                {e.collection}
                              </span>
                              <span className="truncate flex-1 text-gray-600">
                                {e.summary ?? e.recordId}
                              </span>
                              <span className="text-gray-400 shrink-0 truncate max-w-[160px]">
                                {e.by ?? "unknown"}
                              </span>
                            </summary>
                            {/* The whole record as it stood — a summary answers
                                "was it deleted", the contents answer "what did
                                it say", which is the question that actually
                                gets asked. */}
                            <pre className="px-3 pb-3 text-[11px] text-gray-500 whitespace-pre-wrap break-all">
                              {JSON.stringify(e.snapshot, null, 1)}
                            </pre>
                          </details>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div
              ref={dataRef}
              className="bg-white border border-gray-100 rounded-lg shadow-sm overflow-hidden scroll-mt-6"
            >
              <SectionHeader
                icon={<Database className="h-4 w-4" />}
                title="Account & Data"
                description="Backups, restore, and cloud sync status"
              />
              <div className="p-5">
                {userEmail && (
                  <div className="flex items-start gap-2 text-xs text-gray-500 mb-4 bg-emerald-50/60 border border-emerald-100 rounded-md px-3 py-2.5">
                    <ShieldCheck className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                    <p>
                      Signed in as <span className="font-semibold text-gray-800">{userEmail}</span>{" "}
                      · Data is stored securely in the cloud (Firebase) and works offline too. · App
                      version: {APP_VERSION}
                    </p>
                  </div>
                )}
                <div className="flex flex-col sm:flex-row gap-2 sm:flex-wrap">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={exportData}
                    className="w-full sm:w-auto"
                  >
                    <Download className="h-3.5 w-3.5" /> Export Backup (JSON)
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => importRef.current?.click()}
                    className="w-full sm:w-auto"
                  >
                    <Upload className="h-3.5 w-3.5" /> Import Backup
                  </Button>
                  <input
                    ref={importRef}
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) importData(file);
                      e.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={busy}
                    onClick={clearAll}
                    className="w-full sm:w-auto"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Clear All Data
                  </Button>
                </div>
                <p className="text-xs text-gray-400 mt-3">
                  Backups download as JSON files. Old backups from the localStorage version restore
                  fine too.
                </p>
              </div>
            </div>

            <div
              ref={shortcutsRef}
              className="bg-white border border-gray-100 rounded-lg shadow-sm overflow-hidden scroll-mt-6"
            >
              <SectionHeader icon={<Keyboard className="h-4 w-4" />} title="Keyboard Shortcuts" />
              <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                {[
                  ["Ctrl+F", "Global search"],
                  ["Ctrl+N", "New sale"],
                  ["Ctrl+P", "New purchase"],
                  ["Ctrl+S", "Save form"],
                  ["Alt+1..8", "Jump to module"],
                  ["N", "New record (in list)"],
                  ["Tab / Enter", "Next field"],
                  ["Shift+Tab", "Previous field"],
                  ["Esc", "Close dialog / cancel"],
                  ["↑ ↓", "Navigate rows / suggestions"],
                  ["Enter", "Open / select"],
                  ["Ctrl+Delete", "Delete row"],
                ].map(([k, l]) => (
                  <div
                    key={k}
                    className="flex items-center justify-between border-b border-gray-100 py-1.5"
                  >
                    <kbd className="font-mono text-[11px] bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5 text-gray-600">
                      {k}
                    </kbd>
                    <span className="text-gray-500">{l}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div className="px-5 py-3.5 border-b border-gray-100 flex items-center gap-3">
      <div className="h-8 w-8 rounded-md bg-primary-soft text-primary flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <h2 className="font-bold text-[14px] text-gray-800">{title}</h2>
        {description && <p className="text-[11px] text-gray-400 mt-0.5">{description}</p>}
      </div>
    </div>
  );
}

function ToggleRow({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex items-start gap-3 rounded-md border border-gray-100 bg-gray-50/60 px-3 py-2.5 cursor-pointer select-none hover:bg-gray-50 transition">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-primary mt-0.5 shrink-0"
      />
      <span>
        <span className="block text-[13px] font-medium text-gray-800">{label}</span>
        <span className="block text-[11px] text-gray-400 mt-0.5">{hint}</span>
      </span>
    </label>
  );
}

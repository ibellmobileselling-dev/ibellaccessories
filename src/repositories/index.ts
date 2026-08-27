import { collection, doc, onSnapshot, setDoc, updateDoc, writeBatch } from "firebase/firestore";
import { Repository, handlePostHydrationError, emitRepoChange, setDeletionRecorder } from "./base";
export { subscribeRepos, repoStoreVersion } from "./base";
import { db, isBrowser } from "@/lib/firebase";
import { toast } from "sonner";
import type {
  Party,
  Item,
  Invoice,
  Expense,
  Payee,
  BankAccount,
  BankTxn,
  Payment,
  Return,
  Company,
  StockAdjustment,
  CashAdjustment,
  JournalEntryDoc,
  AuditEntry,
  TeamUser,
  ModuleKey,
} from "@/types";

export const PartyRepo = new Repository<Party>("parties");
export const ItemRepo = new Repository<Item>("items");
export const SalesRepo = new Repository<Invoice>("sales");
export const PurchaseRepo = new Repository<Invoice>("purchases");
export const SaleReturnRepo = new Repository<Return>("sale-returns");
export const PurchaseReturnRepo = new Repository<Return>("purchase-returns");
export const ExpenseRepo = new Repository<Expense>("expenses");
export const PayeeRepo = new Repository<Payee>("payees");
export const BankRepo = new Repository<BankAccount>("banks");
export const BankTxnRepo = new Repository<BankTxn>("bankTxns");
export const PaymentRepo = new Repository<Payment>("payments");
export const StockAdjustmentRepo = new Repository<StockAdjustment>("stock-adjustments");
export const CashAdjustmentRepo = new Repository<CashAdjustment>("cash-adjustments");
/**
 * Journal entries that no document implies — today, year-end closing entries.
 *
 * Hydrated with everything else and included in backups, unlike the audit log:
 * a closing entry exists nowhere but here, and every balance sheet after it
 * depends on it. A backup without it would restore a shop whose years had
 * silently re-opened.
 */
export const LedgerEntryRepo = new Repository<JournalEntryDoc>("ledger-entries");

const defaultCompany: Company = {
  name: "My Company",
  currency: "INR",
  invoicePrefix: "INV-",
  purchasePrefix: "PUR-",
  enableGst: true,
  allowNegativeStock: true,
  expenseCategories: [
    "Salary",
    "Rent",
    "Electricity",
    "Fuel",
    "Office Supplies",
    "Maintenance & Repairs",
    "Transport & Freight",
    "Telephone & Internet",
    "Miscellaneous",
  ],
};

/** Company settings live in a single Firestore doc: settings/company */
let companyCache: Company = defaultCompany;
let companyUnsub: (() => void) | undefined;
let companyExists = false;

function hydrateCompany(): Promise<void> {
  if (!isBrowser || companyUnsub) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let first = true;
    companyUnsub = onSnapshot(
      doc(db, "settings", "company"),
      (snap) => {
        companyExists = snap.exists();
        companyCache = snap.exists()
          ? { ...defaultCompany, ...(snap.data() as Company) }
          : defaultCompany;
        // Company settings are read in render all over the app (invoice
        // prefix, round-off, print format, company name on every printout),
        // so they belong in the same reactive store as the collections —
        // otherwise a change only showed up after an unrelated re-render,
        // which the Topbar used to paper over with a 2-second poll.
        emitRepoChange();
        if (first) {
          first = false;
          resolve();
        }
      },
      (err) => {
        if (first) {
          console.error("Failed to load company settings", err);
          first = false;
          reject(err);
        } else handlePostHydrationError(err, "settings/company");
      },
    );
  });
}

/**
 * Deleted records, kept because the record itself is gone.
 *
 * Several staff have delete rights, so "what happened to invoice 0047" has no
 * answer at all without this — the row is simply not there any more. The whole
 * record is stored, not a summary, so the answer includes what it said.
 *
 * NOT hydrated at login: it only grows, nobody needs it to bill a customer,
 * and loading it would slow every sign-in for a screen that is opened once a
 * month. Settings hydrates it on demand. Writes do not need hydration — they
 * are cache-first like every other write.
 */
export const AuditLogRepo = new Repository<AuditEntry>("audit-log");

/** A line a person can pick out of a list. Falls back to the record's own
 *  identifying fields, since collections name that field differently. */
function describe(record: Record<string, unknown>): string {
  const bits = [
    record.number,
    record.name,
    record.partyName,
    record.payeeName,
    record.category,
    record.reason,
    record.notes,
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  const amount = [record.total, record.amount].find((v) => typeof v === "number");
  if (typeof amount === "number") bits.push(String(amount));
  return bits.slice(0, 3).join(" · ");
}

// Wire base.ts's deletion hook. It cannot import this file — AuditLogRepo is
// itself a Repository, so the import would be circular.
setDeletionRecorder((collectionName, record, batch, action) => {
  // Never audit the audit log: clearing an old entry would write a new one
  // describing the entry it just removed, forever.
  if (collectionName === "audit-log") return;
  const entry = {
    action,
    collection: collectionName,
    recordId: record.id,
    snapshot: record,
    summary: describe(record) || undefined,
    at: new Date().toISOString(),
  };
  // On the caller's batch when there is one, so the log and the deletion
  // succeed or fail together.
  if (batch) AuditLogRepo.addBatched(batch, entry);
  else AuditLogRepo.add(entry);
});

export const CompanyRepo = {
  get(): Company {
    return companyCache;
  },
  save(c: Company) {
    companyCache = c;
    companyExists = true;
    emitRepoChange();
    if (isBrowser) {
      setDoc(doc(db, "settings", "company"), c).catch((err) => {
        console.error("Failed to save company settings", err);
        toast.error("Could not save settings to cloud. Check internet & try again.");
      });
    }
  },
};

/**
 * The signed-in user's own permissions doc: teamUsers/{uid}. Every user can
 * always read their own doc (enforced by Firestore rules) — this is what the
 * whole permission system, including hydrateRepos below, is built on.
 *
 * If the doc doesn't exist yet, this is either (a) the very first login ever
 * on this business, in which case it self-provisions as owner, or (b) a real
 * team member whose doc hasn't landed yet (e.g. the admin's create-user call
 * is still in flight) — those two cases are told apart by a Firestore rule,
 * not by client logic: a client write of isOwner:true is only ever accepted
 * once, gated by system/bootstrap.ownerCreated, and that same write flips the
 * lock atomically so a second, later "doc missing" case can never also
 * become owner. If the write is rejected, this account just has no
 * permissions yet — not a crash, not owner access, nothing until the real
 * admin-created doc appears.
 */
let teamUserCache: TeamUser | null = null;
let teamUserUnsub: (() => void) | undefined;

// Plain pub-sub so React can subscribe to live changes (useSyncExternalStore
// in usePermissions, see src/hooks/usePermissions.ts) — unlike the rest of
// this app's repos, permission checks need to react immediately if an
// owner changes or revokes someone's access mid-session, not just after
// that page's own next manual refresh.
const teamUserListeners = new Set<() => void>();
export function subscribeTeamUser(cb: () => void): () => void {
  teamUserListeners.add(cb);
  return () => teamUserListeners.delete(cb);
}
function setTeamUserCache(v: TeamUser | null) {
  teamUserCache = v;
  teamUserListeners.forEach((cb) => cb());
}

function attemptOwnerBootstrap(uid: string, email: string): Promise<void> {
  const batch = writeBatch(db);
  const now = new Date().toISOString();
  batch.set(doc(db, "teamUsers", uid), {
    id: uid,
    email,
    name: email.split("@")[0],
    isOwner: true,
    active: true,
    permissions: {},
    createdAt: now,
  } satisfies TeamUser);
  batch.set(doc(db, "system", "bootstrap"), { ownerCreated: true });
  return batch.commit();
}

function hydrateCurrentTeamUser(uid: string, email: string): Promise<void> {
  if (!isBrowser) return Promise.resolve();
  if (teamUserUnsub) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let first = true;
    let bootstrapAttempted = false;
    teamUserUnsub = onSnapshot(
      doc(db, "teamUsers", uid),
      (snap) => {
        if (snap.exists()) {
          setTeamUserCache(snap.data() as TeamUser);
          if (first) {
            first = false;
            resolve();
          }
          return;
        }
        setTeamUserCache(null);
        if (bootstrapAttempted) {
          if (first) {
            first = false;
            resolve();
          }
          return;
        }
        bootstrapAttempted = true;
        attemptOwnerBootstrap(uid, email)
          .catch(() => {
            // Not eligible (someone already owns this business) — this
            // account has no access until an admin creates a real doc for
            // it. onSnapshot will fire again on its own once that happens.
          })
          .finally(() => {
            if (first) {
              first = false;
              resolve();
            }
          });
      },
      (err) => {
        if (first) {
          console.error("Failed to load team user", err);
          first = false;
          reject(err);
        } else handlePostHydrationError(err, "teamUsers");
      },
    );
  });
}

/** Full team roster — owner-only (Firestore rules deny this list query to
 * anyone else), used by Settings → Team. Kept separate from the main boot
 * sequence: only fetched when the Team management page is actually open. */
let teamRosterCache: TeamUser[] = [];
let teamRosterUnsub: (() => void) | undefined;
const teamRosterListeners = new Set<() => void>();
export function subscribeTeamRoster(cb: () => void): () => void {
  teamRosterListeners.add(cb);
  return () => teamRosterListeners.delete(cb);
}

function hydrateTeamRoster(): Promise<void> {
  if (!isBrowser) return Promise.resolve();
  if (teamRosterUnsub) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let first = true;
    teamRosterUnsub = onSnapshot(
      collection(db, "teamUsers"),
      (snap) => {
        teamRosterCache = snap.docs.map((d) => d.data() as TeamUser);
        teamRosterListeners.forEach((cb) => cb());
        if (first) {
          first = false;
          resolve();
        }
      },
      (err) => {
        if (first) {
          first = false;
          reject(err);
        }
      },
    );
  });
}

function stopTeamRoster() {
  teamRosterUnsub?.();
  teamRosterUnsub = undefined;
  teamRosterCache = [];
  teamRosterListeners.forEach((cb) => cb());
}

export const TeamUserRepo = {
  /** The signed-in user's own permissions doc, or null if none exists yet. */
  current(): TeamUser | null {
    return teamUserCache;
  },
  /** Owner-only — see hydrateTeamRoster. */
  roster(): TeamUser[] {
    return teamRosterCache;
  },
  hydrateRoster: hydrateTeamRoster,
  stopRoster: stopTeamRoster,
  /** Update a team member's permissions/active flag — owner-only per
   * firestore.rules (which also independently blocks ever touching an
   * isOwner:true doc, including the owner's own, through this same path). */
  async update(uid: string, patch: Partial<Pick<TeamUser, "active" | "permissions" | "name">>) {
    await updateDoc(doc(db, "teamUsers", uid), patch);
  },
};

/** Map of legacy localStorage keys → repositories (backup files & migration). */
export const REPO_BY_KEY: Record<string, Repository<{ id: string }>> = {
  "bz.parties": PartyRepo as Repository<{ id: string }>,
  "bz.items": ItemRepo as Repository<{ id: string }>,
  "bz.sales": SalesRepo as Repository<{ id: string }>,
  "bz.purchases": PurchaseRepo as Repository<{ id: string }>,
  "bz.sale-returns": SaleReturnRepo as Repository<{ id: string }>,
  "bz.purchase-returns": PurchaseReturnRepo as Repository<{ id: string }>,
  "bz.expenses": ExpenseRepo as Repository<{ id: string }>,
  "bz.payees": PayeeRepo as Repository<{ id: string }>,
  "bz.banks": BankRepo as Repository<{ id: string }>,
  "bz.bankTxns": BankTxnRepo as Repository<{ id: string }>,
  "bz.payments": PaymentRepo as Repository<{ id: string }>,
  "bz.stock-adjustments": StockAdjustmentRepo as Repository<{ id: string }>,
  "bz.cash-adjustments": CashAdjustmentRepo as Repository<{ id: string }>,
  "bz.ledger-entries": LedgerEntryRepo as Repository<{ id: string }>,
};

const ALL_REPOS = Object.values(REPO_BY_KEY);

/** Which repos back each permission module — used to decide what a
 * non-owner's device actually downloads. Cross-checked against every real
 * collection above, not just the Sidebar's page names ("reports" has none of
 * its own; it only aggregates reads across the others, already covered by
 * their own module here). */
const MODULE_REPOS: Record<ModuleKey, Repository<{ id: string }>[]> = {
  masterData: [PartyRepo, ItemRepo, StockAdjustmentRepo] as Repository<{ id: string }>[],
  sales: [SalesRepo, SaleReturnRepo] as Repository<{ id: string }>[],
  purchaseExpenses: [PurchaseRepo, PurchaseReturnRepo, ExpenseRepo, PayeeRepo] as Repository<{
    id: string;
  }>[],
  cashBank: [BankRepo, BankTxnRepo, PaymentRepo, CashAdjustmentRepo] as Repository<{
    id: string;
  }>[],
  // The only collection the reports module owns: closing entries are read by
  // the balance sheet and written by the year close, both of which live there.
  reports: [LedgerEntryRepo] as Repository<{ id: string }>[],
};

/**
 * Load everything after login. The owner's experience is byte-for-byte
 * unchanged from before this feature existed: every collection, always. A
 * non-owner only ever has the repos for modules they hold `view` on
 * subscribed at all — a module they can't view is never downloaded to this
 * device's memory or local cache, not just hidden in the UI afterward. That
 * distinction is the whole point: "View: off" has to mean the data never
 * arrives, not that it arrives and is merely not displayed.
 */
let backgroundHydration: Promise<void> | null = null;
// Synchronous counterpart to whenReposHydrated() — for callers that must not
// act on a half-loaded cache and can't await (see areReposHydrated).
let hydrationComplete = false;

export async function hydrateRepos(uid: string, email: string): Promise<void> {
  hydrationComplete = false;
  // These two are small, awaited, and gate the whole app: permissions decide
  // what's even reachable, and company settings feed the shell (name, invoice
  // prefix). If EITHER fails (e.g. Firestore rules not deployed, or offline
  // with no cache) the caller shows the "couldn't load" screen.
  await Promise.all([hydrateCurrentTeamUser(uid, email), hydrateCompany()]);
  const me = teamUserCache;
  if (!me || !me.active) return; // no access at all yet — AuthGate handles this state
  const toHydrate = me.isOwner
    ? ALL_REPOS
    : (Object.keys(MODULE_REPOS) as ModuleKey[])
        .filter((m) => me.permissions[m]?.view)
        .flatMap((m) => MODULE_REPOS[m]);
  // Start every collection's live listener but DON'T block the app on them.
  // Screens are reactive (useRepoData), so they fill in the instant each
  // snapshot arrives. This is the difference between opening in ~1s and waiting
  // 30-40s for every collection's first server snapshot (worst on iOS Safari,
  // where a cold/evicted cache means each one is a fresh server round-trip).
  // A per-collection first-load failure is logged, not fatal — that one screen
  // just stays empty until it recovers, while the rest of the app works.
  backgroundHydration = Promise.all(
    toHydrate.map((r) =>
      r.hydrate().catch((err) => {
        console.error("Background collection hydration failed", err);
      }),
    ),
  ).then(() => {
    hydrationComplete = true;
  });
}

/**
 * True once every collection this user subscribes to has had its first
 * snapshot. Since v48 the app renders BEFORE that happens, so anything that
 * reads "all the data" in one go — taking a backup, wiping everything — has
 * to check this first or it silently operates on a partial cache. Screens
 * don't need it: they're reactive and fill in.
 */
export function areReposHydrated(): boolean {
  return hydrationComplete;
}

/** Resolves once every collection started by the last hydrateRepos() has had
 * its first snapshot. Used for the one-time localStorage→cloud migration, whose
 * "is the cloud empty?" check is only meaningful after data has loaded. */
export function whenReposHydrated(): Promise<void> {
  return backgroundHydration ?? Promise.resolve();
}

/** Stop all listeners and clear caches (on logout). */
export function stopRepos() {
  hydrationComplete = false;
  backgroundHydration = null;
  ALL_REPOS.forEach((r) => r.stop());
  companyUnsub?.();
  companyUnsub = undefined;
  companyCache = defaultCompany;
  companyExists = false;
  teamUserUnsub?.();
  teamUserUnsub = undefined;
  setTeamUserCache(null);
  stopTeamRoster();
}

/**
 * One-time migration: if the cloud is completely empty but this browser still
 * has old localStorage data, upload it. localStorage is left untouched as a
 * safety copy. Returns the number of migrated records.
 */
export async function migrateFromLocalStorage(): Promise<number> {
  if (!isBrowser) return 0;
  const cloudHasData = ALL_REPOS.some((r) => r.all().length > 0) || companyExists;
  if (cloudHasData) return 0;

  let migrated = 0;
  for (const [key, repo] of Object.entries(REPO_BY_KEY)) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const records = JSON.parse(raw) as { id: string }[];
      if (Array.isArray(records) && records.length) {
        await repo.importAll(records);
        migrated += records.length;
      }
    } catch (err) {
      console.error(`Migration of ${key} failed`, err);
    }
  }
  try {
    const rawCompany = localStorage.getItem("bz.company");
    if (rawCompany) CompanyRepo.save({ ...defaultCompany, ...JSON.parse(rawCompany) });
  } catch (err) {
    console.error("Migration of company settings failed", err);
  }
  return migrated;
}

/**
 * The next reference in a series, e.g. CV-0008.
 *
 * Same rule as nextInvoiceNumber and for the same reason: read the trailing
 * digits rather than stripping the current prefix, so numbers issued under an
 * older prefix are still visible to the max() and cannot be reissued.
 *
 * Allocated from the cache at save time. Two cashiers saving in the same second
 * could in principle land on the same number — which is why this is used for
 * REFERENCES and never as a key. A duplicated reference is untidy; a duplicated
 * key would be corruption.
 */
export function nextVoucherNo(prefix: string, existing: { voucherNo?: string }[]): string {
  // Callers pass allWithVoided(): a voided document's number is spent, not
  // free. Two entries answering to CV-0007 is exactly what a voucher
  // reference exists to prevent.
  const nums = existing
    .map((e) => {
      const m = (e.voucherNo ?? "").match(/(\d+)\s*$/);
      return m ? parseInt(m[1], 10) : NaN;
    })
    .filter((n) => !isNaN(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

export function nextInvoiceNumber(prefix: string, existing: { number: string }[]): string {
  // Read the trailing digit run instead of stripping the CURRENT prefix —
  // if the prefix is ever changed in Settings, older numbers (saved under
  // the old prefix) would otherwise be invisible to the max() below and
  // could get reissued once the prefix is changed back.
  const nums = existing
    .map((i) => {
      const m = i.number.match(/(\d+)\s*$/);
      return m ? parseInt(m[1], 10) : NaN;
    })
    .filter((n) => !isNaN(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

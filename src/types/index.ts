export type ID = string;

export interface Party {
  id: ID;
  name: string;
  type: "customer" | "supplier" | "both";
  phone?: string;
  email?: string;
  gstin?: string;
  address?: string;
  shippingAddress?: string;
  openingBalance: number;
  creditLimit?: number;
  /** Soft-delete flag. An archived party is hidden from new-transaction
   * pickers and the active parties list, but its document is kept so every
   * existing invoice/payment/return, ledger, statement, report and dashboard
   * total that references it stays intact. Absence of the field means active
   * — so every party that predates this feature is active automatically. */
  archived?: boolean;
  createdAt: string;
}

export interface Item {
  id: ID;
  name: string;
  sku?: string;
  barcode?: string;
  category?: string;
  unit: string;
  hsn?: string;
  gstRate: number;
  purchasePrice: number;
  salePrice: number;
  wholesalePrice?: number;
  stock: number;
  minStock?: number;
  openingStock: number;
  description?: string;
  createdAt: string;
}

export interface LineItem {
  id: ID;
  itemId: ID;
  name: string;
  qty: number;
  unit: string;
  price: number;
  discountPct: number;
  gstRate: number;
  amount: number;
  /** Snapshot of the item's purchase price when the line was created — used for stock-based COGS in P&L */
  costPrice?: number;
  /** Price in the foreign currency, before conversion — only set on
   * international purchases. `price` (INR) is auto-derived from this via
   * the parent Invoice's exchangeRate/carryCostPerUnit, but stays a normal
   * editable field so a cashier can still override the computed value. */
  foreignPrice?: number;
}

export type PaymentMode = "cash" | "bank" | "credit" | "upi" | "cheque";

export interface Invoice extends Voidable {
  id: ID;
  number: string;
  date: string;
  partyId: ID;
  partyName: string;
  partyPhone?: string;
  gstEnabled?: boolean;
  lineItems: LineItem[];
  subtotal: number;
  discount: number;
  /** Flat shipping/freight charge added to the total (sale bills only). */
  shippingCharge?: number;
  taxAmount: number;
  /** Rounding applied to reach a whole-rupee total (e.g. −0.37 or +0.45) */
  roundOff?: number;
  total: number;
  paid: number;
  paymentMode: PaymentMode;
  /** Which bank account `paid` was collected into/from — only set when paymentMode is "bank". */
  bankId?: ID;
  /** Snapshot of `paid` at the moment it was attributed to bankId, so an edit can
   * reverse exactly that amount even if `paid` later grows via Payment allocations. */
  bankPaidAmount?: number;
  /** Purchase bills only — each line's `foreignPrice` (in the supplier's
   * currency) gets converted to INR as `foreignPrice * exchangeRate +
   * carryCostPerUnit`, so the landed per-unit cost (currency conversion +
   * freight/customs, per piece) is baked into the same `price` field
   * everything else (GST, discount, stock costing) already works off. */
  isInternational?: boolean;
  /** 1 unit of the foreign currency, in INR. */
  exchangeRate?: number;
  /** Flat per-piece freight/customs/handling cost, in INR, added on top of
   * the converted price — distinct from `shippingCharge` (a whole-bill
   * flat charge) since this applies per unit, before qty is multiplied in. */
  carryCostPerUnit?: number;
  notes?: string;
  createdAt: string;
}

/**
 * Who an expense was actually paid to (an employee, landlord, vendor...) —
 * separate from Category (what kind of expense it is), so "how much have I
 * paid Vikas, ever" is answerable without re-deriving it from free text.
 * Deliberately lightweight (no phone/GSTIN/balance like Party) — this is
 * just a name, grown organically as expenses are entered, not a form the
 * user fills out up front.
 */
export interface Payee {
  id: ID;
  name: string;
  /** Pre-fills Category when this payee is picked on a new expense — cuts
   * down on miscategorized entries for a payee that's (almost) always the
   * same kind of spend, e.g. picking "Vikas" always suggesting "Salary". */
  defaultCategory?: string;
  createdAt: string;
}

export interface Expense extends Voidable {
  id: ID;
  date: string;
  category: string;
  amount: number;
  paymentMode: PaymentMode;
  /** Which bank account this was paid from — only set when paymentMode is "bank". */
  bankId?: ID;
  /** Who this was actually paid to — see Payee. Optional on the type so
   * older records saved before this existed still load; the expense form
   * requires it going forward. */
  payeeId?: ID;
  payeeName?: string;
  notes?: string;
  createdAt: string;
}

export interface BankAccount {
  id: ID;
  name: string;
  accountNumber?: string;
  ifsc?: string;
  openingBalance: number;
  balance: number;
  createdAt: string;
}

/** Physical stock correction (damage, counting difference, samples…) */
export interface StockAdjustment {
  id: ID;
  itemId: ID;
  itemName: string;
  date: string;
  type: "add" | "reduce";
  qty: number;
  reason?: string;
  createdAt: string;
}

/** Manual cash-in-hand correction (counter counting, owner drawings…) */
export interface CashAdjustment extends Voidable {
  id: ID;
  /** Why the cash moved, when no bill or payment explains it — the second
   * side of the entry. See lib/cashPurpose.ts. Absent on entries made before
   * this was asked for; those read as "Uncategorised" rather than being
   * guessed at, because a wrong reason is worse than a missing one. */
  purpose?: CashPurpose;
  /** Voucher reference, e.g. CV-0007. Absent on entries made before these
   *  were issued. */
  voucherNo?: string;
  date: string;
  type: "add" | "reduce";
  amount: number;
  reason?: string;
  /** Set when this row is one leg of a transfer between accounts. Deleting
   * either leg has to take the other with it, or the money is left half
   * moved — out of one account and never into the other. */
  transferId?: ID;
  createdAt: string;
}

export interface BankTxn extends Voidable {
  id: ID;
  /** Voucher reference — BV-0007 for a deposit or withdrawal, and the SAME
   *  TR-0007 on both legs of a transfer, because a transfer is one voucher. */
  voucherNo?: string;
  bankId: ID;
  date: string;
  type: "deposit" | "withdraw" | "transfer";
  amount: number;
  notes?: string;
  /** See CashAdjustment.transferId — the same pairing, from the bank side. */
  transferId?: ID;
  createdAt: string;
}

/** How much of a payment was applied to which invoice — needed to reverse
 * invoice.paid when the payment is deleted, and to avoid double counting
 * in ledgers/cash reports. */
export interface PaymentAllocation {
  invoiceId: ID;
  number: string;
  /** Cash/bank actually applied to this invoice. */
  amount: number;
  /**
   * Amount written off on this invoice at the moment of settlement — a
   * "settlement discount". Collecting 20,000 against a 20,500 bill and
   * waiving the last 500 closes the bill without inventing 500 of cash:
   * the invoice's `paid` moves by amount + discount, while only `amount`
   * ever reaches the cash or bank position. The waived part is real cost to
   * the business, so the P&L subtracts it (see valueExTax/discountAllowed).
   */
  discount?: number;
}

export interface Payment extends Voidable {
  id: ID;
  date: string;
  partyId: ID;
  partyName: string;
  type: "in" | "out";
  amount: number;
  mode: PaymentMode;
  /** Which bank account this moved money into/out of — only set when mode is "bank". */
  bankId?: ID;
  ref?: string;
  allocations?: PaymentAllocation[];
  createdAt: string;
}

export interface Return extends Voidable {
  id: ID;
  number: string;
  date: string;
  originalRef?: string;
  partyId: ID;
  partyName: string;
  partyPhone?: string;
  gstEnabled?: boolean;
  lineItems: LineItem[];
  subtotal: number;
  taxAmount: number;
  total: number;
  notes?: string;
  createdAt: string;
}

/**
 * A journal entry that no document implies, so it has to be written down.
 *
 * Everything else in the posting ledger is derived from the bills, payments
 * and cash entries that caused it (see lib/posting.ts), which is why there is
 * no collection of ledger lines. This is the exception: closing a financial
 * year is a decision taken on a date by a person, not a consequence of a
 * document, and next year's opening position is built on it — so it is stored,
 * and it must not move once it is.
 */
export interface JournalEntryDoc extends Audited, Voidable {
  id: ID;
  date: string;
  /** "Closing Entry" today; manual journals will use their own. */
  voucherType: string;
  voucherNo?: string;
  /** "year-close" — the value the P&L and balance sheet branch on. */
  docKind: string;
  narration: string;
  lines: { accountId: string; debit: number; credit: number; partyId?: string }[];
  /** The year this closes, as a shop says it: "2025-26". */
  fyLabel?: string;
  createdAt: string;
}

export type PrintFormat = "a4" | "a4-2up" | "thermal80" | "thermal58";

/** Who touched a record, and when.
 *
 * Stamped centrally by Repository (see repositories/base.ts) rather than by
 * each call site, because a call site that forgets is exactly the record you
 * later need to account for. Every stored type carries these; they are
 * optional only because records written before this existed do not have them.
 */
import type { CashPurpose } from "@/lib/cashPurpose";
export type { CashPurpose };

/**
 * A document that was cancelled after the fact, and did not vanish.
 *
 * Deleting a bill that has already been reported on rewrites history: the
 * month it was in quietly becomes a different month, and nothing on any screen
 * says so. Voiding leaves the document where it is, stops every total counting
 * it, and posts a reversal into the ledger on the day it was cancelled — so
 * the books show both what happened and what undid it, which is what "the
 * accounts are a record" means.
 *
 * Same-day mistakes are still deleted outright. Nothing has been reported on
 * yet, there is nothing to preserve, and a shop that had to keep every
 * mis-tapped bill would stop using the software.
 */
export interface Voidable {
  /** When it was cancelled. Its absence is what makes a record live, so every
   *  document written before this existed is live automatically. */
  voidedAt?: string;
  voidedBy?: string;
  /** Why. Required by the screens, optional on the type so a restored backup
   *  from before this existed still loads. */
  voidReason?: string;
}

export interface Audited {
  createdAt: string;
  /** Email of the signed-in user. Absent for records written before this
   *  existed, and on the server/SSR path where there is no session. */
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
}

/** A deleted record, kept because the record itself is gone.
 *
 * Several staff have delete rights. Without this, "what happened to invoice
 * 0047" has no answer at all — the row is simply not there any more. The
 * whole record is kept, not a summary, so the answer includes what it said. */
export interface AuditEntry {
  id: ID;
  /** "void" keeps the document; "delete" does not. Both are recorded the same
   *  way, because to anyone reading the log they are the same event: someone
   *  decided this should stop counting. */
  action: "delete" | "void";
  /** Firestore collection the record came from, e.g. "sales". */
  collection: string;
  recordId: ID;
  /** What was deleted, as it stood. */
  snapshot: Record<string, unknown>;
  /** A line a human can read in a list, e.g. "INV-0047 · Ramesh · ₹1,000". */
  summary?: string;
  by?: string;
  at: string;
  createdAt: string;
}

export interface Company {
  name: string;
  gstin?: string;
  phone?: string;
  email?: string;
  address?: string;
  currency: string;
  invoicePrefix: string;
  purchasePrefix: string;
  enableGst?: boolean;
  /** Round invoice totals to the nearest rupee (default on) */
  enableRoundOff?: boolean;
  /** Allow a sale/purchase-return to push item stock below zero (default on,
   * matching Vyapar/Tally — counter billing shouldn't block on stock entry
   * lagging behind). When turned off, such saves are blocked with an error
   * instead of just a warning. */
  allowNegativeStock?: boolean;
  /** Nothing dated on or before this may be created, changed or deleted.
   *
   * Once GSTR-1 and 3B are filed for a month, that month is a statement made
   * to the tax authority; a bill inside it that can still be edited means the
   * books stop matching the filed return. Empty = no lock. */
  booksLockedUpto?: string;
  /** First month of the financial year, 1–12. India runs April to March, so
   * 4 — configurable rather than hardcoded so the code does not quietly
   * pretend to be universal, but nothing in this shop will change it. */
  fyStartMonth?: number;
  /** Preferred print format, remembered from the invoice page */
  printFormat?: PrintFormat;
  /** Set once the owner has finished checking existing opening balances
   * (Settings -> Opening Balance Review) and hidden that tool. Purely a UI
   * flag — it changes no number anywhere. */
  openingReviewDone?: boolean;
  /** The expense Category list — admin-managed from Settings, like a real
   * Chart of Accounts, rather than free text every user can invent on the
   * fly. Kept on Company (not its own repository) since it's a short,
   * stable list, unlike Payee which is meant to grow organically. */
  expenseCategories?: string[];
}

/** Matches the Sidebar's own groupings — permissions are granted per group,
 * not per individual page and not as fixed roles. Settings/Team management
 * is deliberately NOT a module here: it's owner-only everywhere, always,
 * so a staff member can never grant themselves broader access by editing
 * their own permissions. "reports" has no collection of its own (Reports/
 * Daybook/GST aggregate reads across the other modules, already protected
 * by their own rules) — it only gates the aggregated-view pages themselves. */
export type ModuleKey = "masterData" | "sales" | "purchaseExpenses" | "cashBank" | "reports";

export interface ModulePermission {
  view: boolean;
  edit: boolean;
  delete: boolean;
}

/** One doc per Firebase Auth UID. The account already using this app in
 * production becomes `isOwner: true` automatically the first time it loads
 * after this ships (see hydrateRepos) — existing behavior is unaffected. */
export interface TeamUser {
  id: string;
  email: string;
  name: string;
  /** Bypasses every permission check everywhere. Exactly one per business —
   * cannot be edited or deactivated by anyone, including another owner. */
  isOwner: boolean;
  /** false = fully locked out (deactivated, not deleted — see Settings/Team). */
  active: boolean;
  /** A module missing from this map means no access at all to it, not
   * "view only" — every level must be explicitly granted. */
  permissions: Partial<Record<ModuleKey, ModulePermission>>;
  createdAt: string;
}

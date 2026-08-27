/**
 * The two screens that make the posting ledger worth having.
 *
 * **Trial Balance** — every account, its debits and its credits, as at a date.
 * The report an accountant asks for first, and the one this shop has never
 * been able to produce.
 *
 * **Reconciliation** — the ledger's answer next to the answer the app already
 * gives, for every figure the shop reads. This is the screen that says whether
 * to believe the other one. docs/ERP-PLAN.md §1 stage 2: nothing switches to
 * reading the ledger until this is clean, and it stays on the menu afterwards
 * because real data drifts (lib/bankRepair.ts exists for exactly that reason).
 */

import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  BankRepo,
  BankTxnRepo,
  CashAdjustmentRepo,
  ExpenseRepo,
  ItemRepo,
  PartyRepo,
  PaymentRepo,
  PurchaseRepo,
  PurchaseReturnRepo,
  SaleReturnRepo,
  SalesRepo,
  StockAdjustmentRepo,
  LedgerEntryRepo,
} from "@/repositories";
import { useRepoMemo } from "@/hooks/useRepoData";
import { fmtMoney, fmtDate, today } from "@/lib/format";
import { GROUP_LABEL, accountLabel, accountsFor } from "@/lib/accounts";
import {
  balanceSheet,
  closingEntry,
  closingEntryBalances,
  financialYear,
  plGaps,
  planYearClose,
  profitAndLoss,
  type StatementLine,
} from "@/lib/financials";
import { usePeriodLock } from "@/hooks/usePeriodLock";
import { newBatch, commitBatch } from "@/repositories/base";
import { Button } from "@/components/ui/button";
import type { Book, JournalEntry } from "@/lib/posting";
import { buildJournal } from "@/lib/posting";
import { accountLedger, groupTotals, reconcile, trialBalance } from "@/lib/trialBalance";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";

/**
 * The whole book, unfiltered.
 *
 * Deliberately not date-ranged. A trial balance is a POSITION — what the shop
 * holds and owes on a day — so it needs everything up to that day, opening
 * balances included. Filtering from a start date would drop the openings and
 * the balance would not balance, which is worse than useless: it would look
 * like a posting bug.
 */
function useBook(): Book {
  // allWithVoided, deliberately: the ledger reverses a cancelled document
  // rather than pretending it never existed, so it needs to see it. Every
  // other reader in the app gets the live-only view from all().
  return useRepoMemo(() => ({
    parties: PartyRepo.all(),
    items: ItemRepo.all(),
    banks: BankRepo.all(),
    sales: SalesRepo.allWithVoided(),
    purchases: PurchaseRepo.allWithVoided(),
    saleReturns: SaleReturnRepo.allWithVoided(),
    purchaseReturns: PurchaseReturnRepo.allWithVoided(),
    payments: PaymentRepo.allWithVoided(),
    expenses: ExpenseRepo.allWithVoided(),
    cashAdjustments: CashAdjustmentRepo.allWithVoided(),
    bankTxns: BankTxnRepo.allWithVoided(),
    stockAdjustments: StockAdjustmentRepo.all(),
    journalEntries: LedgerEntryRepo.allWithVoided(),
  }));
}

const money = (n: number) => (n ? fmtMoney(n) : "—");
const r2 = (n: number) => Math.round(n * 100) / 100;

/* ── Trial Balance ────────────────────────────────────────────────────── */

export function TrialBalanceReport({ asAt }: { asAt: string }) {
  const book = useBook();
  /** Which account the reader is asking about. */
  const [openAccount, setOpenAccount] = useState<string | null>(null);

  const { rows, totalDebit, totalCredit, drift, orphans, groups, entries } = useMemo(() => {
    const upto = (d: string) => !asAt || d <= asAt;
    // Filtered on the ENTRY, after posting, rather than on the documents
    // before it: a transfer's two legs can carry different dates, and
    // dropping one of them at the boundary would leave the money half moved.
    const entries = buildJournal(book).filter((e) => upto(e.date));
    const tb = trialBalance(entries, accountsFor(book.banks, book.expenses));
    return { ...tb, groups: groupTotals(tb.rows), entries };
  }, [book, asAt]);

  return (
    <div className="max-w-3xl">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 className="text-lg font-bold text-gray-800">Trial Balance</h2>
        <p className="text-[12px] text-gray-500">as at {fmtDate(asAt)}</p>
      </div>
      <p className="text-[12px] text-gray-500 mb-4">
        Every account and what has moved through it. A position, not a period — so this uses
        everything up to the To date, including opening balances, and ignores the From date.
      </p>

      {drift !== 0 && (
        <Banner
          tone="bad"
          title={`The books are out by ${fmtMoney(Math.abs(drift))}`}
          body="Debits and credits must be equal. A difference here is a posting rule that does not add up — not a data-entry mistake — so it is a bug to fix in the software, not something to correct in the shop's records."
        />
      )}
      {orphans.length > 0 && (
        <Banner
          tone="bad"
          title="Postings pointing at accounts that do not exist"
          body={orphans.join(", ")}
        />
      )}

      <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-gray-50 border-b text-[11px] uppercase tracking-wide text-gray-500">
              <th className="text-left font-semibold px-4 py-2 w-16">Code</th>
              <th className="text-left font-semibold px-4 py-2">Account</th>
              <th className="text-right font-semibold px-4 py-2 w-32">Debit</th>
              <th className="text-right font-semibold px-4 py-2 w-32">Credit</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-gray-400">
                  Nothing posted up to this date.
                </td>
              </tr>
            )}
            {rows.map((r, i) => {
              const newGroup = i === 0 || rows[i - 1].group !== r.group;
              return (
                <Fragment key={r.accountId}>
                  {newGroup && (
                    <tr className="bg-gray-50/70 border-y">
                      <td
                        colSpan={4}
                        className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500"
                      >
                        {GROUP_LABEL[r.group]}
                      </td>
                    </tr>
                  )}
                  <tr
                    className={`border-b border-gray-100 last:border-0 cursor-pointer transition ${
                      openAccount === r.accountId ? "bg-primary/5" : "hover:bg-gray-50"
                    }`}
                    onClick={() =>
                      setOpenAccount((cur) => (cur === r.accountId ? null : r.accountId))
                    }
                    title="Show what this figure is made of"
                  >
                    <td className="px-4 py-2 text-gray-400 tabular-nums">{r.code}</td>
                    <td className="px-4 py-2 text-gray-800">
                      {r.name}
                      {r.note && (
                        <span
                          className="ml-1.5 inline-flex align-middle text-amber-500"
                          title={r.note}
                        >
                          <Info className="h-3.5 w-3.5" />
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(r.debit)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(r.credit)}</td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-primary/5 border-t-2 border-primary font-bold">
              <td className="px-4 py-3" colSpan={2}>
                Total
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(totalDebit)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{fmtMoney(totalCredit)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {openAccount && (
        <AccountLedgerPanel
          accountId={openAccount}
          name={rows.find((r) => r.accountId === openAccount)?.name ?? openAccount}
          entries={entries}
          onClose={() => setOpenAccount(null)}
        />
      )}

      {groups.length > 0 && (
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
          {groups.map((g) => (
            <div key={g.group} className="border rounded-lg bg-white px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                {GROUP_LABEL[g.group]}
              </p>
              <p className="text-[15px] font-bold tabular-nums text-gray-800">
                {fmtMoney(g.balance)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What one account's figure is made of.
 *
 * Oldest first with a running balance, because that is how a person checks a
 * total: start where it started and follow it. Every row names the document
 * behind it, so "why is receivable 4,12,300" ends at a bill with a number on
 * it rather than at a shrug.
 */
function AccountLedgerPanel({
  accountId,
  name,
  entries,
  onClose,
}: {
  accountId: string;
  name: string;
  entries: JournalEntry[];
  onClose: () => void;
}) {
  const { rows, debit, credit, closing } = useMemo(
    () => accountLedger(entries, accountId),
    [entries, accountId],
  );
  return (
    <div className="mt-4 bg-white border rounded-lg shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 bg-gray-50 border-b flex items-center justify-between gap-3">
        <div>
          <p className="text-[13px] font-bold text-gray-800">{name}</p>
          <p className="text-[11px] text-gray-500">
            {rows.length} {rows.length === 1 ? "entry" : "entries"}, oldest first
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 bg-white">
            <tr className="border-b text-[10px] uppercase tracking-wide text-gray-400">
              <th className="text-left font-semibold px-4 py-1.5 w-24">Date</th>
              <th className="text-left font-semibold px-4 py-1.5">What</th>
              <th className="text-right font-semibold px-4 py-1.5 w-24">Debit</th>
              <th className="text-right font-semibold px-4 py-1.5 w-24">Credit</th>
              <th className="text-right font-semibold px-4 py-1.5 w-28">Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                  Nothing has moved through this account.
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr key={`${r.docId}-${i}`} className="border-b border-gray-100 last:border-0">
                <td className="px-4 py-1.5 text-gray-500 tabular-nums">{fmtDate(r.date)}</td>
                <td className="px-4 py-1.5 text-gray-700">
                  <span className="text-gray-400">{r.voucherType}</span>{" "}
                  {r.voucherNo && <span className="font-mono">{r.voucherNo}</span>} {r.narration}
                </td>
                <td className="px-4 py-1.5 text-right tabular-nums">{money(r.debit)}</td>
                <td className="px-4 py-1.5 text-right tabular-nums">{money(r.credit)}</td>
                <td className="px-4 py-1.5 text-right tabular-nums font-semibold">
                  {fmtMoney(r.balance)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-gray-50 border-t font-bold">
              <td className="px-4 py-2" colSpan={2}>
                Total
              </td>
              <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(debit)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(credit)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(closing)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/* ── Reconciliation ───────────────────────────────────────────────────── */

export function ReconciliationReport() {
  const book = useBook();
  const recon = useMemo(() => reconcile(book), [book]);

  return (
    <div className="max-w-3xl">
      <h2 className="text-lg font-bold text-gray-800 mb-1">Ledger Reconciliation</h2>
      <p className="text-[12px] text-gray-500 mb-4">
        The posting ledger against the figures the app already prints. Each row is two separate
        calculations of the same thing — they should agree to the paisa, and a difference names
        which figure to stop trusting. Whole book, every date.
      </p>

      {recon.ok ? (
        <Banner
          tone="good"
          title="The ledger agrees with every screen"
          body="Receivables, payables, cash, each bank account and the profit figure all match, and every entry balances."
        />
      ) : (
        <Banner
          tone="bad"
          title="Something does not agree"
          body="Until every row below matches, the ledger is not the figure to act on. The rows that differ say which calculation to look at."
        />
      )}

      {recon.unbalanced.length > 0 && (
        <Banner
          tone="bad"
          title={`${recon.unbalanced.length} entr${recon.unbalanced.length === 1 ? "y does" : "ies do"} not balance`}
          body={recon.unbalanced
            .slice(0, 5)
            .map((e) => `${e.voucherType} ${e.voucherNo ?? ""} — ${e.narration}`)
            .join("; ")}
        />
      )}

      <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-gray-50 border-b text-[11px] uppercase tracking-wide text-gray-500">
              <th className="text-left font-semibold px-4 py-2">Figure</th>
              <th className="text-right font-semibold px-4 py-2 w-32">Ledger</th>
              <th className="text-right font-semibold px-4 py-2 w-32">App today</th>
              <th className="text-right font-semibold px-4 py-2 w-28">Difference</th>
            </tr>
          </thead>
          <tbody>
            {recon.rows.map((r) => (
              <tr key={r.key} className="border-b border-gray-100 last:border-0 align-top">
                <td className="px-4 py-2.5">
                  <span className="flex items-center gap-1.5 font-medium text-gray-800">
                    {r.informational ? (
                      <Info className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                    ) : r.ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                    ) : (
                      <AlertTriangle className="h-3.5 w-3.5 text-rose-600 shrink-0" />
                    )}
                    {r.label}
                    {r.informational && (
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                        for information
                      </span>
                    )}
                  </span>
                  <span className="block text-[11px] text-gray-400 mt-0.5">{r.why}</span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{fmtMoney(r.ledger)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{fmtMoney(r.app)}</td>
                <td
                  className={`px-4 py-2.5 text-right tabular-nums font-semibold ${
                    r.informational ? "text-gray-500" : r.ok ? "text-gray-300" : "text-rose-600"
                  }`}
                >
                  {r.diff ? fmtMoney(r.diff) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {recon.partyGaps.length > 0 && (
        <div className="mt-4">
          <h3 className="text-[13px] font-semibold text-gray-700 mb-1">
            Parties where the two disagree
          </h3>
          <p className="text-[11px] text-gray-500 mb-2">
            Checked one party at a time, because two parties wrong in opposite directions cancel out
            in a total — which is how the original double-count stayed hidden.
          </p>
          <div className="bg-white border rounded-lg overflow-hidden">
            <table className="w-full text-[13px]">
              <tbody>
                {recon.partyGaps.slice(0, 25).map((g) => (
                  <tr key={g.partyId} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-2 text-gray-800">{g.name}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(g.ledger)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(g.app)}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold text-rose-600">
                      {fmtMoney(g.diff)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Profit & Loss, off the ledger ────────────────────────────────────── */

export function LedgerProfitLossReport({ from, to }: { from: string; to: string }) {
  const book = useBook();
  const { pl, gaps } = useMemo(() => {
    const entries = buildJournal(book);
    const accounts = accountsFor(book.banks, book.expenses);
    const statement = profitAndLoss(entries, accounts, from, to);
    return { pl: statement, gaps: plGaps(statement) };
  }, [book, from, to]);

  return (
    <div className="max-w-2xl">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 className="text-lg font-bold text-gray-800">Profit &amp; Loss (from the ledger)</h2>
        <p className="text-[12px] text-gray-500">
          {from ? fmtDate(from) : "the beginning"} to {to ? fmtDate(to) : "today"}
        </p>
      </div>
      <p className="text-[12px] text-gray-500 mb-4">
        Read off the same postings as the Trial Balance and the Balance Sheet, so the three cannot
        disagree with each other. The existing Profit &amp; Loss report adds its figures up
        separately — see the note at the bottom for what this one counts that it does not.
      </p>

      <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
        <SectionHead>Income</SectionHead>
        {pl.income.length === 0 && <EmptyLine>Nothing earned in this period.</EmptyLine>}
        {pl.income.map((l) => (
          <StatementRow key={l.accountId} line={l} />
        ))}
        <TotalRow label="Total Income" value={pl.totalIncome} />

        <SectionHead>Expenses</SectionHead>
        {pl.expense.length === 0 && <EmptyLine>Nothing spent in this period.</EmptyLine>}
        {pl.expense.map((l) => (
          <StatementRow key={l.accountId} line={l} />
        ))}
        <TotalRow label="Total Expenses" value={pl.totalExpense} />

        <div className="px-5 py-4 bg-primary/5 border-t-2 border-primary flex justify-between items-center">
          <span className="text-base font-bold text-gray-800">
            {pl.netProfit >= 0 ? "Net Profit" : "Net Loss"}
          </span>
          <span
            className={`text-[20px] font-extrabold tabular-nums ${
              pl.netProfit >= 0 ? "text-emerald-600" : "text-rose-600"
            }`}
          >
            {fmtMoney(pl.netProfit)}
          </span>
        </div>
      </div>

      {/* Standing rule 5 of the plan: a behaviour change is flagged before it
          reaches the shop. Switching the old report to this one would move the
          profit figure the owner has been reading for months — so the amount
          and the reason are on the statement, not buried in a commit. */}
      {gaps.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-[13px] font-semibold text-amber-900">
            This includes {gaps.length === 1 ? "an account" : "accounts"} the old Profit &amp; Loss
            report has never counted
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {gaps.map((l) => (
              <li key={l.accountId} className="text-[12px] text-amber-800 flex justify-between">
                <span>{l.name}</span>
                <span className="tabular-nums font-semibold">{fmtMoney(l.amount)}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-amber-700 mt-1.5">
            Stock written off and cash that moved with no stated reason are real costs, and the old
            report leaves them out — which is why its profit reads higher. Nothing has changed on
            that report; this is the difference between the two.
          </p>
        </div>
      )}
    </div>
  );
}

/* ── Balance Sheet ────────────────────────────────────────────────────── */

export function BalanceSheetReport({ asAt }: { asAt: string }) {
  const book = useBook();
  const bs = useMemo(() => {
    const entries = buildJournal(book);
    return balanceSheet(entries, accountsFor(book.banks, book.expenses), asAt);
  }, [book, asAt]);

  return (
    <div className="max-w-3xl">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 className="text-lg font-bold text-gray-800">Balance Sheet</h2>
        <p className="text-[12px] text-gray-500">as at {fmtDate(asAt)}</p>
      </div>
      <p className="text-[12px] text-gray-500 mb-4">
        What the shop owns, what it owes, and what is left over. A position on a day — everything up
        to the To date, opening balances included, so the From date does not apply.
      </p>

      {bs.drift !== 0 && (
        <Banner
          tone="bad"
          title={`This does not balance — out by ${fmtMoney(Math.abs(bs.drift))}`}
          body="What the shop owns must equal what it owes plus what is left over. A difference means a posting rule does not add up, which is a bug in the software rather than anything the shop can correct."
        />
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white border rounded-lg shadow-sm overflow-hidden self-start">
          <SectionHead>Assets — what the shop owns</SectionHead>
          {bs.assets.length === 0 && <EmptyLine>Nothing recorded.</EmptyLine>}
          {bs.assets.map((l) => (
            <StatementRow key={l.accountId} line={l} />
          ))}
          <TotalRow label="Total Assets" value={bs.totalAssets} strong />
        </div>

        <div className="space-y-4 self-start">
          <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
            <SectionHead>Liabilities — what the shop owes</SectionHead>
            {bs.liabilities.length === 0 && <EmptyLine>Nothing owed.</EmptyLine>}
            {bs.liabilities.map((l) => (
              <StatementRow key={l.accountId} line={l} />
            ))}
            <TotalRow label="Total Liabilities" value={bs.totalLiabilities} />
          </div>

          <div className="bg-white border rounded-lg shadow-sm overflow-hidden">
            <SectionHead>Equity — what is left over</SectionHead>
            {bs.equity.map((l) => (
              <StatementRow key={l.accountId} line={l} />
            ))}
            {/* Profit that has not been closed into Retained Earnings yet.
                Without this line the statement only balances on the day the
                year is closed, which is no use for the other 364. */}
            <StatementRow
              line={{
                accountId: "current-earnings",
                code: "",
                name: "Profit for the period (not yet closed)",
                amount: bs.currentEarnings,
              }}
            />
            <TotalRow
              label="Total Liabilities + Equity"
              value={r2(bs.totalLiabilities + bs.totalEquity)}
              strong
            />
          </div>
        </div>
      </div>

      <YearClosePanel book={book} />
    </div>
  );
}

/* ── The year close ───────────────────────────────────────────────────── */

/**
 * Closing a year is the least reversible thing in this application — every
 * balance sheet after it is built on it — so it shows the exact entry first
 * and posts nothing until asked, the same shape as planStockRepair and
 * planBankRepair.
 */
function YearClosePanel({ book }: { book: Book }) {
  const { canPost } = usePeriodLock();
  const [busy, setBusy] = useState(false);

  const { plan, accounts } = useMemo(() => {
    const entries = buildJournal(book);
    const chart = accountsFor(book.banks, book.expenses);
    // The most recent year that has actually finished.
    const thisYear = financialYear(today());
    const lastYearEnd = financialYear(
      `${Number(thisYear.start.slice(0, 4)) - 1}-${thisYear.start.slice(5)}`,
    ).end;
    return { plan: planYearClose(entries, chart, lastYearEnd, today()), accounts: chart };
  }, [book]);

  const nameOf = (id: string) => accountLabel(id, accounts);

  const post = async () => {
    if (plan.blocked) return;
    // A closing entry is dated the last day of the year, which is very often
    // inside a period the shop has locked after filing GST. It is allowed
    // through, because it moves no account that appears in a filed return —
    // only income, expenses and Retained Earnings. Undoing one is not: see
    // the delete below.
    const entry = closingEntry(plan);
    if (!closingEntryBalances(entry)) {
      toast.error("The closing entry does not balance — refusing to post it");
      return;
    }
    setBusy(true);
    try {
      LedgerEntryRepo.add({
        date: entry.date,
        voucherType: entry.voucherType,
        voucherNo: entry.voucherNo,
        docKind: entry.docKind,
        narration: entry.narration,
        fyLabel: plan.fy.label,
        lines: entry.lines,
      } as never);
      toast.success(`${plan.fy.label} closed — ${fmtMoney(plan.netProfit)} to Retained Earnings`);
    } finally {
      setBusy(false);
    }
  };

  const reopen = async () => {
    if (!plan.existingId) return;
    const doc = LedgerEntryRepo.get(plan.existingId);
    if (!doc) return;
    // Reopening DOES need the lock, unlike closing: it changes a figure the
    // shop has already been reading and reporting from.
    if (!canPost(doc.date)) return;
    if (
      !window.confirm(
        `Reopen ${plan.fy.label}? Every balance sheet after ${fmtDate(doc.date)} changes, because the year's profit goes back into the current period instead of Retained Earnings. The closing entry is not deleted — it stays on record with a reversal against it.`,
      )
    )
      return;
    setBusy(true);
    try {
      // Reversed, not deleted. Every other correction in this application
      // leaves the original where it is; a year close is the last document
      // that should be an exception to that, because next year's opening
      // position was built on it.
      const batch = newBatch();
      if (!LedgerEntryRepo.voidBatched(batch, doc.id, `Reopened ${plan.fy.label}`)) {
        toast.info(`${plan.fy.label} was already reopened`);
        return;
      }
      const ok = await commitBatch(batch, "reopen year");
      if (!ok) {
        toast.error("Could not reopen — reload and check before trying again");
        return;
      }
      toast.success(`${plan.fy.label} reopened — the closing entry stays on record, reversed`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 bg-white border rounded-lg shadow-sm overflow-hidden">
      <div className="px-5 py-3 bg-gray-50 border-b flex items-center justify-between gap-3">
        <div>
          <p className="text-[13px] font-bold text-gray-800">Year close — {plan.fy.label}</p>
          <p className="text-[11px] text-gray-500">
            Empties every income and expense account into Retained Earnings, so the new year starts
            from zero and the profit stays on the balance sheet.
          </p>
        </div>
        {plan.existingId ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={reopen}>
            Reopen {plan.fy.label}
          </Button>
        ) : (
          <Button size="sm" disabled={busy || !!plan.blocked} onClick={post}>
            {busy ? "Posting…" : `Close ${plan.fy.label}`}
          </Button>
        )}
      </div>

      {plan.blocked && (
        <p className="px-5 py-3 text-[12px] text-gray-500 border-b">{plan.blocked}</p>
      )}

      {plan.lines.length > 0 && (
        <>
          <div className="px-5 py-2.5 grid grid-cols-3 gap-2 border-b text-[12px]">
            <Figure label="Income" value={plan.totalIncome} />
            <Figure label="Expenses" value={plan.totalExpense} />
            <Figure
              label={plan.netProfit >= 0 ? "To Retained Earnings" : "Loss to Retained Earnings"}
              value={plan.netProfit}
              strong
            />
          </div>
          {/* The entry itself, before anything is written. Closing a year on
              a figure nobody checked is how a wrong year becomes permanent. */}
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-gray-400 border-b">
                <th className="text-left font-semibold px-5 py-1.5">Account</th>
                <th className="text-right font-semibold px-5 py-1.5 w-28">Debit</th>
                <th className="text-right font-semibold px-5 py-1.5 w-28">Credit</th>
              </tr>
            </thead>
            <tbody>
              {plan.lines.map((l, i) => (
                <tr key={`${l.accountId}-${i}`} className="border-b border-gray-100 last:border-0">
                  <td className="px-5 py-1.5 text-gray-700">{nameOf(l.accountId)}</td>
                  <td className="px-5 py-1.5 text-right tabular-nums">{money(l.debit)}</td>
                  <td className="px-5 py-1.5 text-right tabular-nums">{money(l.credit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/* ── Shared statement furniture ───────────────────────────────────────── */

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 py-2.5 bg-gray-50 border-b">
      <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{children}</p>
    </div>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-3 text-[12px] text-gray-400">{children}</p>;
}

function StatementRow({ line }: { line: StatementLine }) {
  return (
    <div className="px-5 py-2 flex justify-between items-center gap-3 border-b border-gray-100 text-[13px]">
      <span className="text-gray-700 flex items-center gap-1.5">
        {line.name}
        {line.note && (
          <span className="text-amber-500 inline-flex" title={line.note}>
            <Info className="h-3.5 w-3.5" />
          </span>
        )}
      </span>
      <span className={`tabular-nums ${line.amount < 0 ? "text-rose-600" : "text-gray-800"}`}>
        {fmtMoney(line.amount)}
      </span>
    </div>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div
      className={`px-5 py-2.5 flex justify-between items-center gap-3 border-t ${
        strong ? "bg-primary/5 border-t-2 border-primary" : "bg-gray-50/60"
      }`}
    >
      <span className="text-[13px] font-bold text-gray-800">{label}</span>
      <span className="text-[14px] font-bold tabular-nums text-gray-900">{fmtMoney(value)}</span>
    </div>
  );
}

function Figure({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p
        className={`tabular-nums ${
          strong ? "text-[15px] font-bold" : "text-[13px] font-semibold"
        } ${value < 0 ? "text-rose-600" : "text-gray-800"}`}
      >
        {fmtMoney(value)}
      </p>
    </div>
  );
}

function Banner({ tone, title, body }: { tone: "good" | "bad"; title: string; body: string }) {
  const good = tone === "good";
  return (
    <div
      className={`mb-4 rounded-lg border px-4 py-3 flex gap-2.5 ${
        good ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"
      }`}
    >
      {good ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
      ) : (
        <AlertTriangle className="h-4 w-4 text-rose-600 mt-0.5 shrink-0" />
      )}
      <div>
        <p className={`text-[13px] font-semibold ${good ? "text-emerald-900" : "text-rose-900"}`}>
          {title}
        </p>
        <p className={`text-[12px] mt-0.5 ${good ? "text-emerald-800" : "text-rose-800"}`}>
          {body}
        </p>
      </div>
    </div>
  );
}

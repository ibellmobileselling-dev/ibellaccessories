# Taking BizDesk to ERP level — plan and impact analysis

**Branch discipline:** `main` is the shop's live app and deploys to production on
every push. `iballmobileshopfull` is the workshop for everything below; nothing
here reaches the counter until it is merged deliberately. Vercel's production
branch is `main` — verified: pushing this branch created no deployment and both
live hosts stayed on v73.

---

## 1. The decision everything else rests on

An ERP has **one ledger**. Every document posts balanced debits and credits
against a chart of accounts, and the trial balance, balance sheet and P&L are
read off that single source — so they cannot disagree with each other.

BizDesk derives each figure from the documents with its own calculation:
receivable one way, cash another, P&L another. That is why the dashboard
double-count was possible at all — two screens answered "what does this party
owe" two different ways and one was wrong. A ledger makes that class of bug
impossible, because there is only one answer to read.

**So the foundation is a posting ledger.** Everything in the missing list either
derives from it (balance sheet, trial balance, year close) or is independent of
it (serials, units, workflow, locations).

### How to add it to a live app without breaking it

Additively, in three stages:

1. **Post alongside.** Every existing write path keeps doing exactly what it does
   today AND writes ledger lines on the same batch. Nothing reads the ledger yet,
   so nothing can break.
2. **Reconcile.** A report (and an audit test) compares the ledger's answer with
   the document-derived answer for every party, account and total. Any gap is a
   posting bug, found before anyone depends on it. This is the same technique as
   `planDataRepair` — dry-run first, trust later.
3. **Switch, one report at a time.** When the ledger and the old calculation agree
   for a figure, that screen starts reading the ledger. The old path stays until
   the last reader is gone.

Stage 2 is the part that makes this safe on a trading shop, and it is not
optional.

---

## 2. Chart of accounts

Minimum real set. Each row is an account; `system` accounts are created on
first run and cannot be deleted.

| Group | Accounts |
|---|---|
| Asset | Cash in Hand · one per Bank Account · Accounts Receivable · Inventory · Input GST |
| Liability | Accounts Payable · Output GST · Round-off |
| Equity | Owner's Capital · Owner's Drawings · Retained Earnings · Opening Balance Equity |
| Income | Sales · Discount Received · Other Income |
| Expense | Cost of Goods Sold · Discount Allowed · Cash Short/Over · Stock Written Off · one per expense category |

`Opening Balance Equity` is what makes the ₹29,000 "CASH ADD TILL TODAY FROM
VYAPAR" postable: an opening figure has to land somewhere, and equity is where.

### New collections

```
accounts        { id, code, name, group, system, archived }
ledgerEntries   { id, date, voucherType, voucherNo, docId, docKind,
                  narration, lines: [{ accountId, debit, credit, partyId? }],
                  createdAt, createdBy, reversalOf?, periodKey }
```

One `ledgerEntry` per document, with balanced lines. `docId`/`docKind` point back
at the sale/purchase/payment that caused it, so any figure drills through to its
source.

---

## 3. Posting rules

The whole design in one table. Every existing write point gets exactly one of
these.

| Document | Debit | Credit |
|---|---|---|
| Sale (GST) | Accounts Receivable (total) | Sales (taxable) + Output GST |
| — cash taken at billing | Cash / Bank | Accounts Receivable |
| — cost of the goods | Cost of Goods Sold | Inventory |
| Purchase | Inventory + Input GST | Accounts Payable |
| — paid at billing | Accounts Payable | Cash / Bank |
| Payment in | Cash / Bank | Accounts Receivable |
| — settlement discount | Discount Allowed | Accounts Receivable |
| Payment out | Accounts Payable | Cash / Bank |
| — settlement discount | Accounts Payable | Discount Received |
| Expense | Expense (category) | Cash / Bank |
| Transfer | destination account | source account |
| Cash adjustment | Cash *or* the reason account | the reason account *or* Cash |
| Sale return | Sales + Output GST | Accounts Receivable (and Inventory ← COGS) |
| Purchase return | Accounts Payable | Inventory + Input GST |
| Stock adjustment | Inventory *or* Stock Written Off | the other |

**Where each is added** (the existing posting points, from a grep of the tree):

| File | Posts |
|---|---|
| `src/components/InvoiceForm.tsx` | Sale, Purchase (+ the cash/bank leg, + COGS) |
| `src/components/ReturnForm.tsx` | Sale return, Purchase return |
| `src/routes/payments.tsx` | Payment in / out, incl. discount lines |
| `src/routes/expenses.tsx` | Expense |
| `src/components/CashBankTransferDialog.tsx` | Transfer (both legs) |
| `src/routes/bank.tsx` | Deposit / withdraw |
| `src/routes/cash.tsx` | Cash adjustment |
| `src/routes/items.tsx`, `BulkUpdateItemsDialog.tsx` | Stock adjustment |
| `src/routes/sales.index.tsx`, `purchase.index.tsx`, `sale-return.index.tsx`, `purchase-return.index.tsx` | Deletions — post a **reversal**, never delete the original entry |

---

## 4. Feature-by-feature: what is added, and what it touches

### 4.1 Audit trail — *independent, cheap, do first*
- **Add** `createdBy`, `createdAt`, `updatedBy`, `updatedAt` on every record;
  stamped centrally in `Repository.add/update/adjustField` so no call site can
  forget. Current user from `auth.currentUser.email`.
- **Touches** `src/repositories/base.ts` only, plus a "History" line on detail
  screens.
- **Risk** none — additive fields, empty on existing records.

### 4.2 Period lock — *independent, cheap*
- **Add** `Company.booksLockedUpto: string`. Every write path checks the
  document date against it.
- **Touches** the same posting points listed above; one shared guard
  `assertPostable(date)` so the rule exists once.
- **Risk** low. Must exempt the repair tools, or Fix Calculations stops working
  on a locked period.

### 4.3 Voucher numbers
- **Add** a per-type counter (`CN`, `JV`, `CT`, `RV`) on cash/bank/journal
  entries, which today have no reference at all.
- **Touches** cash, bank, transfer, adjustment write paths; the tables that list
  them.
- **Risk** low. Numbering must be gap-free per financial year — allocate inside
  the same batch as the document, not before it.

### 4.4 Reason categories on cash adjustments — **DONE (Phase 1)**
- **Add** `CashAdjustment.accountId` (Owner Capital, Owner Drawing, Cash
  Short/Over, Opening Balance Equity, …) via the existing `ComboInput`.
- **Touches** `src/routes/cash.tsx`; the P&L and balance sheet then stop
  absorbing unexplained cash.
- **Risk** low. Existing entries have no account — they post to Opening Balance
  Equity and are flagged for review rather than guessed at.

**What was actually built, and why it differs.** A typed `CashAdjustment.purpose`
picker (`src/lib/cashPurpose.ts`) rather than a free `accountId` over a
`ComboInput`, because **the chart of accounts does not exist until Phase 2** — a
combo over accounts that are not there yet would either be empty or invent its
own names, and those names would then have to be reconciled with the real chart
later. Each purpose instead carries the account it will post to (`spec.account`:
Owner's Capital, Owner's Drawings, Cash Short/Over, Opening Balance Equity), so
Phase 2 maps six known keys to six real accounts and the two cannot drift apart
in the meantime.

Three things the plan did not say, which the build settled:
- The purpose is asked **before** the amount and **sets the direction** where
  only one direction is possible. "Owner took out" already says which way the
  money went; asking again is asking twice, and lets the two answers contradict
  each other. "Counting difference" and "Something else" leave it open.
- Stating one is **required** on new entries. A picker that can be skipped
  produces exactly the entry this phase exists to stop.
- `transfer` is written by the app and never offered in the picker — a
  transfer's other side is a real account, so it is the one purpose nobody has
  to state. A leg is recognised by `transferLegsFor` even when the field was
  never stamped, so the older pairs read "Transfer" rather than "Uncategorised".

Existing entries keep no purpose and are flagged **amber "Uncategorised"** on
the row (with a hover saying what to do) and totalled on their own line in the
new by-reason summary, which is what makes stating a reason worth something
before there is a ledger to post it to: the shop can see how much of the
month's cash movement nobody can explain. The shop's real ₹29,000 "CASH ADD
TILL TODAY FROM VYAPAR" is the entry this was built for.

Proven by 13 mutations — the guard removed, the direction link cut, the field
saved but not stored, a transfer leg written untagged, the amber flag painted
like the rest, a reason pre-picked, and the transfer fallback removed — each
caught by a named assertion.

### 4.5 Append-only corrections — **DONE (Phase 4)**
- **Add** "Reverse this entry" on anything outside today; edit stays for same-day.
  A reversal is a new document with the opposite signs and `reversalOf` set.
- **Touches** every delete/edit path — the four `*.index.tsx` deletes, payments,
  cash, expenses.
- **Risk** MEDIUM, and it is a **behaviour change the shop will notice**: a
  correction leaves two visible rows. Tell them before shipping it.
- **Payoff** this is what retires the drift class permanently. Nothing mutates,
  so nothing can disagree with itself.

**Built as voiding rather than as a reversing document.** The plan said the
correction should be a new document with the opposite signs. On these
collections that would mean negative invoices — a −₹4,000 sale in the sales
list, in the party statement, in every report — and every screen in the app
would need to learn what one means. The accounting outcome wanted is simply
that the original stops counting and the books record when it stopped, and
that is what a void does: the document stays where it is, marked, and
`lib/posting.ts` emits a **reversing journal entry dated the day it was
cancelled**. The reversing document exists exactly where it is useful — in the
ledger — and nowhere it would be noise.

**The line falls at today** (`lib/voiding.ts`). A bill entered wrongly two
minutes ago has been reported to nobody and is deleted outright; a bill from
last month is different in kind, because its month has been counted and quite
possibly filed. The period lock is a stricter version of the same idea and
still applies on top.

**The one design decision that carries the feature:** `Repository.all()`
filters cancelled records out, and the four callers that genuinely need them
ask by name via `allWithVoided()` — the posting ledger, backups, voucher
numbering, and the lists' own "show voided" view. There are 216 `.all()` call
sites. "Remember to filter" is not a mechanism, and one forgotten total is the
entire failure mode of this feature.

**Three things the build settled that the plan did not say:**
1. **A reason is required.** "Why is INV-0047 voided" is the question somebody
   asks six months later, and nothing else can answer it.
2. **A transfer's two legs are cancelled together**, for the same reason they
   are deleted together — half a cancelled transfer is money out of one
   account and never into the other.
3. **Backups include cancelled documents.** A restore without them brings
   voided bills back to life, and the ledger's reversals with them. There is a
   source check in `tests/run-screens.cjs` asserting the export uses
   `allWithVoided()`.

**One interaction found by the suite.** `reconcile()` was handing the ledger
and the app's own calculations the same array. Once documents could be voided
those two need different books — the ledger reverses what was cancelled, the
app has already stopped seeing it — and feeding both the same one made a
voided document count once on one side and net to nothing on the other. It
reported a 600-rupee gap that was purely an artefact of the comparison. Fixed
with `liveOnly(book)`, and it is now a named assertion over 120 generated
books with cancellations in them.

**Coverage checks**, alongside the period lock's: every screen that destroys a
transaction document must also be able to cancel one, and the backup must keep
cancelled documents. Both are source checks, because a path that quietly kept
hard-deleting would pass every rendered assertion — nothing would fail, a
document would simply cease to exist.

**Proven by** 21 mutations, all caught.

**Still to tell the shop, before this merges:** correcting an older bill now
leaves a voided row on the list instead of removing it, the row is hidden
until the "Voided" button is pressed, and a reason has to be typed.

### 4.6 Posting ledger + Trial Balance — **DONE (Phase 2)**
- **Add** the two collections above; `src/lib/posting.ts` builds the lines for a
  document; `src/lib/trialBalance.ts` sums the ledger.
- **Touches** every posting point (table in §3) — the largest single change.
- **Risk** HIGH if it drives anything. Mitigated by §1: post alongside,
  reconcile, switch last.
- **Done when** an audit test asserts, over the randomised scenario generator
  already in `tests/audit.test.ts`, that for every scenario: every entry balances,
  and the ledger's receivable/payable/cash/bank equals what `netPartyPositions`,
  `cashFlows` and `bankFlows` say.

**Built, and the one deliberate departure from §1.** The posting rules are
complete and live in `src/lib/posting.ts`; the chart of accounts is
`src/lib/accounts.ts`; `src/lib/trialBalance.ts` sums it and reconciles it.
What §1 got wrong is *when* the rules run: it said write ledger lines on every
document's batch. They are applied **on read** instead, and the reasons only
became clear with the shop's real data in view:

1. **A written ledger would be empty for all of history.** Every bill, payment
   and expense on the books predates the change, so a trial balance read off it
   is wrong until thousands of documents are backfilled — a mass write to a
   live shop's Firestore, the riskiest single act in this whole plan, buying
   nothing a derived ledger does not already give.
2. **Dual writing can drift.** Two records of one fact, written on every path,
   is the exact shape of the bug this phase exists to kill: the dashboard
   double-count happened because two places answered the same question
   separately. A derived ledger cannot disagree with the documents, because it
   *is* the documents.
3. **Nothing needs it stored yet.** Storage buys immutability, and immutability
   matters only for what no document implies — a manual journal voucher, a
   year-end closing entry, an append-only reversal. Those are Phases 3 and 4,
   and `JournalEntry` is already the shape they will be stored in, so they add
   rows to the list rather than replacing it.

§1's stage 2 — reconcile before switching any reader — is untouched and is the
reason to trust any of this. Nothing on any screen reads the ledger for a
figure it already had.

**Three accounts exist to expose gaps rather than hide them,** and they are
what makes the trial balance worth reading on this shop's data:
- **Suspense** — money recorded as paid on a Credit-mode bill. It reduces what
  the party owes and reaches no cash or bank position anywhere.
- **Bank (account not recorded)** — bank/UPI/cheque money never tied to WHICH
  account. Sits outside every stored bank balance.
- **Cash Short/Over** — counting differences, and every cash entry with no
  stated reason (what Phase 1 now prevents going forward).

**Two findings the reconciliation surfaced immediately.** The app's P&L does not
count stock written off, unexplained cash, or other income; rather than dropping
those from the ledger to make the row match, the Net Profit row adds them back
to the app's figure and names the amount. And a stored `BankAccount.balance`
drifting from its own documents now shows as a figure per account — the same
drift `planBankRepair` hunts, finally measurable.

**Screens** `/reports?r=trial-balance` and `/reports?r=reconcile`.

**Proven by** 22 mutations, each caught by a named assertion: GST booked as
revenue, revenue at the bill total, the discount line dropped, an advance
counted only when allocated, both transfer legs posted twice, openings never
posted, drawings treated as an expense, the ₹29,000 sent to profit, Credit-mode
money counted as cash, the named bank account ignored, a stale tax field
trusted, a purchase booked as a receivable, goods never leaving stock, a
party's position summed the wrong way, a liability printed negative, an
unbalanced entry reaching the report, the reconciliation always saying "fine",
a disagreeing row ticked, and the difference column blanked.

Two of those mutations survived the first attempt and both were **test gaps,
not code gaps**: the randomised generator never produced a non-GST bill with a
stale tax figure (its non-GST bills had zero-rated lines, so "keep the tax
field" kept a zero), and the trial balance's footer was only ever checked
against itself — two totals computed the same wrong way agree perfectly. Both
tests were fixed and the mutations then failed as they should.

### 4.7 Balance Sheet + P&L from the ledger, and year close — **DONE (Phase 3)**
- **Add** `/reports?r=balance-sheet`, `?r=trial-balance`; a Year Close action
  posting closing entries into Retained Earnings and carrying balances forward.
- **Touches** reports only — it reads the ledger, writes nothing except the
  closing entry.
- **Depends on** 4.6 being reconciled.

**Built.** `src/lib/financials.ts` holds the statements and the close;
`/reports?r=balance-sheet` and `?r=pl-ledger` are the screens. The Balance
Sheet carries the year close, because that is where an owner is standing when
they decide a year is finished.

**The three-way rule about closing entries** is the whole difficulty of this
phase, and getting any part of it backwards makes a statement confidently
wrong rather than obviously broken:

| | Closing entries |
|---|---|
| **P&L** | **excluded** — a year whose own statement included the entry emptying its accounts would report zero |
| **Balance sheet / trial balance** | **included** — that is how profit reaches equity, and how a closed year stops being counted twice |
| **The close itself** | **includes every earlier close** — which is what leaves only this year's income standing, and is why year two does not carry year one's profit again |

Each row of that table is a mutation in the suite. All three were caught.

**The first stored ledger entries.** Phase 2's postings are derived, and
`docs/ERP-PLAN.md` §4.6 explains why. A closing entry is the exception the
reasoning predicted: no document implies it, so it is a decision taken on a
date by a person, and next year's opening position is built on it. Hence
`JournalEntryDoc`, `LedgerEntryRepo` (collection `ledger-entries`), hydrated
with everything else and **included in backups** — a backup without it would
restore a shop whose years had silently reopened.

**Two judgement calls worth recording.**
1. **A close may post into a locked period; reopening may not.** A closing
   entry is dated the last day of a year, which is usually inside a month the
   shop locked after filing GST. It is allowed through because it moves no
   account that appears in a filed return — only income, expenses and Retained
   Earnings — and a test asserts exactly that, so the exemption stays honest.
   Reopening goes through `canPost` like any other write, because it changes a
   figure already reported.
2. **The old P&L was left alone.** Standing rule 5. Switching Reports → Profit
   & Loss to the ledger would move the number the owner has been reading for
   months, by the stock write-offs and unexplained cash it has never counted.
   The new statement names those accounts and their amounts on screen, so the
   difference is visible before anyone is asked to accept it. The switch itself
   is a separate decision for the shop.

**One interaction found while testing.** `reconcile()`'s Net Profit row summed
the income and expense accounts as they stood, which after a close is only the
open period — so it would have reported a gap the size of every closed year,
on the one screen that must not cry wolf. It now reads through
`profitAndLoss()`, which excludes closing entries.

**Proven by** 20 mutations, all caught: each row of the table above reversed,
1 April pushed into the wrong year, the year mislabelled, the whole income sent
to Retained Earnings instead of the profit, a profit debited instead of
credited, expenses left out of the close, both guards (closed twice, closed
early) removed, unclosed profit inverted, equity read as a debit balance, the
reconciliation reading profit off the accounts as they stand, the panel
offering the running year, a closed year offered again, unclosed profit dropped
from the statement and dropped from its total, the behaviour-change warning
suppressed, reopening leaving the entry behind, and the close written without
its year label.

### 4.8 Unit conversion (box ↔ piece)
- **Add** `Item.baseUnit`, `altUnit`, `altPerBase`; `LineItem.unitUsed` and
  `baseQty`. **Stock, valuation and every report use `baseQty` only** — the
  chosen unit is presentation.
- **Touches** all 10 stock write points (grep above), `planStockRepair`,
  Inventory, the item picker, the printed bill.
- **Risk** MEDIUM. The rule that keeps it safe: nothing except the line's own
  display reads `unitUsed`.

### 4.9 Serial / IMEI tracking
- **Add** `Item.trackSerials`; `serialUnits { id, itemId, serial, status,
  purchaseDocId, saleDocId }`; `LineItem.serials: string[]`.
- **Touches** the bill and purchase forms (pick/scan serials), returns (restore
  them), stock reconciliation (serial count must equal `baseQty` for tracked
  items — a new invariant for the audit suite), item detail (per-serial history).
- **Risk** MEDIUM. Highest real value for a phone shop: warranty by serial.

### 4.10 Document workflow
- **Add** `quotations`, `salesOrders`, `deliveryChallans`, `purchaseOrders`,
  `grns`, each with `status` and a convert-to-next action carrying the lines
  forward and linking back.
- **Rule** stock moves on the **challan/GRN or the invoice, once** — never on a
  quotation or an order. An order may *reserve*, which is a separate figure from
  stock and must never be subtracted from it.
- **Touches** new screens and routes; the item picker's available-stock display;
  the tab strip's title map.
- **Risk** MEDIUM — mostly new surface rather than changes to existing paths.

### 4.11 Multi-location
- **Add** `locations`; move stock to `itemStock { itemId, locationId, qty }`;
  every document gets a `locationId`; inter-location transfer document.
- **Touches** EVERYTHING that reads `item.stock` — 23 references across 12
  files, plus `planStockRepair`, Inventory, the dashboard's stock value, the
  low-stock badge, the bill form's negative-stock warning.
- **Risk** HIGHEST. Deliberately last. `item.stock` becomes a derived total
  across locations so old readers keep working during the migration.

### 4.12 Cost centres, budgets, TDS/TCS
- **Add** `costCentreId` on documents and ledger lines; a budget per account per
  period; TDS/TCS rate on party and line.
- **Touches** reports; the ledger line shape.
- **Risk** low, additive.

### 4.13 e-Invoicing / e-way bill
- **Blocked on the client, not on code.** Needs a GSP account (Masters India,
  ClearTax, …), API credentials, and the GSTIN registered for e-invoicing.
  Cannot be built or tested without them. Ask before scheduling.

---

## 5. Order of work

Dependency-driven, cheapest-safest first:

| # | Phase | Depends on | State |
|---|---|---|---|
| 0 | Audit trail · Period lock · Voucher numbers | — | **done** |
| 1 | Reason categories on cash | 0 | **done** |
| 2 | Posting ledger + reconciliation report + Trial Balance | 0 | **done** |
| 3 | Balance Sheet · P&L from ledger · Year close | 2 reconciled | **done** |
| 4 | Append-only corrections | 2 | **done** |
| 5 | Unit conversion | — | |
| 6 | Serial / IMEI | 5 | |
| 7 | Document workflow | — | |
| 8 | Multi-location | 5, 7 | |
| 9 | Cost centres · budgets · TDS/TCS | 2 | |
| 10 | e-Invoicing | client credentials | |

## 6. Standing rules for this programme

1. **Additive first.** No phase may require rewriting existing records. Old data
   must render correctly with the new field absent.
2. **Post alongside, reconcile, then switch.** No new figure drives a screen
   until a test proves it agrees with the figure it replaces.
3. **Every phase ends with mutation-proven tests.** Break the mechanism, watch
   the test fail with the real numbers, restore.
4. **Nothing merges to `main` until the phase is complete and reconciled.**
   Partial phases stay on this branch.
5. **Behaviour changes get flagged to the shop before merge** — append-only
   corrections above all.

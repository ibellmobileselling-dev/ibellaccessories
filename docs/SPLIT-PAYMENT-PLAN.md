# Split payments — part cash, part bank, on one document

The shop takes ₹10,000 on a bill as ₹4,000 cash and ₹6,000 into HDFC. Vyapar
records that as two payment rows on the one bill. This app cannot record it at
all: a document has exactly one `paymentMode`, so the counter has to either
lie about the mode or invent a second document that never happened.

Reported from production. This document is the plan, not the change.

---

## 1. What the data says today

Three record types move money. **Returns carry no payment fields at all**, so
credit and debit notes are out of scope — money against them is a Payment.

| Record            | Amount   | Mode          | Bank                        |
| ----------------- | -------- | ------------- | --------------------------- |
| `Invoice` (sale)  | `paid`   | `paymentMode` | `bankId` + `bankPaidAmount` |
| `Invoice` (purch) | `paid`   | `paymentMode` | `bankId` + `bankPaidAmount` |
| `Payment`         | `amount` | `mode`        | `bankId`                    |
| `Expense`         | `amount` | `paymentMode` | `bankId`                    |

`PaymentMode` is `"cash" | "bank" | "credit" | "upi" | "cheque"`.

### The one piece that is already half-built

`Invoice.bankPaidAmount` exists, and it is a real amount rather than a flag:
its comment says it is "a snapshot of `paid` at the moment it was attributed
to `bankId`, so an edit can reverse exactly that amount". The bank ledger
(`lib/ledger.ts`, `bankLedger`) and `lib/bankRepair.ts` both key off
`bankId` + `bankPaidAmount` and never look at `paymentMode`.

**So the bank half of a split would already work.** An invoice with
`paid: 10000` and `bankPaidAmount: 6000` credits HDFC ₹6,000 correctly today.

### The exact place a split loses money

`modeFlows()` in `lib/ledger.ts` — the function behind cash-on-hand:

```js
if (s.paymentMode !== mode) continue;   // must be exactly "cash"
if (s.bankId) continue;                 // ...and have NO bank attribution
const direct = paid − appliedViaPayments;
```

The second line is the problem. Any bill touching a bank is dropped from cash
entirely, because today a bill is cash **or** bank and never both. Record the
split above and the ₹4,000 cash silently disappears from cash on hand while
the ₹6,000 lands in HDFC correctly. **A half-right answer is worse than a
refusal**, which is why this cannot be done by adding a UI field and hoping.

### A wart to inherit deliberately, not by accident

`upi` and `cheque` are attached to no account. `bankFlows()` lumps them in
with bank, and the daybook has an explicit `isUnassigned` bucket for "bank
with no bankId, upi, cheque" so the day still reconciles. Its comment calls
them "legacy modes not tied to any real account".

Splits must not extend that. **Every row of a split names where the money
went**: cash, or a specific bank account. UPI and cheque become _how_ it
reached a bank account, not a place money goes to die.

---

## 2. The shape

`paid` / `amount` stays the total. Added alongside:

```ts
export interface PaymentSplit {
  /** How this part was taken. */
  mode: PaymentMode;
  amount: number;
  /** Required when the money landed in an account. */
  bankId?: ID;
}
```

- `paidSplits?: PaymentSplit[]` on `Invoice`
- `splits?: PaymentSplit[]` on `Payment` and `Expense`

**Optional, and absent on every existing record.** No migration, no
backfill, nothing rewritten. A document with no splits means exactly what it
means today, forever.

### The rule that keeps it honest

**The splits must sum to the amount, and the document will not save
otherwise.** Same rule serial numbers use, for the same reason: the moment a
document can disagree with itself, every figure derived from it becomes a
guess, and the shop keeps trading on it.

### One accessor, and everything reads through it

```ts
/** How this document's money was actually taken. */
export function splitsOf(doc): PaymentSplit[];
```

For a legacy document it returns the single row its existing fields already
imply — including the `bankPaidAmount` case, which is genuinely two rows
today and was simply never expressible. For a split document it returns the
stored rows.

This is the seam, and it goes in **first, on its own, changing no
behaviour** — exactly how `stockOf()` was introduced before anything depended
on it. All 30 mode decisions route through it while the answer is still
identical, so that commit is provably inert. Only then does the UI let anyone
create a second row.

---

## 3. Everywhere this touches

Grepped, not guessed: **30 mode decisions across 16 files.**

### 3a. Must change — money is attributed here

| Where                              | What                                                      |
| ---------------------------------- | --------------------------------------------------------- |
| `lib/ledger.ts` `modeFlows`        | The bug above. Cash part = its own split row, not `paid`. |
| `lib/ledger.ts` `bankFlows`        | Per bank row rather than per document mode                |
| `lib/ledger.ts` `bankLedger`       | Already amount-based; must read every bank row, not one   |
| `lib/bankRepair.ts`                | Rebuilds balances from `bankPaidAmount` — now from rows   |
| `components/InvoiceForm.tsx`       | Writes the rows; adjusts each bank balance in the batch   |
| `routes/payments.tsx`              | Receive/Make Payment gains rows                           |
| `routes/expenses.tsx`              | Expenses gain rows                                        |
| `routes/sales.index.tsx`           | Reverses each bank row on delete/void                     |
| `routes/purchase.index.tsx`        | Same                                                      |
| `routes/daybook.tsx`               | One document can now appear in cash AND a bank            |
| `routes/reports.tsx`               | Cash/bank report splits                                   |
| `lib/posting.ts` (**branch only**) | One journal entry, one debit line per split row           |

### 3b. Display only — must not lie

`PrintableInvoice`, `ThermalReceipt`, `sales.$id`, `purchase.$id`,
`payees_.$id`. A bill that says "Cash" when half went to a bank is the
complaint restated. These print the rows.

### 3c. Deliberately unchanged

- **Returns** — no payment fields. Money against a note is a Payment.
- **`ModePills`** — still the right control for the common single-mode case.
  The split UI is an addition reached from it, not a replacement: making
  every counter sale a two-row form to serve the occasional split would slow
  the fastest path in the app, and staff work around anything that does that.

---

## 4. The reconciliation that proves it

Every figure below must be unchanged for every existing document, and correct
for a split one:

- Cash on Hand
- Each bank account's balance, and its ledger
- Party balances (unaffected — a split changes _where_ money went, never how
  much, so `paid` is untouched and so is what the party owes)
- Daybook day totals, including the unassigned bucket
- Trial Balance and Ledger Reconciliation (branch)

The party-balance line is the reassuring one: splits move money between
_accounts_, never between a party and the shop. If a party balance moves,
the change is wrong.

---

## 5. Order of work

Cheapest and safest first; each step ships and is reversible on its own.

| #   | Step                                                                       | Why here                                              |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | `PaymentSplit`, `splitsOf()`, and every reader routed through it           | Provably inert — the answer is identical              |
| 2   | Fix `modeFlows` to take the cash part from its row                         | The money-losing line, before anything can create one |
| 3   | Invoice: write rows, adjust each bank in the batch, reverse on delete/void | Sale and purchase, the reported case                  |
| 4   | Payment and Expense rows                                                   | "Everywhere payment is relevant"                      |
| 5   | Printed documents and detail screens print the rows                        | Reaches the customer                                  |
| 6   | Daybook, reports, and the branch's posting ledger                          | The books agree                                       |

Steps 1–2 are safe to ship before any UI exists. Nothing can create a split
until step 3, so 1 and 2 cannot break a shop that has none.

---

## 6. Risk

**MEDIUM-HIGH**, and higher than serials was: this is money on the busiest
screen in the app, in production, for an angry client. What makes it
survivable is the order above — the seam lands inert, the money-losing line
is fixed before anything can produce a split, and the sum-to-total rule means
a document can never quietly disagree with itself.

The single most dangerous mistake available here is shipping the UI before
`modeFlows` is fixed. That combination books the bank half correctly and
drops the cash half, which does not look like a bug on the day — it looks
like the till being short.

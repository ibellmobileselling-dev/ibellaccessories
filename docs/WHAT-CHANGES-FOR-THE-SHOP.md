# What changes for the shop

Everything on the `iballmobileshopfull` branch, in the words to say to the
owner. Standing rule 5 of `ERP-PLAN.md`: a behaviour change gets flagged
before it reaches the counter, not explained afterwards when somebody rings up
confused.

Most of this work adds screens that were not there. Only **three** things
change how the shop already works, and they are the first three below.

---

## 1. An older bill is cancelled, not deleted

**Before:** delete a bill from any day and it was gone.

**Now:** a bill **dated today** is still deleted outright — nothing has been
reported on yet, and nobody should have to keep a mis-tap forever.

A bill from **any earlier day** is **voided** instead:

- it stays on the list, struck through, with a red **Voided** mark
- it is **hidden by default** — the "Voided" button on each screen shows it
- **a reason must be typed** before it will go through
- stock, bank balances and payments are put back exactly as a delete did

**Why:** deleting last month's bill quietly makes last month a different
month, and nothing on any screen says so. If that month's GST has been filed,
the books and the return stop agreeing with no trace of why.

**What to say:** *"Old bills are cancelled, not removed. They stay on the
list marked Voided so the month still adds up, and you have to say why."*

---

## 2. An older bill can no longer be edited

**Before:** any bill could be opened and changed.

**Now:** **today's** bills are fully editable. Anything earlier opens a notice
saying it cannot be changed, and to void it and issue a new one instead.

Applies to bills, purchases, payments, expenses, cash entries and transfers.

**Why:** it is the same door as above. Stopping a three-month-old bill being
deleted while leaving it editable to any figure changes that month just the
same — and an edit leaves *less* trace than a deletion, because a deletion is
at least written to the audit log with a copy of what went.

**What to say:** *"You can fix today's entries freely. To change an older one,
cancel it and make a new one — both stay on the record."*

---

## 3. Cash entries must say why the money moved

**Before:** Adjust Cash asked for an amount and a free-text note.

**Now:** it also asks **why** — opening balance, owner put in, owner took out,
counting difference, or something else — and the answer sets the direction
where only one makes sense.

Older entries with no reason show an amber **Uncategorised** mark and are
totalled separately on the Cash page.

**Why:** the shop has a real entry reading *"CASH ADD TILL TODAY FROM VYAPAR
₹29,000"*. That is money in the drawer with nothing saying whether the shop
earned it, the owner put it in, or it came from the old system — so the profit
figure quietly absorbed it and that month was wrong by ₹29,000.

**What to say:** *"When you add or remove cash by hand, tell it why. It takes
one tap and it keeps the profit figure honest."*

---

## New, but nothing to unlearn

Everything below is additional. Nothing that worked before works differently.

| Where | What |
|---|---|
| Reports → **Trial Balance** | Every account, debits and credits. **Click any account** to see the entries behind it. |
| Reports → **Balance Sheet** | What the shop owns, owes and is worth — plus the **year close**. |
| Reports → **Profit & Loss (ledger)** | The same postings as the Balance Sheet, so the two cannot disagree. |
| Reports → **Ledger Reconciliation** | Checks the new ledger against the figures the app already prints. |
| Settings → **Books locked upto** | Nothing dated on or before that day can be created, changed or deleted. |
| Item page | **Reverse** a stock adjustment — adds the opposite entry, keeps both. |
| Everywhere | Every record now stores who created it, who changed it, and when. |

### Two of those are worth a minute of the owner's time

**Ledger Reconciliation** is the one to open first. Every row green means the
new ledger independently reproduces receivables, payables, cash, every bank
balance and the profit figure the shop has been running on. If a row is red,
it names the figure and the amount — most likely a bank balance that has
drifted from its own transactions.

**Year close** empties the year's income and expenses into Retained Earnings
so the new year starts from zero. It shows the exact entry before posting
anything, and a closed year can be reopened — which reverses the closing
entry rather than deleting it.

---

## What is deliberately NOT switched on

- **The old Profit & Loss report is untouched.** The new one counts stock
  written off and unexplained cash, which the old one never did, so its
  profit figure differs. The new statement names those accounts and their
  amounts on screen. Which one becomes *the* P&L is the shop's decision, not
  a silent swap.
- **WhatsApp on the test site.** Everything else about testing is undoable; a
  message that reaches a customer's phone is not.

---

## The one thing this cannot tell you

Every figure above has been checked against generated data — over 110,000
assertions, and ~120 deliberate breakages to prove the checks bite. None of it
has touched the shop's real records.

Open **Reports → Ledger Reconciliation** on a copy of the real books before
trusting any of it. That single screen is worth more than every number in this
document.

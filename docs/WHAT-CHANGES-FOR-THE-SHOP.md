# What changes for the shop

Everything on the `iballmobileshopfull` branch, in the words to say to the
owner. Standing rule 5 of `ERP-PLAN.md`: a behaviour change gets flagged
before it reaches the counter, not explained afterwards when somebody rings up
confused.

Most of this work adds screens that were not there. Only **four** things
change how the shop already works, and they are the first four below.

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

**What to say:** _"Old bills are cancelled, not removed. They stay on the
list marked Voided so the month still adds up, and you have to say why."_

---

## 2. An older bill can no longer be edited

**Before:** any bill could be opened and changed.

**Now:** **today's** bills are fully editable. Anything earlier opens a notice
saying it cannot be changed, and to void it and issue a new one instead.

Applies to bills, purchases, payments, expenses, cash entries and transfers.

**Why:** it is the same door as above. Stopping a three-month-old bill being
deleted while leaving it editable to any figure changes that month just the
same — and an edit leaves _less_ trace than a deletion, because a deletion is
at least written to the audit log with a copy of what went.

**What to say:** _"You can fix today's entries freely. To change an older one,
cancel it and make a new one — both stay on the record."_

---

## 3. Cash entries must say why the money moved

**Before:** Adjust Cash asked for an amount and a free-text note.

**Now:** it also asks **why** — opening balance, owner put in, owner took out,
counting difference, or something else — and the answer sets the direction
where only one makes sense.

Older entries with no reason show an amber **Uncategorised** mark and are
totalled separately on the Cash page.

**Why:** the shop has a real entry reading _"CASH ADD TILL TODAY FROM VYAPAR
₹29,000"_. That is money in the drawer with nothing saying whether the shop
earned it, the owner put it in, or it came from the old system — so the profit
figure quietly absorbed it and that month was wrong by ₹29,000.

**What to say:** _"When you add or remove cash by hand, tell it why. It takes
one tap and it keeps the profit figure honest."_

---

## 4. Items marked "track serial numbers" are counted, not typed

This one only applies to items the shop _chooses_ to switch on — the Apple
adapters and anything else where each unit has its own number and its own
warranty. Every other item behaves exactly as it always did.

**Before:** an adapter was one item with a stock figure. Twelve came in, the
figure said 12. Which twelve, nobody knew.

**Now**, for a serial-tracked item:

- **Receiving one asks for the serial numbers.** A purchase bill for 12
  adapters will not save until 12 serials have been scanned or typed.
- **Selling one asks which unit.** Same rule: 3 on the line, 3 units picked.
- **The stock figure is the count of units on the shelf.** It is not stored
  and cannot be typed. It is always exactly what the unit list says.
- **The unit numbers print on the customer's copy** — the A4 bill, the
  thermal receipt, and both credit and debit notes, under the item they
  belong to. That paper is the customer's half of the warranty: without it, a
  claim eight months from now comes down to whether the counter believes
  them.

Returning one asks **which unit came back** — and, because a warranty failure
is the commonest return there is, whether it came back **faulty**. Tick that
and the unit is marked damaged instead of going back on the sellable shelf.
The units are never copied across from the original bill: the bill says what
went out, and only the counter can say what came back.

These therefore **refuse** rather than guess, each saying what to do instead:

| If somebody tries to…                                                      | It says                                                          |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| type a stock figure for one of these items (item page, or the bulk editor) | receive units on a purchase, or void the document that was wrong |
| delete or cancel a purchase whose units have **already been sold**         | names those units and stops                                      |
| return a unit that was **sold on a different bill**                        | names the bill the note is raised against                        |
| return a unit that was **never sold**                                      | says so — it cannot come back from a customer it never went to   |

The purchase one is not a limitation. A unit in a customer's hands cannot stop
having arrived, and the purchase record is the only thing that lets the shop
claim a faulty one back from the vendor.

Profit on these items is now **exact**. An ordinary item can only be costed on
an average — twelve identical cables came in at three prices and nobody can
say which one went out. An adapter has no such excuse: the unit that left is
named on the bill, and what that one cost is on its record. So the margin on
each adapter is the real margin, not a shop-wide average.

**Why:** the shop sells by name _and_ serial because the warranty is against
the unit, not the item. A single stock number cannot answer "is this one
still covered", and once one unit's warranty differs from another's, a count
is not enough.

**What to say:** _"For the adapters, scan each one in when it arrives and
scan it out when it sells. The stock number then looks after itself, and you
can look up any unit's warranty in a second."_

---

## New, but nothing to unlearn

Everything below is additional. Nothing that worked before works differently.

| Where                                | What                                                                                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reports → **Trial Balance**          | Every account, debits and credits. **Click any account** to see the entries behind it.                                                                                                              |
| Reports → **Balance Sheet**          | What the shop owns, owes and is worth — plus the **year close**.                                                                                                                                    |
| Reports → **Profit & Loss (ledger)** | The same postings as the Balance Sheet, so the two cannot disagree.                                                                                                                                 |
| Reports → **Ledger Reconciliation**  | Checks the new ledger against the figures the app already prints.                                                                                                                                   |
| Settings → **Check Serial Numbers**  | Asks whether every unit still agrees with the bill that moved it. Reports only — fixing one means either moving the unit or correcting the document, and only the shop knows which really happened. |
| Settings → **Books locked upto**     | Nothing dated on or before that day can be created, changed or deleted.                                                                                                                             |
| **Serial Lookup** (Master Data)      | Scan a unit: which item it is, who bought it, when, **whether it is still under warranty**, and whether the shop can still claim it back from the vendor.                                           |
| Item page → **Units**                | Every unit of a serial-tracked item, its status, who it went to, and its warranty — with how many are on the shelf.                                                                                 |
| Item page                            | **Reverse** a stock adjustment — adds the opposite entry, keeps both.                                                                                                                               |
| Everywhere                           | Every record now stores who created it, who changed it, and when.                                                                                                                                   |

### Three of those are worth a minute of the owner's time

**Ledger Reconciliation** is the one to open first. Every row green means the
new ledger independently reproduces receivables, payables, cash, every bank
balance and the profit figure the shop has been running on. If a row is red,
it names the figure and the amount — most likely a bank balance that has
drifted from its own transactions.

**Serial Lookup** is the one the counter will use every day. Somebody walks
in holding an adapter; scan it and the screen answers the only three questions
that matter — is it ours, is it still covered, and can we still send it back
to the vendor. The last few characters work too, for a customer reading it out
down the phone.

**Year close** empties the year's income and expenses into Retained Earnings
so the new year starts from zero. It shows the exact entry before posting
anything, and a closed year can be reopened — which reverses the closing
entry rather than deleting it.

---

## What is deliberately NOT switched on

- **The old Profit & Loss report is untouched.** The new one counts stock
  written off and unexplained cash, which the old one never did, so its
  profit figure differs. The new statement names those accounts and their
  amounts on screen. Which one becomes _the_ P&L is the shop's decision, not
  a silent swap.
- **WhatsApp on the test site.** Everything else about testing is undoable; a
  message that reaches a customer's phone is not.

---

## Before this branch can run at all

**The Firestore rules must be published to the database this branch uses.**
Three collections it writes are new since production — the units themselves,
the year-close entries, and the deletion log — and Firestore denies anything
it has no rule for. Until `firestore.rules` is published, the app will look
like it is working and then fail on save.

The deletion log is the one to be careful about: its entry is written in the
same batch as the deletion it records, so if that collection is denied, the
whole batch fails and **the delete itself fails**, on every screen. This does
not affect the shop's live system today — production has none of these three
collections — but it will the moment this branch is deployed.

Publish via Firebase Console → Firestore Database → select the database this
deployment points at → Rules → paste `firestore.rules` → Publish.

---

## The one thing this cannot tell you

Every figure above has been checked against generated data — over 110,000
assertions, and ~120 deliberate breakages to prove the checks bite. None of it
has touched the shop's real records.

Open **Reports → Ledger Reconciliation** on a copy of the real books before
trusting any of it. That single screen is worth more than every number in this
document.

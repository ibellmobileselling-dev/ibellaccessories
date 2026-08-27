# BizDesk — Sidebar Map & Data Flow

_App: Vyapar-style GST billing + inventory. Stack: React 19 + TanStack Router, Firebase (Auth + Firestore, no backend server), offline-first._

---

## 1. Sidebar — 7 groups, 17 options

Each group is gated by a permission **module** — a user only sees groups they have `view` on (the Owner sees everything). "System" is owner-only.

| #   | Group                   | Permission module  | Options (route)                                                                                                     |
| --- | ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1   | **Overview**            | _always visible_   | Dashboard (`/`)                                                                                                     |
| 2   | **Master Data**         | `masterData`       | Parties (`/parties`) · Items (`/items`) · Inventory (`/inventory`)                                                  |
| 3   | **Sales**               | `sales`            | Sales (`/sales`) · Sale Return (`/sale-return`)                                                                     |
| 4   | **Purchase & Expenses** | `purchaseExpenses` | Purchase (`/purchase`) · Purchase Return (`/purchase-return`) · Expenses (`/expenses`) · Expense Payees (`/payees`) |
| 5   | **Cash & Bank**         | `cashBank`         | Bank Accounts (`/bank`) · Cash on Hand (`/cash`) · Payments (`/payments`)                                           |
| 6   | **Reports**             | `reports`          | Reports (`/reports`) · Daybook (`/daybook`) · GST Returns (`/gst`)                                                  |
| 7   | **System**              | owner-only         | Settings (`/settings`)                                                                                              |

**Totals:** 7 groups · 17 navigable options.
Keyboard jumps: `Alt+1…8` → Dashboard, Parties, Items, Sales, Purchase, Expenses, Reports, Settings.

---

## 2. How data moves (the big picture)

```
Firebase Auth  ──(sign in)──►  AuthGate (__root.tsx)
                                   │  hydrateRepos(uid)  — only the modules this user can view
                                   ▼
Firestore (cloud, named DB "ibellaccessory")
   │  onSnapshot (live listener, per collection)
   ▼
Repository in-memory cache  ◄────────────────────────────┐
   │  synchronous reads: Repo.all() / Repo.get(id)        │  cache-first write
   ▼                                                      │  (updates cache instantly,
Screens (routes/components)                               │   then fire-and-forget to cloud)
   │  derive numbers at render time via src/lib/ledger.ts │
   └──────────────────── writes ─────────────────────────┘
```

- **Reads are synchronous** off an in-memory cache that a Firestore `onSnapshot` listener keeps live. Screens never `await` a read.
- **Writes are cache-first**: the cache updates immediately (instant UI), and the Firestore write is queued in the background. Offline, that queue replays on reconnect (`persistentLocalCache`).
- **Nothing aggregate is stored.** Balances, outstanding, P&L, GST, stock value — all **recomputed from the documents** on every render (`src/lib/ledger.ts`). This is why deleting/editing one document can never leave a stale total: there is no total to go stale.
- **The one stored counter exceptions:** `Item.stock` and `BankAccount.balance` — both mutated only through **atomic increments** (`adjustField`), so two devices changing them at once both count.
- **Atomicity:** multi-document writes (e.g. save a bill + adjust stock + link payment) go through a single `writeBatch` (`newBatch`/`commitBatch`) — all-or-nothing, and offline-safe.

---

## 3. Collections & who writes them

| Firestore collection                     | Written by                                             | Key references                                                       |
| ---------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| `parties`                                | Parties screen                                         | — (referenced by `partyId`)                                          |
| `items`                                  | Items screen; **+stock** by every sale/purchase/return | —                                                                    |
| `sales` / `purchases`                    | Sale/Purchase forms                                    | `partyId` (+ name snapshot), `lineItems[].itemId`, optional `bankId` |
| `sale-returns` / `purchase-returns`      | Return forms                                           | `partyId`, `itemId`, `originalRef` (bill number)                     |
| `payments`                               | Payments screen                                        | `partyId`, `allocations[].invoiceId`, optional `bankId`              |
| `expenses`                               | Expenses screen                                        | `payeeId`, optional `bankId`                                         |
| `payees`                                 | auto-created from expenses                             | —                                                                    |
| `banks` / `bankTxns`                     | Bank screen                                            | `bankId`                                                             |
| `stock-adjustments` / `cash-adjustments` | Items / Cash / Bank screens                            | `itemId` / —                                                         |
| `teamUsers`                              | Owner (Settings → Team)                                | Firebase Auth UID                                                    |
| `settings/company`                       | Owner (Settings)                                       | —                                                                    |

Party references are **plain string IDs plus a frozen name snapshot** on every transaction — so a bill always displays correctly even if the party is later archived.

---

## 4. Data flow per sidebar option

### Overview → Dashboard (`/`)

Reads **all** repos → computes Receivable/Payable (`partyBalances`), cash & bank positions, today's activity, and report shortcuts. Pure read; writes nothing.

### Master Data

- **Parties** — CRUD parties. **Archive** (soft-delete) hides a party from new-transaction pickers but keeps it in all history; **Restore** brings it back; **Permanent delete** is owner-only and only for a party with zero history and zero opening balance.
- **Items** — CRUD items; stock adjustments (atomic). Item delete is blocked if the item appears on any bill/return.
- **Inventory** — read-only view of item-wise stock & value (derived from items + movements).

### Sales / Purchase (`/sales`, `/purchase`)

Create/edit a bill → in one atomic batch: writes the invoice, **decrements/increments item stock**, links any payment, and moves the bank balance if paid by bank. Editing reverses the old effects first, then applies the new ones. Deleting restores stock, un-links payments (money becomes an advance), and reverses the bank move — and is blocked if a return exists against the bill.

### Sale / Purchase Return (`/sale-return`, `/purchase-return`)

Create a credit/debit note → restores or removes stock (opposite of the bill). Capped so you can't return more than was sold/purchased. Delete reverses the stock, atomically.

### Purchase & Expenses → Expenses / Payees

Expense records money out (cash or bank); a bank expense moves the bank balance. Payees are the "paid to" list, auto-grown, guarded against deletion when referenced.

### Cash & Bank

- **Bank Accounts** — accounts + deposit/withdraw (atomic: writes the passbook txn, moves the balance, and optionally a linked cash adjustment — all in one batch). Passbook page derives its running balance from those txns.
- **Cash on Hand** — cash position derived from all cash-mode flows + manual cash adjustments.
- **Payments** — receive/pay money; allocate it across open bills (updates each bill's `paid`), or leave it as an advance. Edit/delete reverses the old allocations first.

### Reports

- **Reports** — Profit & Loss, Sales/Purchase, Party Ledger, GST Summary, Stock, etc. — all derived, exportable to Excel/PDF.
- **Daybook** — every transaction on a chosen day.
- **GST Returns** — output tax (sales − sale returns) vs input tax (purchases − purchase returns), from line-item GST. Party-independent.

### System → Settings

Company details, round-off / negative-stock toggles, backup (export/import JSON), clear-all, and Team management (owner-only, permission-scoped).

---

## 5. Money & stock flow (at a glance)

```
SALE            stock −qty   ·  party receivable +total  ·  paid → cash/bank +
PURCHASE        stock +qty   ·  party payable   +total   ·  paid → cash/bank −
SALE RETURN     stock +qty   ·  party receivable −        (credit note)
PURCHASE RETURN stock −qty   ·  party payable   −         (debit note)
PAYMENT IN      party receivable −  ·  cash/bank +
PAYMENT OUT     party payable   −  ·  cash/bank −
EXPENSE         cash/bank −
```

Every one of these is written atomically, reversed correctly on edit/delete, and re-derived into the dashboards/reports — never stored as a running total.

---

_Generated as a reference for the current production build (v26)._

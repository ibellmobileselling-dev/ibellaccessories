# Serial numbers — plan and 360° impact analysis

For the `iballmobileshopfull` shop: adapters bought by the box from a vendor,
sold one at a time, each with its own serial number, because the customer's
warranty is against **that** unit and the shop's claim against the vendor is
against that same unit.

This is `ERP-PLAN.md` §4.9 (Serial / IMEI), planned properly before any code.

---

## 1. The decision the whole design rests on

**One catalogue item. Many serials under it.**

Not one item per adapter. The client asked for that and it is the one shape to
avoid, so the reason is written down rather than argued twice:

|                                 | One item per adapter                          | One item + serials              |
| ------------------------------- | --------------------------------------------- | ------------------------------- |
| Items after 3 years @ 50/month  | ~1,800, nearly all stock 0                    | 1                               |
| Buying 20 adapters              | Create 20 items — name, HSN, GST, prices each | 1 line, qty 20, scan 20 serials |
| Price rises ₹50                 | Edit every unsold item                        | Edit one field                  |
| "How many 20W sold this month?" | Impossible — nothing to group by              | One number                      |
| "Do I need to reorder?"         | Impossible — every item is 1 or 0             | Stock 12, min 5 → alert         |
| HSN / GST rate                  | Retyped 1,800 times                           | Once                            |

The reorder question is the one that costs the shop money: with an item per
adapter, **nothing can ever tell them they are running low.**

**The test for any future item:** if a customer would take any one off the
shelf, it is one item. If they would ask for _that specific one_, it is a
different item. 20W and 30W are different items. Two 20W adapters are not.

**The honest exception**, for when they start taking second-hand phones in
exchange: those genuinely are not interchangeable — each has its own cost and
price. Even then the answer is a serial carrying its own cost and price
(§3, `costOverride`/`priceOverride`), not a new catalogue item.

---

## 2. The rule that makes it trustworthy

> **For a serialised item, stock is not a stored number. It is the count of
> serials on hand.**

```
item.stock  (serialised)  =  COUNT(serials WHERE itemId = X AND status = "in_stock")
```

`Item.stock` is one of only two stored running totals in this application, and
`planStockRepair` exists because it drifts. For serialised items that whole
class of bug disappears — there is one source, so there is nothing to
disagree with.

**Consequence, and it is the largest single change in this plan:** every one
of the eleven places that writes `"stock"` must stop doing so for a serialised
item, and move a serial instead. Listed in §5.

---

## 3. Data

### New collection: `serials`

```ts
interface Serial extends Audited, Voidable {
  id: ID;
  itemId: ID;
  /** As printed on the unit. Unique per item — see §6. */
  serial: string;

  status: "in_stock" | "sold" | "returned_to_vendor" | "damaged";

  /** Where it came from. Set on receipt, never changed. */
  purchaseId?: ID;
  purchaseDate?: string;
  vendorId?: ID;
  /** What this specific unit cost — exact COGS, not an average. */
  cost?: number;

  /** Where it went. Cleared when a sale return brings it back. */
  saleId?: ID;
  saleDate?: string;
  customerId?: ID;

  /** Customer-facing warranty. Months copied from the item at sale time so a
   *  later change to the item cannot rewrite a warranty already given. */
  warrantyMonths?: number;
  warrantyEnd?: string;
  /** The shop's own claim against the vendor — the half most software omits,
   *  and where this shop actually loses money. */
  vendorWarrantyEnd?: string;

  createdAt: string;
}
```

### Changed types

| Type       | Field                           | Why                                                              |
| ---------- | ------------------------------- | ---------------------------------------------------------------- |
| `Item`     | `trackSerials?: boolean`        | Opt-in per item. A ₹50 cable must never ask.                     |
| `Item`     | `warrantyMonths?: number`       | Default warranty given on sale.                                  |
| `Item`     | `vendorWarrantyMonths?: number` | Default claim window against the vendor.                         |
| `LineItem` | `serialIds?: ID[]`              | Which physical units this line is. Length must equal `qty` — §4. |

`LineItem.serialIds` rather than serial strings: a serial can be corrected
(mis-scan), and the line must follow it.

### Repository wiring

- `SerialRepo = new Repository<Serial>("serials")`
- Added to `REPO_BY_KEY` — so it is **hydrated at login and included in
  backups**. A backup without serials would restore a shop with stock and no
  idea what is on the shelf.
- Added to `MODULE_REPOS.masterData` (it lives with items).

---

## 4. The rule that makes the data stay true

**Serial count must equal line quantity, and the document will not save
otherwise.** Enforced on purchase, sale, and both returns.

Without this the data rots inside a month and everyone stops trusting it —
which is worse than not having the feature, because now the shop believes a
warranty screen that is wrong.

### The state machine

Only a document may move a serial. Nothing edits `status` directly.

```
                    purchase                      sale
  (new)  ──────────────────────►  in_stock  ──────────────────►  sold
                                    ▲   │                          │
                  purchase return   │   │ stock adj / damage       │ sale return
                                    │   ▼                          │
                       returned_to_vendor    damaged               │
                                    ▲                              │
                                    └──────────────────────────────┘
                                         (back to in_stock)
```

| Document                  | Effect                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Purchase saved            | create serials, `in_stock`, stamped with vendor, cost, purchase date                                  |
| Purchase edited           | reconcile against the previous set — add new, remove ones no longer listed (only if still `in_stock`) |
| Purchase voided / deleted | remove those serials, but **refuse if any has been sold**                                             |
| Sale saved                | `in_stock → sold`, stamp customer, sale date, warranty end                                            |
| Sale voided / deleted     | `sold → in_stock`, clear sale fields                                                                  |
| Sale return               | `sold → in_stock` (or `damaged`, chosen on the return)                                                |
| Purchase return           | `in_stock → returned_to_vendor`                                                                       |
| Stock adjustment (reduce) | pick which serials; `→ damaged`                                                                       |
| Stock adjustment (add)    | serialised items: not allowed — receiving stock is a purchase                                         |

---

## 5. Every place this touches

Grepped, not guessed. `"stock"` is written in **11 places across 9 files**;
`item.stock` is read in **10 files**.

### 5a. Stock writes — each must branch on `trackSerials`

| File                            | Today                                        | With serials                                  |
| ------------------------------- | -------------------------------------------- | --------------------------------------------- |
| `InvoiceForm.tsx:715`           | sale/purchase save, `stockDelta * qty`       | move the line's serials; do not touch `stock` |
| `InvoiceForm.tsx:733`           | edit path, reverses the original lines       | reconcile old serial set against new          |
| `ReturnForm.tsx:312`            | return save                                  | move serials named on the return              |
| `sales.index.tsx:217`           | delete/void a sale                           | serials `sold → in_stock`                     |
| `purchase.index.tsx:211`        | delete/void a purchase                       | remove serials; refuse if any sold            |
| `sale-return.index.tsx:79`      | delete/void                                  | serials back to `sold`                        |
| `purchase-return.index.tsx:77`  | delete/void                                  | serials back to `in_stock`                    |
| `items.tsx:468`                 | manual stock adjust                          | serialised: pick serials, or refuse           |
| `items_.$id.tsx:170`            | reverse an adjustment                        | reverse the serial moves                      |
| `BulkUpdateItemsDialog.tsx:246` | bulk stock edit                              | **must refuse** for serialised items          |
| `settings.tsx:140`              | Fix Calculations applies `plan.items` deltas | see 5c                                        |

### 5b. Stock readers — must read the derived count

`items.tsx`, `inventory.tsx`, `items_.$id.tsx`, `InvoiceForm.tsx` (the
picker's "Stock: 12 PCS"), `reports.tsx` (Stock Report), `GlobalSearch.tsx`,
`ReturnForm.tsx`, `lib/stock.ts`, `lib/dataRepair.ts`, `lib/trialBalance.ts`.

**Do not change ten call sites.** Give `Item` a single accessor —
`stockOf(item)` — that returns the serial count for serialised items and
`item.stock` otherwise, and route every reader through it. This is the same
lesson as `Repository.all()` in Phase 4: filtering at the source made 216 call
sites correct at once; ten call sites each remembering a rule would not stay
correct.

### 5c. The repair tools — the subtle one

`planStockRepair` rebuilds `item.stock` from documents. For a serialised item
that is the wrong question: stock is the serial count, and the _serials_ are
what could be wrong.

- Serialised items are **excluded** from `planStockRepair`.
- A new check replaces it: **serial integrity** — every serial marked `sold`
  points at a live sale that still lists it; every line's `serialIds` all
  exist; no serial is on two live documents. Reported the same way, dry-run
  first.

### 5d. Ledger, costing and reports

| Area                 | Effect                                                                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| COGS (`computeCogs`) | Today: `costPrice ?? item.purchasePrice`. With serials: the **exact cost of the units sold**. Profit per sale becomes exact.                                                                                                        |
| `posting.ts`         | No new rule. COGS is already `Dr COGS / Cr Inventory`; only the amount is sourced better.                                                                                                                                           |
| Reconciliation       | The Inventory row gets a **third**, better answer: serials on hand × their own cost. That is a genuine second opinion, unlike today's current-price valuation — the informational row can become a real check for serialised items. |
| Stock Report         | Serial count and value at actual cost                                                                                                                                                                                               |
| GST                  | Unaffected — serials do not change taxable value or HSN                                                                                                                                                                             |

### 5e. Documents

| Where                  | Change                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `PrintableInvoice.tsx` | Print the serials under each line. **This is the customer's warranty proof** — without it the feature is invisible to the person it protects. |
| `PrintableReturn.tsx`  | Same                                                                                                                                          |
| `ThermalReceipt.tsx`   | Serials on their own line — an 80mm receipt has no column for them                                                                            |
| CSV / XLSX exports     | Serial column where a line has them                                                                                                           |

### 5f. Interaction with what is already on this branch

Not optional, and painful to retrofit — this is why it is being planned now:

- **Voiding (Phase 4)** — voiding a sale must return its serials to
  `in_stock`, on the same batch as everything else it reverses. Voiding a
  purchase must refuse when any of its serials are already sold.
- **Period lock (Phase 0b)** — a serial movement is a dated write and asks
  `canPost` like every other.
- **Append-only edit rule** — a bill older than today is voided and re-issued,
  so serial _edits_ on old documents never arise. Simpler, not harder.
- **`Repository.all()`** — `SerialRepo.all()` excludes voided serials
  automatically; the delete guards on Items must count serials, including
  voided ones, before allowing an item to be destroyed.
- **The audit trail** — serial movements are already covered by the existing
  record stamping.

---

## 6. Rules that decide whether staff use it

Adoption is the risk, not correctness. A feature that slows the counter gets
worked around, and then the data is wrong AND the shop is annoyed.

1. **Opt-in per item.** `trackSerials` off by default. Pilot on adapters.
2. **Scan-first.** One box: scan → row added → focus returns to the box.
   Twenty units must be twenty scans and no mouse.
3. **Bulk paste.** Vendors email serial lists; accept 50 pasted at once,
   newline or comma separated.
4. **Uniqueness: per item, not global.** Two different manufacturers can
   legitimately use the same string. Enforced at save with a clear message
   naming the other document.
5. **Refuse selling a serial that is not `in_stock`** — names where it is.
6. **A mis-scan is correctable** — editing a serial's text keeps its id, so
   every line pointing at it follows.
7. **Warranty months are copied at sale time**, never read live from the item.
   Changing an item's warranty must not rewrite warranties already given.

---

## 7. The screen that sells it

A global **Serial Lookup** — type or scan, get everything:

```
Apple 20W Adapter · SN F2LX9K3MQ1
Sold      12-03-26 · INV-0847 · Ramesh Kumar
Warranty  expires 12-03-27   198 days left ✓
Bought    04-02-26 · PB-0231 · Mehta Distributors · ₹1,180
Vendor    claim window to 04-02-27 ✓
```

Two seconds at the counter answers both questions that matter: do we replace
it, and can we claim it back.

Plus a **Serials tab on the item page** — every unit, filterable by status.
That is what the client actually wanted when they asked for one item per
adapter, and it is strictly more than they asked for.

---

## 8. Order of work

| #   | Step                                                                                                                                                                       | Why this order                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | **DONE** — `Serial` type, `SerialRepo`, `stockOf()` accessor, readers routed through it                                                                                    | Nothing behaves differently yet; the seam exists              |
| 2   | **DONE** — Purchase capture + serial list on the item page                                                                                                                 | Serials exist and are visible before anything depends on them |
| 3   | **DONE** — Sale picking + the count-equals-qty rule                                                                                                                        | The state machine closes                                      |
| 4   | **DONE** — voids, deletes, stock adjustments and both returns move their units or refuse and say why                                                                       | Every other path that moves stock                             |
| 5   | **DONE** — Serial Lookup screen, warranty + vendor claim state, Units panel on the item page                                                                               | The payoff                                                    |
| 6   | **DONE** — serials print on the bill, the thermal receipt and both notes; no export is line-level, so none needed them                                                     | Reaches the customer                                          |
| 7   | **DONE** — Settings → Check Serial Numbers reports units that disagree with their documents; planStockRepair already skips serialised items                                | The old repair stops being wrong for them                     |
| 8   | **DONE** — a named unit is costed at what that unit cost, in the posting ledger and the P&L together; Inventory reconciliation row was already derived from the unit count | The ledger gets better numbers                                |

Steps 1-3 are the feature. 4-8 are what make it survive contact with a real
shop. **All eight are done.**

---

## 9. Risk

**MEDIUM-HIGH, and higher than any phase so far.** It is the first change that
alters what `item.stock` _means_, and stock is one of only two stored running
totals in the application.

Mitigations, in order of how much they matter:

1. **`trackSerials` is off by default.** Every existing item behaves exactly as
   it does today. Nothing in the shop changes until an item is opted in.
2. **`stockOf()` is one function.** The rule lives in one place, not ten.
3. **The serial-integrity check ships in the same phase**, not after — the
   thing that tells you the data is wrong arrives with the data.
4. **Mutation-proven tests**, as with every phase: the count-equals-qty rule,
   each state transition, void returning serials, and the refusal to delete a
   purchase whose serials are sold.
5. **Reconciled before believed.** Serial count vs `item.stock` for opted-in
   items must agree during the pilot, exactly as the ledger was reconciled
   against the app before anything read it.

**Behaviour change to tell the shop:** for opted-in items, a bill cannot be
saved without scanning every serial. That is the whole point and it is also
the thing they will feel — so it gets said before it ships, not after.

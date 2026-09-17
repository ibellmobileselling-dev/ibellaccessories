# WhatsApp: making a flaky link behave professionally

The shop's complaint, in their words: *"sometimes it throws waiting message,
this is not professional."* They are right, and the screen is the smaller half
of the problem.

## What is actually there

WhatsApp here is **not an API**. It is a QR-linked device: an external bridge
service (`WHATSAPP_SERVICE_URL`) that holds a WhatsApp Web session on behalf of
the shop's phone. Three endpoints — `/qr`, `/disconnect`, `/send` — behind an
`x-api-key`.

A linked device drops for reasons no amount of code in this repo can prevent:

- the shop's phone is offline ~14 days and WhatsApp force-unlinks it
- the bridge host restarts with its session credentials on temporary disk
- WhatsApp logs the device out, or somebody taps "log out from all devices"

**So the goal is not "never drop".** The goal is: when it drops, the shop finds
out immediately, in one glance, and fixes it in two clicks — and no bill is
ever silently lost in the meantime.

## The three faults, precisely

1. **`waiting` is a bucket.** Booting, reconnecting, logged-out and
   never-linked are one indistinguishable state, rendered by
   `WhatsAppSection.tsx` as a spinner reading *"Starting WhatsApp
   connection…"* — with no timeout. It spins forever and advises nothing.

2. **Status is invisible.** It is rendered in exactly one place, inside an
   owner-only card on the Settings page. The counter learns WhatsApp is dead
   at 6pm with a customer waiting, never at 9am when it could be fixed.

3. **A failed send is a lost bill.** `sendElementViaWhatsApp` is a single
   `fetch`. Socket down at that instant → throw, toast, and nothing else. No
   retry, no record, and nobody can answer "which customers didn't get theirs?"

## The constraint that shapes everything

**The bridge service is a separate codebase and is not in this repo.** Every
phase below is therefore designed to land entirely in this repo, deriving what
it needs from the three endpoints that already exist. Bridge-side work
(auto-reconnect, a real heartbeat) is real and worth doing, but it is Phase 6
and nothing before it depends on it.

## Two ideas that make this work without touching the bridge

**A. The state machine is client-side.** `/qr` returns three states; a shop
needs six. The missing information is not in the response — it is in *time* and
*history*, both of which the client has:

| bridge says | seen connected before? | watched for | → shown as |
| --- | --- | --- | --- |
| `connected` | – | – | **connected** (green) |
| `qr` | no | – | **never linked** (red, offers QR) |
| `qr` | yes | – | **dropped** (red, offers QR) |
| `waiting` | – | < 30s | **starting** (grey) |
| `waiting` | yes | ≥ 30s | **dropped** (red) |
| `waiting` | no | ≥ 30s | **never linked** (red) |
| unreachable | – | ≥ 30s | **unreachable** (red) |

**B. The send result is ground truth, and outranks the status.** A sleeping
bridge answers `/qr` cheerfully while WhatsApp is long gone, so a green light
sourced only from polling is a light that lies. A `/send` that succeeds proves
the socket was alive one second ago; a `/send` that fails proves it was not.
Both feed straight back into the indicator. This is what makes the dot
*accurate* rather than merely present.

## Phases

Ordered so that each one is useful alone, and so nothing shows a status before
that status is trustworthy.

### Phase 0 ✅ — the state machine, as a pure function

`src/lib/whatsappLink.ts`: `deriveLinkState(bridge, history, now)` — the table
above and nothing else. No React, no fetch, no clock of its own. It is the
piece most worth testing and the piece most likely to be reasoned about wrongly
at 6pm, so it gets to be pure.

Also here: the copy. `linkHeadline(state)` and `linkAdvice(state)` — one place
where the shop's wording lives, so "Disconnected — scan to relink" cannot drift
between the header tooltip, the modal and Settings.

### Phase 1 ✅ — status without handing out the QR

`getWhatsAppStatusServerFn` currently calls `requireOwner`. Put the indicator
in the header as-is and it throws for every staff user on every page.

Split it in two:

| server fn | guard | returns |
| --- | --- | --- |
| `getWhatsAppLinkStateServerFn` | `requireActiveUser` | state + phone, **`qr` stripped** |
| `getWhatsAppStatusServerFn` | `requireOwner` (unchanged) | state + phone + `qr` |

**The QR is a login.** Anyone who scans it gets full control of the shop's
WhatsApp account. It must never be sent to a non-owner's browser, and stripping
it server-side — rather than merely not rendering it — is the difference
between a permission and a decoration.

### Phase 2 ✅ — one poller for the whole app

`src/store/whatsappLink.ts`: a single Zustand store, one timer, shared by every
subscriber. Not a `useEffect` per component — the header indicator lives on
every page, and a poll per mount would multiply by tabs and tills.

Cadence, so the bridge is only asked when someone is actually looking:

- **60s** when connected — nothing is changing
- **15s** when broken — somebody is probably fixing it
- **3s** while the modal is open on a QR — it needs to look fresh
- **immediately** on tab focus, and after every send attempt
- **never** while the tab is hidden

### Phase 3 ✅ — the indicator and the modal

A small WhatsApp glyph in `Topbar.tsx` with a status dot: **green** connected,
**grey** starting, **red** everything else. Tooltip says the headline. Click
opens the reconnect modal.

Owner sees the QR and Disconnect. Staff see the state and *"ask the owner to
relink"* — because staff cannot fix this, and a screen that implies otherwise
wastes their time at the counter.

Mobile: the header is a three-column grid and already tight, so the dot rides
next to the existing search icon rather than claiming a new slot.

### Phase 4 ✅ — the nudge, kept on a short leash

If the link is broken when the app opens, the owner gets the modal once.

**Owner only, once per session, dismissible, and never while a bill is open.**
A modal in the face of a counter clerk who cannot fix it — mid-sale, at 9am —
is its own kind of unprofessional, and would be a worse complaint than the one
being fixed here.

### Phase 5 ✅ — the outbox (the phase that stops bills being lost)

A failed send stops being a dead end:

> *"Queued — will send when WhatsApp reconnects."*

Queued in IndexedDB on the till that made it: `{ html, phone, message,
fileName, invoiceNumber, queuedAt, attempts }`. **The HTML, not the PDF** —
`buildPrintableHtml(el)` already produces exactly this string, it is a fraction
of the size of the rendered PDF, and re-rendering at send time costs nothing we
were not already paying.

Flushed one at a time when the link comes back, oldest first, with backoff and
an attempt cap. The header dot carries the count. Settings lists what is
waiting, with **Send now** and **Remove** per row.

**The decision that shaped it: not everything may be retried.** Three outcomes,
not two, because a queue that retries everything is a machine for sending a
customer their invoice twice:

| the failure | what happens |
| --- | --- |
| **permanent** — no phone on the party, PDF won't render, not signed in | never queued; the person is told now, because waiting fixes nothing |
| **offline** — the link was already down, or the service said so | queued and retried on its own: nothing reached WhatsApp, so a resend is safe |
| **uncertain** — an unexplained failure on a *live* link | queued, but **never** auto-sent. It may already have been delivered. A person presses Send now, or removes it. |

Two more duplicate-avoidance rules: a row is **claimed with a timestamp**
before an attempt so two tills cannot flush it at once (a timestamp and not a
flag, or a tab closed mid-send locks the row out forever), and a **manual**
attempt that fails does not re-arm the timer — the person watching is the one
who decides to try again.

Nothing is ever discarded to tidy up. Past the attempt cap the row stops
retrying and asks for a person: a bill the shop believes went out must not
evaporate.

This phase is where "I don't want this nonsense" actually gets answered: the
counter stops babysitting the connection, because a bill entered is a bill that
will go.

### Phase 6 ✅ — the bridge service (`ibellwpserver`, a separate repo)

**Two of the three things planned here were already done, and the real fault
was something else.** Recorded honestly, because the plan was written before
anyone had read the service:

| planned | actually |
| --- | --- |
| persist the session to durable storage | **already done** — creds and Signal keys are in Firestore, not on disk |
| auto-reconnect from stored credentials | **already done** — it reconnected on every non-logout close |
| a real heartbeat | `/health` existed; now also reports `halted` and `attempts` |

And the shop's own words were read wrongly at first. *"Sometimes it throws
waiting message"* is not only this app's `waiting` status — **"Waiting for
this message" is what WhatsApp itself shows the recipient** when their phone
cannot decrypt what arrived. The service's own comments already worried about
it and had added a six-second post-connect grace, treating it as cold-start
timing. It is not timing.

**The actual fault: two sockets on one linked device.**

WhatsApp permits one live socket per linked device. A second process logging
in with the same credentials closes the first with `connectionReplaced` — and
the old code treated that as an ordinary blip and reconnected, which evicted
the second, which reconnected, which evicted the first. The two trade the
session back and forth indefinitely. Messages keep going out during the
fight; what breaks is the recipient's Signal session, which is rotated out
from under them. Their phone shows "Waiting for this message".

Fixed:

- **`connectionReplaced` no longer reconnects.** The service stays down and
  says why on `/health`, because nothing it can do will help and trying makes
  it worse. Usually the other instance is a forgotten local `npm run dev`, or
  a deploy that overlapped old and new containers.
- **`start()`'s rejection is caught.** It was called bare; one failed
  Firestore read or version fetch left an unhandled rejection and killed the
  reconnect chain outright, leaving the service disconnected until a redeploy.
  *That* is what "the connection expires after a while" actually was.
- **Sockets are retired before their replacement dials**, and each carries a
  generation number — a superseded socket's late `close` used to mark the
  service disconnected while it was, at that moment, connected. The status
  endpoint lied, and the new header dot would have faithfully shown the lie.
- **Backoff** 1s→2s→4s to a minute, with jitter, so restarted instances do not
  reconnect in lockstep and cause the `connectionReplaced` above.
- **A dead session relinks** rather than retrying credentials WhatsApp has
  already rejected.

The rules are a pure module (`src/reconnect.js`) with 24 assertions; eight
mutants each kill a named one.

### Phase 6b ✅ — the duplicate this could not previously prevent

Phase 5 left one hole open and said so: the message leaves, the reply is lost
coming back, and nothing on the app's side can tell that from "it never sent".

`POST /send` now takes an optional **`clientMessageId`**, claimed in Firestore
before sending. A retry carrying an id already marked sent is answered, not
re-sent. The app mints the id **before the first attempt** and stores the
queued row **under that same id**, so every retry of one bill carries one id —
if a retry arrived under a fresh id, the service would see a different bill
and the duplicate would go out anyway. Both halves are asserted.

A claim left pending for over two minutes is let through rather than blocked:
an attempt died mid-send, nobody can know whether it went, and a bill the
customer never receives is worse than one they receive twice.

Sends without an id behave exactly as before, so a deployed build of the app
that predates this keeps working.

## Testing

Phase 0 is pure and gets the full table above as assertions, including the two
that are easy to get backwards: `qr` **with** history is a relink and `qr`
**without** is first-time setup, and `waiting` at 29s is still *starting* while
at 31s it is *dropped*.

Mutation-tested as usual: break the grace period, break the history check,
break the QR-stripping — each must turn a **named** assertion red. The
QR-stripping mutation matters most, because a test that passes when a staff
user receives the QR is a test that is not protecting anything.

## Rollout

Branch `whatsapp-reliability`, off `main`. **Nothing goes to `main` until the
whole thing is verified**, because `main` is what the two live shops run and it
holds real data.

Phases 0–4 touch no money, no stock and no document. The only write anywhere in
them is a `localStorage` note of when the link was last seen alive. Phase 5
introduces a queue, which is new state and gets its own look before it ships.

`APP_VERSION` is bumped on the deploy, per the repo rule — a fix the shop
cannot see the version of is a fix they will report again.

## Where this got to

**All seven phases are built.** Two repos, two branches, **neither pushed and
neither merged**:

| repo | branch | state |
| --- | --- | --- |
| `desktop-ledger` | `whatsapp-reliability` | phases 0–5, 6b — `main` untouched at `c7e7f0b` |
| `ibellwpserver` | `reconnect-hardening` | phase 6 — `main` untouched |

Verified: **105,419 unit assertions**, **577 screen assertions**, **24 bridge
assertions**; `tsc` and `eslint` clean; `npm run build` completes.

**Thirty mutants planted, thirty killed**, each by a *named* assertion. The
three worth naming, because all three are invisible in any return value:

- reading the link state **after** the attempt instead of before — every
  unprovable failure would then be filed as safe-to-retry, and the only
  symptom would be customers receiving two copies of an invoice.
- reconnecting on **`connectionReplaced`** — the old behaviour, and the cause
  of "Waiting for this message" on the recipient's phone.
- giving a **retry a fresh id** — the service's deduplication would still be
  there, still be tested, and still let every duplicate through.

### What is left, and it is not code

- **Nothing is deployed.** Both branches want a preview and a look before they
  go near the two live shops.
- **Check whether a second instance is running right now.** `GET /health` will
  say `halted` once this deploys. A forgotten local `npm run dev`, or a host
  that overlaps containers on deploy, is the likeliest cause of the original
  complaint. Set the platform to stop the old instance before starting the new.
- **Keep an uptime ping on `/health`** so the host does not idle the process
  out — a cold start costs a reconnect, and a reconnect is when delivery is
  most fragile.
- **A Firestore TTL policy on `waSendClaims`** (field `at`). Nothing breaks
  without one; the collection just grows.
- **Still outstanding from earlier, and still user-side:** rotate the Firebase
  service-account key that appeared in a transcript, and set
  `VITE_FIRESTORE_DB` at **Preview** scope on both Vercel projects — branch
  previews currently build against live shop data.

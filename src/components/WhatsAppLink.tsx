/**
 * The WhatsApp link, everywhere it is shown.
 *
 * Three surfaces, one source: a dot in the header, a dialog behind it, and the
 * Settings card. They existed as one screen before — buried in Settings, owner
 * only — which is why a shop could go a day sending nothing before noticing.
 *
 * The wording is not written here. It comes from `lib/whatsappLink`, so the
 * tooltip, the dialog and the Settings card cannot end up describing the same
 * fault three different ways.
 */

import { useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import {
  MessageCircle,
  ShieldAlert,
  Loader2,
  CheckCircle2,
  RefreshCw,
  Send,
  Trash2,
  Clock,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { auth } from "@/lib/firebase";
import { usePermissions } from "@/hooks/usePermissions";
import { useWhatsAppLink, useWhatsAppLinkStore } from "@/store/whatsappLink";
import { useOutboxStore } from "@/store/whatsappOutbox";
import { needsAttention, MAX_ATTEMPTS } from "@/lib/outbox";
import { disconnectWhatsAppServerFn } from "@/lib/whatsappAdmin";
import {
  linkAdvice,
  linkHeadline,
  linkSeverity,
  needsScan,
  sinceLabel,
  type LinkSeverity,
} from "@/lib/whatsappLink";

const DOT: Record<LinkSeverity, string> = {
  ok: "bg-success",
  busy: "bg-muted-foreground animate-pulse",
  bad: "bg-destructive",
};

/**
 * The header dot.
 *
 * Shown even when everything is fine, on purpose: a light that only appears
 * when broken is one nobody can use to answer "is it working right now?" —
 * and that question, asked before a customer is standing there, is the entire
 * point of putting it in the header.
 */
export function WhatsAppStatusButton() {
  const { state, configured, ready, history } = useWhatsAppLink();
  const queued = useOutboxStore((s) => s.items.length);
  const [open, setOpen] = useState(false);

  // A deployment with no WhatsApp service says nothing at all, rather than
  // showing a permanent red light for a feature this shop never bought.
  // Waiting bills override that: something is owed to a customer, and that is
  // not conditional on a status having arrived yet.
  if (!configured || (!ready && !queued)) return null;

  const severity = linkSeverity(state);
  const label = queued
    ? `${queued} ${queued === 1 ? "bill is" : "bills are"} waiting to send · ${linkHeadline(state, history)}`
    : linkHeadline(state, history);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="relative h-8 w-8 rounded-md hover:bg-accent flex items-center justify-center text-muted-foreground shrink-0"
        title={label}
        aria-label={label}
      >
        <MessageCircle className="h-4 w-4" />
        {/* A count replaces the dot rather than joining it: two indicators on
            one 32px button is a smudge, and the number is the more urgent of
            the two — a red dot means "fix this", a number means "somebody is
            still waiting for their bill". */}
        {queued ? (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-semibold leading-4 text-center ring-2 ring-card">
            {queued > 9 ? "9+" : queued}
          </span>
        ) : (
          <span
            className={`absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-card ${DOT[severity]}`}
          />
        )}
      </button>
      <WhatsAppLinkDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

/** Once per session, per browser. Deliberately session-scoped and not
 *  persisted: a shop that closes the app and comes back tomorrow with WhatsApp
 *  still broken does want telling again. */
const NUDGE_KEY = "bizdesk.whatsapp.nudged.v1";

/**
 * Where this must never interrupt.
 *
 * A bill being written, obviously. But also Sales and Purchase themselves:
 * that is where the counter spends its day, and a dialog thrown across it is
 * not a warning any more, it is something in the way. The shop asked for it
 * off those pages by name after it landed on them mid-work.
 *
 * What it reports is usually a configuration fault nobody at the counter can
 * fix anyway — a wrong service URL, an expired key — so the red dot in the
 * header carries it instead, and opens this on a click when somebody
 * actually wants it.
 */
const BUSY_ROUTE = new RegExp("/new$|/edit/|^/sales|^/purchase");

/**
 * Tells the owner, once, that WhatsApp is not going to send anything today.
 *
 * Deliberately narrow, because a modal is the rudest control in the app:
 *
 *  - **Owner only.** Nobody else can scan the QR, so for a counter clerk this
 *    would be an interruption with no action attached to it.
 *  - **Once per session**, and never again after it is dismissed.
 *  - **Never over a half-written bill** — it waits for the next ordinary page
 *    rather than landing mid-sale.
 *  - **Never during a normal start.** It fires on a settled fault, so the
 *    thirty seconds a cold bridge legitimately takes stay silent.
 */
export function WhatsAppStartupNudge() {
  const { state, ready, configured } = useWhatsAppLink();
  const { isOwner } = usePermissions();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  const fired = useRef(false);

  const broken = ready && configured && linkSeverity(state) === "bad";
  const busy = BUSY_ROUTE.test(pathname);

  useEffect(() => {
    if (fired.current || !isOwner || !broken || busy) return;
    try {
      if (sessionStorage.getItem(NUDGE_KEY)) return;
      sessionStorage.setItem(NUDGE_KEY, "1");
    } catch {
      // Storage blocked: show it once for this mount rather than every render.
    }
    fired.current = true;
    setOpen(true);
  }, [isOwner, broken, busy]);

  return <WhatsAppLinkDialog open={open} onOpenChange={setOpen} />;
}

export function WhatsAppLinkDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4" /> WhatsApp
          </DialogTitle>
        </DialogHeader>
        <WhatsAppLinkPanel inDialog />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The body: what the link is doing, and the one thing to do about it.
 *
 * `inDialog` only tells the panel to ask for a faster poll while it is on
 * screen — the QR has to look live while somebody is pointing a phone at it.
 */
export function WhatsAppLinkPanel({ inDialog = false }: { inDialog?: boolean }) {
  const { state, ready, history, phone, qr, lastError, askFailed } = useWhatsAppLink();
  const { isOwner } = usePermissions();
  const [disconnecting, setDisconnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Owner, and on screen: fetch the code as well as the status. Gated on the
  // owner rather than on being in a dialog — the Settings card is where this
  // shop has always scanned from, and requiring the header dialog instead
  // would be a regression dressed as a permission.
  useWatchWhileMounted(isOwner);

  if (!ready) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking WhatsApp…
      </div>
    );
  }

  const severity = linkSeverity(state);
  const since = sinceLabel(history.lastConnectedAt, Date.now());
  const showQr = isOwner && needsScan(state) && !!qr;

  const disconnect = async () => {
    if (!confirm("Disconnect WhatsApp? You'll need to scan a new QR code to reconnect.")) return;
    setDisconnecting(true);
    try {
      const callerIdToken = await auth.currentUser?.getIdToken();
      if (!callerIdToken) throw new Error("Not signed in");
      await disconnectWhatsAppServerFn({ data: { callerIdToken } });
      toast.success("WhatsApp disconnected");
      await useWhatsAppLinkStore.getState().refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not disconnect");
    } finally {
      setDisconnecting(false);
    }
  };

  const recheck = async () => {
    setRefreshing(true);
    try {
      await useWhatsAppLinkStore.getState().refresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-md border px-3.5 py-3">
        <div
          className={
            "h-9 w-9 rounded-full flex items-center justify-center shrink-0 " +
            (severity === "ok"
              ? "bg-success-soft text-success"
              : severity === "busy"
                ? "bg-muted text-muted-foreground"
                : "bg-destructive/10 text-destructive")
          }
        >
          {severity === "ok" ? (
            <CheckCircle2 className="h-4.5 w-4.5" />
          ) : severity === "busy" ? (
            <Loader2 className="h-4.5 w-4.5 animate-spin" />
          ) : (
            <ShieldAlert className="h-4.5 w-4.5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{linkHeadline(state, history)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {linkAdvice(state, history, isOwner)}
          </p>
          {/* Only worth saying while it is broken: on a working link it is
              "connected just now", which is what the green dot already says. */}
          {severity === "bad" && since && (
            <p className="mt-1 text-xs text-muted-foreground">{since}</p>
          )}
          {state === "connected" && phone && (
            <p className="mt-1 text-xs text-muted-foreground">as +{phone}</p>
          )}
          {/* The actual words of the actual failure. Absent from the first
              version, which is why a service answering in under a second
              could be reported as unreachable with nothing to contradict it. */}
          {severity === "bad" && lastError && (
            <p className="mt-1 text-xs text-muted-foreground/70">
              {askFailed ? "Couldn't check: " : ""}
              {lastError}
            </p>
          )}
        </div>
      </div>

      {showQr && (
        <div className="flex flex-col items-center gap-2 rounded-md border p-4">
          <img
            src={qr}
            alt="Scan with WhatsApp to link"
            className="h-52 w-52 rounded-md border p-2"
          />
          <p className="max-w-xs text-center text-xs text-muted-foreground">
            Open WhatsApp on the shop's phone → Settings → Linked Devices → Link a Device, then scan
            this code.
          </p>
        </div>
      )}

      {/* An owner told "scan the code" with no code on screen is stuck, so the
          wait is named and given a button rather than left as a blank space. */}
      {isOwner && needsScan(state) && !qr && (
        <div className="rounded-md border border-dashed px-3.5 py-4 text-center text-xs text-muted-foreground">
          Waiting for a QR code from the WhatsApp service…
        </div>
      )}

      <OutboxList />

      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="outline" onClick={recheck} disabled={refreshing}>
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Check again
        </Button>
        {isOwner && state === "connected" && (
          <Button size="sm" variant="destructive" onClick={disconnect} disabled={disconnecting}>
            {disconnecting ? "Disconnecting…" : "Disconnect"}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Bills that did not go out.
 *
 * Shown wherever the link is shown, because the two are the same question:
 * the shop does not care about a socket, it cares whether its customers have
 * their invoices.
 */
function OutboxList() {
  const { items, loaded, flushing, memoryOnly, load, sendNow, discard } = useOutboxStore();

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  if (!items.length) return null;

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 border-b px-3.5 py-2.5">
        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-sm font-semibold">{items.length} waiting to send</span>
        {flushing && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>

      {memoryOnly && (
        <p className="border-b px-3.5 py-2 text-xs text-warning">
          This browser won't let the app store anything, so these are only kept until the tab is
          closed. Send them before you leave.
        </p>
      )}

      <ul className="divide-y">
        {items.map((it) => {
          const stuck = needsAttention(it);
          return (
            <li key={it.id} className="flex items-start gap-2 px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{it.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {stuck
                    ? it.attempts >= MAX_ATTEMPTS
                      ? `Tried ${it.attempts} times and stopped — send it yourself, or remove it.`
                      : "Couldn't confirm this one sent. Check WhatsApp before sending it again."
                    : "Will send on its own when WhatsApp reconnects."}
                </p>
                {/* The service's own words, kept: "Could not send" explains
                    nothing to somebody trying to work out what to fix. */}
                {stuck && it.lastError && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground/70">{it.lastError}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2"
                  disabled={flushing}
                  onClick={() => void sendNow(it.id)}
                  title="Send this one now"
                >
                  <Send className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    if (confirm('Remove "' + it.label + "\" from the queue? It won't be sent.")) {
                      void discard(it.id);
                    }
                  }}
                  title="Remove from the queue"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Marks the store "watched" for as long as this is on screen — which speeds
 *  the poll up and, for an owner, lets the reading carry the QR. */
function useWatchWhileMounted(active: boolean) {
  const setWatching = useWhatsAppLinkStore((s) => s.setWatching);
  useEffect(() => {
    if (!active) return;
    setWatching(true);
    return () => setWatching(false);
  }, [active, setWatching]);
}

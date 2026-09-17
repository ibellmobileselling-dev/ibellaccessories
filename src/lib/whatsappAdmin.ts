import { createServerFn } from "@tanstack/react-start";
import { requireOwner, requireActiveUser } from "@/lib/firebaseAdmin";

function serviceConfig(): { url: string; key: string } {
  const url = process.env.WHATSAPP_SERVICE_URL;
  const key = process.env.WHATSAPP_SERVICE_API_KEY;
  if (!url || !key) {
    throw new Error(
      "WhatsApp service isn't configured yet — set WHATSAPP_SERVICE_URL and " +
        "WHATSAPP_SERVICE_API_KEY as environment variables.",
    );
  }
  return { url, key };
}

export interface WhatsAppStatus {
  status: "waiting" | "qr" | "connected";
  qr?: string;
  phone?: string;
}

/** What everyone else is allowed to know: whether bills will send, and
 *  whether a scan is what's holding it up — never the code itself. */
export interface WhatsAppLinkState {
  /** False when this deployment has no WhatsApp service wired up at all.
   *  Reported rather than thrown, so the app can stay silent about a feature
   *  the shop was never sold instead of showing them a permanent red light. */
  configured: boolean;
  /**
   * Whether the bridge answered.
   *
   * Reported, not thrown, and this distinction matters more than it looks:
   * if the only signal is an exception, then "the service is down" and "this
   * call never got off the ground" — a rejected token, a bad deploy, our own
   * server erroring — arrive identically, and the screen blames the service
   * for a fault that is ours. That is exactly what happened: a bridge
   * answering in under half a second was reported as unreachable.
   */
  reachable: boolean;
  status: "waiting" | "qr" | "connected";
  phone?: string;
  /** A QR is waiting, so a staff screen can say "ask the owner" rather than
   *  the useless "disconnected". */
  qrAvailable: boolean;
  /** Why the bridge did not answer, in its own words, when it did not. */
  error?: string;
}

/** Both readers below hit the same endpoint; only what they hand back differs.
 *
 * The timeout is the point of sharing it. This is polled from the header on
 * every page, and a bridge that accepts the connection then never answers
 * would otherwise leave a request — and the poll timer behind it — hanging
 * for as long as the platform allows. A read that fails fast is a red dot;
 * a read that hangs is a spinner, which is the bug being fixed.
 */
async function readBridge(): Promise<WhatsAppStatus> {
  const { url, key } = serviceConfig();
  let res: Response;
  try {
    res = await fetch(`${url}/qr`, {
      headers: { "x-api-key": key },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    /* Never reached the service at all: DNS, TLS, or it took longer than the
       timeout. Named separately from a refusal below, because "it didn't
       answer" and "it answered no" send you to completely different places. */
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new Error(
      timedOut
        ? "The WhatsApp service didn't answer within 8 seconds — it may be waking up."
        : `Couldn't connect to the WhatsApp service (${err instanceof Error ? err.message : "network error"})`,
    );
  }

  /* The service DID answer and said no. Which status it used is the entire
     diagnosis and used to be discarded: a 401 is a wrong API key in this
     deployment's environment variables, a 404 is a wrong URL, a 5xx is the
     service itself. Reported as one sentence somebody can act on rather than
     the flat "could not reach", which sent us looking at a service that was
     answering perfectly well in under half a second. */
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const hint =
      res.status === 401 || res.status === 403
        ? " — WHATSAPP_SERVICE_API_KEY doesn't match the service's own API_KEY"
        : res.status === 404
          ? " — check WHATSAPP_SERVICE_URL"
          : "";
    throw new Error(
      `The WhatsApp service refused the request (HTTP ${res.status})${hint}${
        detail ? `: ${detail.slice(0, 120)}` : ""
      }`,
    );
  }
  return res.json();
}

const validateCaller = (data: unknown): { callerIdToken: string } => {
  const d = data as Partial<{ callerIdToken: string }>;
  if (!d?.callerIdToken) throw new Error("Not authenticated");
  return { callerIdToken: d.callerIdToken };
};

export const getWhatsAppStatusServerFn = createServerFn({ method: "POST" })
  .validator(validateCaller)
  .handler(async ({ data }): Promise<WhatsAppStatus> => {
    await requireOwner(data.callerIdToken);
    return readBridge();
  });

/**
 * The same reading, for anyone who can send a bill — with the QR removed.
 *
 * A separate function rather than a softer guard on the one above, because
 * the QR is not a picture of a status: it IS a login. Whoever scans it holds
 * the shop's WhatsApp account, can read every conversation on it and can send
 * as the business. So it is dropped here, on the server, rather than merely
 * left unrendered — a field that never crosses the wire cannot be recovered
 * from a devtools network tab by a curious counter clerk.
 *
 * Named explicitly rather than spread-and-delete: if the service later grows
 * a second sensitive field, the default must be that it stays behind.
 */
export const getWhatsAppLinkStateServerFn = createServerFn({ method: "POST" })
  .validator(validateCaller)
  .handler(async ({ data }): Promise<WhatsAppLinkState> => {
    await requireActiveUser(data.callerIdToken);
    if (!process.env.WHATSAPP_SERVICE_URL || !process.env.WHATSAPP_SERVICE_API_KEY) {
      return { configured: false, reachable: false, status: "waiting", qrAvailable: false };
    }
    try {
      const body = await readBridge();
      return {
        configured: true,
        reachable: true,
        status: body.status,
        phone: body.phone,
        qrAvailable: body.status === "qr",
      };
    } catch (err) {
      return {
        configured: true,
        reachable: false,
        status: "waiting",
        qrAvailable: false,
        error: err instanceof Error ? err.message : "The WhatsApp service did not answer",
      };
    }
  });

export const disconnectWhatsAppServerFn = createServerFn({ method: "POST" })
  .validator(validateCaller)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requireOwner(data.callerIdToken);
    const { url, key } = serviceConfig();
    const res = await fetch(`${url}/disconnect`, {
      method: "POST",
      headers: { "x-api-key": key },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error("Could not disconnect WhatsApp");
    return res.json();
  });

/** Stored phone numbers are plain 10-digit local numbers (no country code) —
 * WhatsApp needs the full international number to route the message.
 * Assumes India (+91) since that's this business's own number/GSTIN; a
 * number that already looks international (11+ digits) is left as-is. */
function toInternational(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 10 ? `91${digits}` : digits;
}

/**
 * What the bridge says happened.
 *
 * `acknowledged` is the distinction that matters: the bridge hands a message
 * to WhatsApp's socket and could once report that as sent, which is how a bill
 * got a green tick at the counter while the customer's phone showed "Waiting
 * for this message". It now waits for WhatsApp's own server ack, and false
 * here means handed over but unconfirmed.
 *
 * `deduped` means this exact bill had already gone out and was NOT sent again
 * — which is the whole point of `clientMessageId`, and the thing that stops a
 * retry costing the customer a second invoice.
 */
export interface SendResult {
  ok: true;
  acknowledged: boolean;
  deduped: boolean;
}

type SendMessageInput = {
  callerIdToken: string;
  phone: string;
  message: string;
  pdfBase64: string;
  fileName: string;
  /** A stable id for this bill, so the service can tell a retry apart from a
   *  second bill. Optional: the service still accepts sends without one. */
  clientMessageId?: string;
};

export const sendWhatsAppMessageServerFn = createServerFn({ method: "POST" })
  .validator((data: unknown): SendMessageInput => {
    const d = data as Partial<SendMessageInput>;
    if (!d?.callerIdToken) throw new Error("Not authenticated");
    if (!d.phone?.trim()) throw new Error("This party has no phone number saved");
    if (!d.pdfBase64) throw new Error("pdfBase64 is required");
    return {
      callerIdToken: d.callerIdToken,
      phone: d.phone.trim(),
      message: d.message ?? "",
      pdfBase64: d.pdfBase64,
      fileName: d.fileName?.trim() || "document.pdf",
      clientMessageId: d.clientMessageId?.trim() || undefined,
    };
  })
  .handler(async ({ data }): Promise<SendResult> => {
    // Any active team member can send a bill/statement they can already
    // view — this isn't an owner-only action like managing the connection
    // itself (QR link/disconnect).
    await requireActiveUser(data.callerIdToken);
    const { url, key } = serviceConfig();
    let res: Response;
    try {
      res = await fetch(`${url}/send`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify({
          phone: toInternational(data.phone),
          message: data.message,
          pdfBase64: data.pdfBase64,
          fileName: data.fileName,
          clientMessageId: data.clientMessageId,
        }),
        /* Long, on purpose, and finite for the same reason: the bridge waits
           for WhatsApp's own acknowledgement before answering, which is what
           makes its answer worth having — but a bridge that accepts the
           connection and then never replies would otherwise hold the counter
           on a spinner for as long as the platform allows. */
        signal: AbortSignal.timeout(45_000),
      });
    } catch (err) {
      /* Nothing came back, so nothing here knows whether the message went.
         Said in those words deliberately: the outbox reads this sentence and
         must NOT file it as a safe-to-retry failure, because retrying a send
         that actually succeeded is how a customer gets two invoices. */
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new Error(
        timedOut
          ? "The WhatsApp service didn't answer in time — the message may or may not have been sent."
          : `Couldn't reach the WhatsApp service (${err instanceof Error ? err.message : "network error"})`,
      );
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || "Could not send WhatsApp message");
    }
    const body = (await res.json().catch(() => null)) as Partial<SendResult> | null;
    return {
      ok: true,
      // Absent on an older bridge that does not report either. Treated as
      // "cannot confirm" rather than "confirmed", so a stale deployment
      // understates delivery instead of overstating it.
      acknowledged: body?.acknowledged === true,
      deduped: body?.deduped === true,
    };
  });

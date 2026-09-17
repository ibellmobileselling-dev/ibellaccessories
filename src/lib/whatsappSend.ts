import { buildPrintableHtml } from "@/lib/pdf";
import { transmit, TransmitError } from "@/lib/whatsappTransmit";
import { useWhatsAppLinkStore } from "@/store/whatsappLink";
import { useOutboxStore } from "@/store/whatsappOutbox";
import { classifySendFailure, queuedMessage, type FailureKind } from "@/lib/outbox";

/**
 * What became of a send.
 *
 * Returned rather than thrown, because "queued" is not a failure and must not
 * read like one at the counter. A genuine fault — no phone number on the
 * party, a PDF that will not render — still throws, since nothing about that
 * improves by waiting and the person needs to fix it now.
 */
export type SendOutcome =
  | {
      status: "sent";
      /**
       * WhatsApp's own servers confirmed it, not merely that the bridge
       * handed it over. False is still a send — but the counter is told
       * "sending" rather than "sent", because a green tick over an
       * unconfirmed message is exactly what the shop reported as the app
       * lying to them.
       */
      acknowledged: boolean;
      /** It had already gone out; this attempt did not send a second copy. */
      deduped: boolean;
    }
  | { status: "queued"; kind: Exclude<FailureKind, "permanent">; message: string };

/**
 * Renders a printable DOM node to PDF and sends it as a WhatsApp document.
 *
 * The shared "Send WhatsApp" action behind both the invoice page and the party
 * statement page. When the link is down the bill is not lost: it goes into the
 * outbox and leaves on its own once WhatsApp is back.
 */
export async function sendElementViaWhatsApp(opts: {
  el: HTMLElement;
  phone: string | undefined;
  message: string;
  fileName: string;
  /** What the shop calls this — an invoice number, or a party's name. Shown
   *  in the outbox, where "document.pdf" would be no help to anyone. */
  label: string;
  orientation?: "portrait" | "landscape";
  /** For thermal-format bills (80mm/58mm) — see elementToPdfBase64. */
  pageWidthMm?: number;
}): Promise<SendOutcome> {
  /* Minted here, before the first attempt, and used both as the id the
     service dedupes on and as this row's id in the outbox. The two must be
     the same value: a retry that arrives under a fresh id is, as far as the
     service can tell, a different bill. */
  const clientMessageId = `wa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const printable = {
    // Captured before anything is attempted: the outbox stores this string,
    // and by the time a retry runs the page it came from is long gone.
    html: buildPrintableHtml(opts.el),
    clientMessageId,
    phone: opts.phone?.trim() ?? "",
    message: opts.message,
    fileName: opts.fileName,
    landscape: (opts.orientation ?? "landscape") === "landscape",
    pageWidthMm: opts.pageWidthMm,
  };

  // Read before the attempt, not after: a failed send drives the indicator
  // red, so asking afterwards would always answer "it was down" and every
  // uncertain failure would be misfiled as a safe one.
  const wasConnected = useWhatsAppLinkStore.getState().state === "connected";

  try {
    const { acknowledged, deduped } = await transmit(printable);
    return { status: "sent", acknowledged, deduped };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not send via WhatsApp";

    // Nothing reached WhatsApp and nothing will — this needs a person, not a
    // queue that will show them the same red row every day.
    if (err instanceof TransmitError && err.phase === "prepare") throw err;

    const kind = classifySendFailure(message, wasConnected);
    if (kind === "permanent") throw err;

    await useOutboxStore.getState().enqueue({
      id: clientMessageId,
      label: opts.label,
      ...printable,
      queuedAt: new Date().toISOString(),
      attempts: 1,
      lastAttemptAt: new Date().toISOString(),
      lastError: message,
      // Only a failure we can prove happened is allowed to retry itself. An
      // unexplained one on a live link may already have been delivered, and
      // a second copy of an invoice is the customer's problem to notice.
      auto: kind === "offline",
    });

    return { status: "queued", kind, message: queuedMessage(kind, opts.label) };
  }
}

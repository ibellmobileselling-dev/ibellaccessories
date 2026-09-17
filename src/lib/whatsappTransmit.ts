/**
 * The one place a WhatsApp document actually leaves the building.
 *
 * Both callers go through here — the button at the counter and the outbox
 * flushing something that failed earlier — so the PDF is rendered the same
 * way, the link indicator learns the outcome the same way, and neither path
 * can drift into a slightly different idea of what "sent" means.
 *
 * Separate from `whatsappSend` so the outbox can transmit without importing
 * the thing that fills the outbox.
 */

import { auth } from "@/lib/firebase";
import { renderPdfBase64ServerFn } from "@/lib/pdfServer";
import { sendWhatsAppMessageServerFn } from "@/lib/whatsappAdmin";
import { useWhatsAppLinkStore } from "@/store/whatsappLink";

/**
 * Which half of the job failed.
 *
 * The distinction decides whether a bill is worth queueing. A PDF that would
 * not render will not render any better in an hour, and nothing was offered to
 * WhatsApp — queueing it would put a row in front of the shop that can only
 * ever fail. Only a failure at the send step is about the link.
 */
export class TransmitError extends Error {
  constructor(
    message: string,
    readonly phase: "prepare" | "send",
  ) {
    super(message);
    this.name = "TransmitError";
  }
}

export interface Printable {
  html: string;
  phone: string;
  message: string;
  fileName: string;
  landscape: boolean;
  pageWidthMm?: number;
  /**
   * Stable across every attempt at this one bill.
   *
   * The service claims it before sending, so a retry of something that
   * already went out is answered rather than sent again. Without it, the one
   * failure nobody can classify — the message left, the reply did not come
   * back — costs the customer a second copy of their invoice.
   */
  clientMessageId?: string;
}

/**
 * What came back from a send that did not throw.
 *
 * `acknowledged: false` is not a failure — the bill was handed to WhatsApp —
 * but it is not the same as delivered, and saying "Sent" over it is the lie
 * the shop has been complaining about.
 */
export interface TransmitResult {
  acknowledged: boolean;
  deduped: boolean;
}

/** Renders and sends, or throws with a message worth showing someone. */
export async function transmit(p: Printable): Promise<TransmitResult> {
  const phone = p.phone?.trim();
  if (!phone) {
    throw new TransmitError(
      "This party has no phone number saved — add one to send via WhatsApp.",
      "prepare",
    );
  }
  const callerIdToken = await auth.currentUser?.getIdToken();
  if (!callerIdToken) throw new TransmitError("Not signed in", "prepare");

  let pdfBase64: string;
  try {
    ({ pdfBase64 } = await renderPdfBase64ServerFn({
      data: {
        callerIdToken,
        html: p.html,
        landscape: p.landscape,
        pageWidthMm: p.pageWidthMm,
      },
    }));
  } catch (err) {
    throw new TransmitError(
      err instanceof Error ? err.message : "Could not prepare the PDF",
      "prepare",
    );
  }

  /* Whatever happens next is the most reliable thing anyone will learn about
     this link all day. A polled status only proves the bridge process is
     running — it will answer "connected" from a host whose WhatsApp session
     died hours ago. A send that goes through proves the socket was alive a
     second ago, and one that fails proves it was not. */
  let result: { acknowledged: boolean; deduped: boolean };
  try {
    result = await sendWhatsAppMessageServerFn({
      data: {
        callerIdToken,
        phone,
        message: p.message,
        pdfBase64,
        fileName: p.fileName.toLowerCase().endsWith(".pdf") ? p.fileName : `${p.fileName}.pdf`,
        clientMessageId: p.clientMessageId,
      },
    });
  } catch (err) {
    useWhatsAppLinkStore.getState().noteSendResult(false);
    throw new TransmitError(
      err instanceof Error ? err.message : "Could not send WhatsApp message",
      "send",
    );
  }
  useWhatsAppLinkStore.getState().noteSendResult(true);
  return { acknowledged: result.acknowledged, deduped: result.deduped };
}

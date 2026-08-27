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

const validateCaller = (data: unknown): { callerIdToken: string } => {
  const d = data as Partial<{ callerIdToken: string }>;
  if (!d?.callerIdToken) throw new Error("Not authenticated");
  return { callerIdToken: d.callerIdToken };
};

export const getWhatsAppStatusServerFn = createServerFn({ method: "POST" })
  .validator(validateCaller)
  .handler(async ({ data }): Promise<WhatsAppStatus> => {
    await requireOwner(data.callerIdToken);
    const { url, key } = serviceConfig();
    const res = await fetch(`${url}/qr`, { headers: { "x-api-key": key } });
    if (!res.ok) throw new Error("Could not reach the WhatsApp service");
    return res.json();
  });

export const disconnectWhatsAppServerFn = createServerFn({ method: "POST" })
  .validator(validateCaller)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requireOwner(data.callerIdToken);
    const { url, key } = serviceConfig();
    const res = await fetch(`${url}/disconnect`, {
      method: "POST",
      headers: { "x-api-key": key },
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

type SendMessageInput = {
  callerIdToken: string;
  phone: string;
  message: string;
  pdfBase64: string;
  fileName: string;
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
    };
  })
  .handler(async ({ data }): Promise<{ ok: true }> => {
    // Any active team member can send a bill/statement they can already
    // view — this isn't an owner-only action like managing the connection
    // itself (QR link/disconnect).
    await requireActiveUser(data.callerIdToken);
    const { url, key } = serviceConfig();
    const res = await fetch(`${url}/send`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        phone: toInternational(data.phone),
        message: data.message,
        pdfBase64: data.pdfBase64,
        fileName: data.fileName,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || "Could not send WhatsApp message");
    }
    return { ok: true };
  });

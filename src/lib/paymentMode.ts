import type { PaymentMode } from "@/types";

/** Display names for payment modes. Lives here rather than beside the
 * ModePills component because most callers only ever want the label — a
 * component module that also exports helpers breaks React Fast Refresh for
 * everything that imports it. */
export const MODE_LABELS: Record<PaymentMode, string> = {
  cash: "Cash",
  upi: "UPI",
  bank: "Bank",
  cheque: "Cheque",
  credit: "Credit",
};

/** "upi" → "UPI", "cash" → "Cash" — for lists, documents, reports */
export const fmtMode = (m: string) => MODE_LABELS[m as PaymentMode] ?? m;

export const fmtMoney = (n: number, currency = "INR") => {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n || 0);
  } catch {
    return `₹${(n || 0).toFixed(2)}`;
  }
};

export const fmtDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
};
/** dd-mm-yy — for dense tables where "24 Aug 2026" costs a column that the
 *  Action buttons then get pushed off the edge for. Same order the rest of
 *  the app writes dates in, just narrower. */
export const fmtDateShort = (iso: string) => {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${String(d.getFullYear()).slice(2)}`;
  } catch {
    return iso;
  }
};

/** Local-timezone YYYY-MM-DD (toISOString is UTC and gives yesterday's date
 * before 5:30 AM in India — never use it for business dates). */
export const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const today = () => ymd(new Date());

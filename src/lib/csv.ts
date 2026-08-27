import { today } from "@/lib/format";

/** Parse RFC4180-ish CSV text into rows of string cells. Handles quoted
 * fields, embedded commas/newlines, escaped `""`, and a leading BOM. */
/** Pick the delimiter that appears most in the header line — Numbers and
 * European-locale Excel export semicolon-separated "CSV", and Excel's
 * "Text (Tab delimited)" uses tabs. Comma wins ties. */
function detectDelimiter(text: string): string {
  const idxN = text.indexOf("\n");
  const idxR = text.indexOf("\r");
  const cut = Math.min(idxN < 0 ? text.length : idxN, idxR < 0 ? text.length : idxR);
  const firstLine = text.slice(0, cut);
  let best = ",";
  let bestCount = firstLine.split(",").length - 1;
  for (const d of [";", "\t"]) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(text: string): string[][] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = detectDelimiter(clean);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && clean[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

/** A cell that's ENTIRELY a ₹-formatted amount (e.g. "₹1,234.56" or
 * "−₹1,234.56") gets unwrapped to a plain number string. Left as-is, Excel's
 * CSV importer auto-detects the ₹ symbol, converts the cell to its own
 * Currency format, and then shows "####" until the column is manually
 * widened — the data isn't wrong, but it looks broken on open. Cells with
 * extra text (e.g. a trailing " Dr"/" Cr" ledger suffix) don't match and are
 * left untouched, since those are meant to display as text anyway. */
function cleanMoneyCell(s: string): string {
  const t = s.replace(/[\u00A0\u202F]/g, " ").trim(); // NBSP (U+00A0) and narrow NBSP (U+202F), as escapes so they stay visible
  const m = t.match(/^([+\-−]?)\s*₹\s?([\d,]+(?:\.\d+)?)$/);
  if (!m) return s;
  const sign = m[1] === "−" || m[1] === "-" ? "-" : "";
  return `${sign}${m[2].replace(/,/g, "")}`;
}

function escapeCell(v: string): string {
  let cleaned = cleanMoneyCell(v);
  // Neutralize spreadsheet formula injection: Excel/Sheets execute a cell that
  // begins with = + - @ (or tab/CR) as a formula, so a user-entered party name
  // or note like `=HYPERLINK(...)` would run on whoever opens the export.
  // Prefix such a cell with a single quote to force text — but NOT a plain
  // number, so a negative amount like -50 stays numeric.
  if (/^[=+\-@\t\r]/.test(cleaned) && !/^[-+]?[\d,]*\.?\d+$/.test(cleaned)) {
    cleaned = `'${cleaned}`;
  }
  return /[",\n\r]/.test(cleaned) ? `"${cleaned.replace(/"/g, '""')}"` : cleaned;
}

/** Build CSV text from column headers and string rows. */
export function toCsv(cols: string[], rows: string[][]): string {
  return "﻿" + [cols, ...rows].map((r) => r.map(escapeCell).join(",")).join("\r\n");
}

/** Trigger a browser download of the given rows as a CSV file. */
export function downloadCsv(filename: string, cols: string[], rows: string[][]) {
  const csv = toCsv(cols, rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename.toLowerCase().replace(/\s+/g, "-")}-${today()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

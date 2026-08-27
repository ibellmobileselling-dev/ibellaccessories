import { parseCsv } from "@/lib/csv";

/** Normalize a header cell for alias matching: lowercase, strip everything
 * that isn't a letter or digit (so "Opening Stock", "opening_stock" and
 * "OPENING STOCK" all collapse to "openingstock"). */
export function normalizeHeader(h: string): string {
  return String(h)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Read a parsed .xlsx workbook into a string table, defending against two
 * real-world quirks that made a filled template import as "No valid rows":
 *  1) A truncated `!ref` used-range — WPS Office (and some re-saved Excel
 *     files) write a range covering only the header row, so sheet_to_json
 *     silently drops every data row. We recompute the range from the actual
 *     cell addresses so all rows survive.
 *  2) Data on a non-first sheet, or an empty sheet ordered first — we scan
 *     every sheet and keep the largest one that has a "Name" header
 *     (falling back to the largest overall). */
type XlsxModule = typeof import("xlsx");
type Workbook = ReturnType<XlsxModule["read"]>;

function workbookToTable(XLSX: XlsxModule, wb: Workbook): string[][] {
  let best: string[][] = [];
  let bestNamed: string[][] = [];
  for (const name of wb.SheetNames as string[]) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    let minR = Infinity,
      minC = Infinity,
      maxR = -1,
      maxC = -1;
    for (const k of Object.keys(sheet)) {
      if (k[0] === "!") continue;
      const cell = XLSX.utils.decode_cell(k);
      if (cell.r < minR) minR = cell.r;
      if (cell.c < minC) minC = cell.c;
      if (cell.r > maxR) maxR = cell.r;
      if (cell.c > maxC) maxC = cell.c;
    }
    if (maxR >= 0) {
      sheet["!ref"] = XLSX.utils.encode_range({ s: { r: minR, c: minC }, e: { r: maxR, c: maxC } });
    }
    const t = (
      XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as unknown[][]
    ).map((row) => (Array.isArray(row) ? row.map((c) => String(c ?? "")) : []));
    if (t.length > best.length) best = t;
    const hdr = (t[0] ?? []).map(normalizeHeader);
    if (hdr.some((h) => h === "name" || h === "itemname") && t.length > bestNamed.length) {
      bestNamed = t;
    }
  }
  return bestNamed.length ? bestNamed : best;
}

/** Parse a chosen bulk-import file into a raw string table (first row =
 * headers). Handles real Excel workbooks (.xlsx/.xls, incl. WPS Office and
 * its truncated-range quirk) and CSV — including Excel's UTF-16 "Unicode
 * Text" export, which decoded as UTF-8 turns every row into garbage. Shared
 * by item AND party bulk import so both handle the same file shapes
 * identically. */
export async function parseImportFile(file: File): Promise<string[][]> {
  const buf = await file.arrayBuffer();
  const isExcel = /\.(xlsx|xls)$/i.test(file.name);
  if (isExcel) {
    // Loaded on demand — xlsx is ~400KB and only import/export flows need it.
    const XLSX = await import("xlsx");
    const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
    return workbookToTable(XLSX, wb);
  }
  const b = new Uint8Array(buf);
  const text =
    b[0] === 0xff && b[1] === 0xfe
      ? new TextDecoder("utf-16le").decode(buf)
      : b[0] === 0xfe && b[1] === 0xff
        ? new TextDecoder("utf-16be").decode(buf)
        : new TextDecoder("utf-8").decode(buf);
  return parseCsv(text);
}

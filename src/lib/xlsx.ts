export interface XlsxSheet {
  name: string;
  rows: (string | number)[][];
}

/** Excel sheet names must be ≤31 chars, unique, and can't contain : \ / ? * [ ] */
function safeSheetName(name: string, used: Set<string>): string {
  const base =
    name
      .replace(/[:\\/?*[\]]/g, " ")
      .trim()
      .slice(0, 31) || "Sheet";
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${n})`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    n++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Download a multi-sheet .xlsx workbook — one array-of-arrays sheet per entry.
 * Used for "one sheet per party" ledger exports, where a flat CSV can't
 * express separate sheets at all. */
/** Auto-fit column widths from content — default widths truncate every
 * header ("Receivable Bal…" showing as "Receivabl") and look unfinished. */
function autoColumnWidths(rows: (string | number)[][]): { wch: number }[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      const len = String(cell ?? "").length;
      if (len > (widths[i] ?? 0)) widths[i] = len;
    });
  }
  return widths.map((w) => ({ wch: Math.min(42, Math.max(9, w + 2)) }));
}

export async function downloadXlsx(filename: string, sheets: XlsxSheet[]) {
  // Loaded on demand, not at module scope — xlsx is a ~400KB library that
  // only export flows need, and eagerly bundling it would slow down the
  // first load of every page that happens to import this module.
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.rows);
    ws["!cols"] = autoColumnWidths(s.rows);
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(s.name, used));
  }
  XLSX.writeFile(wb, `${filename.toLowerCase().replace(/\s+/g, "-")}.xlsx`);
}

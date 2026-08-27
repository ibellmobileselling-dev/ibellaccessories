import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { SelectMenu } from "@/components/SelectMenu";

// Reaches past the 500 default in both directions: a shopkeeper who wants
// the whole catalogue on one page can have it, and one who works on a
// phone can drop to 25. Whatever they pick is remembered per screen.
const PAGE_SIZES = [25, 50, 100, 250, 500, 1000];

function pageList(page: number, totalPages: number): (number | "…")[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const wanted = new Set([1, totalPages, page - 1, page, page + 1]);
  const nums = [...wanted].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  let prev = 0;
  for (const n of nums) {
    if (n - prev > 1) out.push("…");
    out.push(n);
    prev = n;
  }
  return out;
}

export function PaginationBar({
  page,
  totalPages,
  pageSize,
  total,
  onPage,
  onPageSize,
}: {
  page: number;
  totalPages: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  onPageSize: (s: number) => void;
}) {
  if (total === 0) return null; // nothing at all to report

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const fmt = (n: number) => new Intl.NumberFormat("en-IN").format(n);

  const btn =
    "h-7 min-w-7 px-1.5 inline-flex items-center justify-center rounded-md border border-gray-200 bg-white text-[12px] text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition";

  const navBtn =
    "h-9 px-4 inline-flex items-center justify-center gap-1 rounded-md border border-gray-200 bg-white text-[13px] font-semibold text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed active:bg-gray-100 transition";

  return (
    <div className="border-t bg-white shrink-0">
      {/* Mobile: big, thumb-friendly Prev/Next — numbered pages and the
          per-page selector are a desktop-mouse pattern, not a phone one. */}
      <div className="flex md:hidden items-center justify-between px-3 py-2.5 gap-2">
        <button className={navBtn} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="h-4 w-4" /> Prev
        </button>
        <span className="text-[12px] text-gray-500 tabular-nums">
          Page <span className="font-semibold text-gray-700">{page}</span> of{" "}
          <span className="font-semibold text-gray-700">{totalPages}</span>
          <span className="block text-center text-[11px] text-gray-400">
            {fmt(from)}–{fmt(to)} of {fmt(total)}
          </span>
        </span>
        <button className={navBtn} disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          Next <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Desktop: full pagination with numbered pages + per-page selector */}
      <div className="hidden md:flex px-4 py-2 flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-gray-500 tabular-nums">
            Showing{" "}
            <span className="font-semibold text-gray-700">
              {fmt(from)}–{fmt(to)}
            </span>{" "}
            of <span className="font-semibold text-gray-700">{fmt(total)}</span>
          </span>
          <label className="flex items-center gap-1.5 text-[12px] text-gray-500">
            Per page
            {/* Not a native <select>: this bar sits at the bottom of the
                screen, so the OS popup opened over the page in its own grey
                and blue. SelectMenu matches the app and flips upward when
                there is no room below. */}
            <SelectMenu
              value={pageSize}
              options={PAGE_SIZES.map((n) => ({ value: n, label: String(n) }))}
              onChange={onPageSize}
              ariaLabel="Rows per page"
              className="h-7 px-2 text-[12px] text-gray-700"
            />
          </label>
        </div>

        <div className="flex items-center gap-1">
          <button className={btn} disabled={page <= 1} onClick={() => onPage(1)} title="First page">
            <ChevronsLeft className="h-3.5 w-3.5" />
          </button>
          <button
            className={btn}
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
            title="Previous page"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          {pageList(page, totalPages).map((p, i) =>
            p === "…" ? (
              <span key={`e${i}`} className="px-1 text-[12px] text-gray-400">
                …
              </span>
            ) : (
              <button
                key={p}
                onClick={() => onPage(p)}
                className={`${btn} tabular-nums ${p === page ? "!bg-primary !text-primary-foreground !border-primary font-semibold" : ""}`}
              >
                {p}
              </button>
            ),
          )}
          <button
            className={btn}
            disabled={page >= totalPages}
            onClick={() => onPage(page + 1)}
            title="Next page"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button
            className={btn}
            disabled={page >= totalPages}
            onClick={() => onPage(totalPages)}
            title="Last page"
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

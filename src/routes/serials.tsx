import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAutoFocusOnDesktop } from "@/hooks/use-mobile";
import { useRepoMemo } from "@/hooks/useRepoData";
import { ItemRepo, SerialRepo } from "@/repositories";
import type { Serial } from "@/types";
import {
  lookupSerials,
  warrantyState,
  vendorClaimState,
  SERIAL_STATUS_LABEL,
  SERIAL_PARTIAL_MIN,
  SERIAL_MATCH_LIMIT,
  type WarrantyTone,
} from "@/lib/serials";
import { fmtMoney, fmtDate, today } from "@/lib/format";
import { ScanLine, Search, ShieldCheck, Truck, ShoppingCart, X } from "lucide-react";

export const Route = createFileRoute("/serials")({ component: SerialLookupPage });

/**
 * "Is this one still under warranty?"
 *
 * The counter's screen, not the accountant's. Somebody is standing there
 * holding an adapter, and the shop has seconds to answer three questions: is
 * it ours, is it still covered, and can we still claim it back from the
 * vendor. Everything here is arranged around answering those out loud —
 * which is why the warranty line is the largest thing on each result and the
 * money is the smallest.
 */
function SerialLookupPage() {
  const boxRef = useRef<HTMLInputElement>(null);
  useAutoFocusOnDesktop(boxRef);
  // Typed, not committed: a barcode scanner types the whole serial and then
  // presses Enter, so searching per keystroke would run a dozen useless
  // partial searches and flash answers that are about to be wrong.
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");

  const now = today();
  // useRepoMemo, not useMemo: another till selling this very unit has to
  // change the answer on this screen, because the person is still standing at
  // the counter waiting to hear it.
  const result = useRepoMemo(() => lookupSerials(query, SerialRepo.all()), [query]);

  const search = () => setQuery(typed);
  const clear = () => {
    setTyped("");
    setQuery("");
    boxRef.current?.focus();
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Serial Lookup"
        subtitle="Scan or type a serial number to see where a unit came from, where it went, and whether it is still under warranty"
        icon={<ScanLine className="h-5 w-5" />}
      />

      <div className="rounded-lg border bg-card p-4">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={boxRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  search();
                }
                if (e.key === "Escape") clear();
              }}
              placeholder="Scan the unit, or type the last few characters…"
              className="h-12 pl-9 font-mono text-base tracking-wider"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <Button onClick={search} className="h-12 px-6">
            Look up
          </Button>
          {(typed || query) && (
            <Button variant="outline" onClick={clear} className="h-12" title="Clear (Esc)">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          The whole serial finds the exact unit. {SERIAL_PARTIAL_MIN} characters or more from the
          end finds every unit ending that way — useful when a customer is reading it out.
        </p>
      </div>

      {query && <Results result={result} now={now} />}

      {!query && (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          Nothing looked up yet. Scan a unit to begin.
        </div>
      )}
    </div>
  );
}

function Results({ result, now }: { result: ReturnType<typeof lookupSerials>; now: string }) {
  if (!result.hits.length) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="font-medium">No unit matches “{result.query}”</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {result.query.length < SERIAL_PARTIAL_MIN
            ? `Type at least ${SERIAL_PARTIAL_MIN} characters — fewer would match half the shelf.`
            : "This unit was never received here, or the purchase that brought it in was cancelled."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {result.partial && (
        <p className="text-sm text-muted-foreground">
          No exact match. Showing {result.hits.length} unit
          {result.hits.length === 1 ? "" : "s"} ending in{" "}
          <span className="font-mono font-medium">{result.query}</span>
          {result.truncated && ` — more than ${SERIAL_MATCH_LIMIT} matched, so type more of it`}.
        </p>
      )}
      {/* An exact serial matching two items is not an error to hide: two
          makers can legitimately stamp the same string, and the counter has
          to be the one who decides which adapter they are holding. */}
      {!result.partial && result.hits.length > 1 && (
        <p className="text-sm text-warning">
          {result.hits.length} different items carry this serial number — check which one this is.
        </p>
      )}
      {result.hits.map((s) => (
        <SerialCard key={s.id} serial={s} now={now} />
      ))}
    </div>
  );
}

const TONE_TEXT: Record<WarrantyTone, string> = {
  ok: "text-success",
  expiring: "text-warning",
  expired: "text-destructive",
  none: "text-muted-foreground",
};

function SerialCard({ serial: s, now }: { serial: Serial; now: string }) {
  const item = ItemRepo.get(s.itemId);
  const w = warrantyState(s, now);
  const v = vendorClaimState(s, now);

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b p-4">
        <div>
          <div className="font-mono text-lg font-semibold tracking-wider">{s.serial}</div>
          <div className="text-sm text-muted-foreground">
            {item ? (
              <Link to="/items/$id" params={{ id: s.itemId }} className="hover:underline">
                {item.name}
              </Link>
            ) : (
              "Item no longer in the list"
            )}
          </div>
        </div>
        <span className="rounded-md border px-2.5 py-0.5 text-xs font-semibold">
          {SERIAL_STATUS_LABEL[s.status]}
        </span>
      </div>

      {/* The answer the person at the counter came for, said in the largest
          type on the card, because it is the one thing that will be read out
          loud and the one thing that must not be misread. */}
      <div className="border-b p-4">
        <div className={`flex items-center gap-2 text-base font-semibold ${TONE_TEXT[w.tone]}`}>
          <ShieldCheck className="h-5 w-5 shrink-0" />
          {w.label}
        </div>
        {w.end && (
          <div className="mt-0.5 pl-7 text-sm text-muted-foreground">
            Customer warranty runs to {fmtDate(w.end)}
            {s.warrantyMonths ? ` (${s.warrantyMonths} months from sale)` : ""}
          </div>
        )}
        {/* Kept beside the customer's warranty rather than buried, because
            this is the half that quietly costs money: a unit fails, the shop
            replaces it, and nobody checks whether the vendor would still
            have taken it back. */}
        <div className={`mt-2 flex items-center gap-2 text-sm ${TONE_TEXT[v.tone]}`}>
          <Truck className="h-4 w-4 shrink-0" />
          {v.label}
          {v.end && <span className="text-muted-foreground">· to {fmtDate(v.end)}</span>}
        </div>
      </div>

      <div className="grid gap-4 p-4 sm:grid-cols-2">
        <Provenance
          icon={<Truck className="h-4 w-4" />}
          title="Came in on"
          empty="No purchase recorded — this unit predates serial tracking"
          shown={!!s.purchaseId}
        >
          <Link
            to="/purchase/$id"
            params={{ id: s.purchaseId ?? "" }}
            className="font-medium hover:underline"
          >
            {s.vendorName || "Purchase"}
          </Link>
          {s.purchaseDate && <div className="text-muted-foreground">{fmtDate(s.purchaseDate)}</div>}
          {s.cost !== undefined && (
            <div className="text-muted-foreground">Cost {fmtMoney(s.cost)}</div>
          )}
        </Provenance>

        <Provenance
          icon={<ShoppingCart className="h-4 w-4" />}
          title="Went out on"
          empty="Still on the shelf"
          shown={!!s.saleId}
        >
          <Link
            to="/sales/$id"
            params={{ id: s.saleId ?? "" }}
            className="font-medium hover:underline"
          >
            {s.customerName || "Sale"}
          </Link>
          {s.saleDate && <div className="text-muted-foreground">{fmtDate(s.saleDate)}</div>}
        </Provenance>
      </div>
    </div>
  );
}

function Provenance({
  icon,
  title,
  empty,
  shown,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  empty: string;
  shown: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="text-sm">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </div>
      {shown ? children : <div className="text-muted-foreground">{empty}</div>}
    </div>
  );
}

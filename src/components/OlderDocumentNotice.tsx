/**
 * Shown instead of an edit form when the document is from an earlier day.
 *
 * Phase 4 stopped older documents being deleted; this closes the other half
 * of the same door. Changing the total on a three-month-old invoice makes
 * that month a different month — the exact outcome voiding exists to prevent,
 * except an edit leaves no record at all that anything happened.
 *
 * It says what to do instead, because a screen that only refuses is a screen
 * people find a way around.
 */

import { useNavigate } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { fmtDate } from "@/lib/format";
import { Button } from "@/components/ui/button";

export function OlderDocumentNotice({
  what,
  name,
  date,
  backTo,
  backLabel,
}: {
  /** "invoice", "bill" — the word the shop uses for this document. */
  what: string;
  /** Its number, if it has one. */
  name?: string;
  date: string;
  backTo: string;
  backLabel: string;
}) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col h-full items-center justify-center p-6">
      <div className="max-w-md w-full bg-white border rounded-lg shadow-sm overflow-hidden">
        <div className="px-5 py-4 flex items-start gap-3 border-b bg-amber-50 border-amber-200">
          <Lock className="h-4 w-4 text-amber-700 mt-0.5 shrink-0" />
          <div>
            <p className="text-[14px] font-bold text-amber-900">
              {name ? `${name} ` : ""}can no longer be changed
            </p>
            <p className="text-[12px] text-amber-800 mt-0.5">
              Dated {fmtDate(date)} — an earlier day, so its month has already been counted.
            </p>
          </div>
        </div>
        <div className="px-5 py-4 space-y-2.5">
          <p className="text-[13px] text-gray-700">
            Editing it would change that month with nothing on any screen saying so. To correct it,
            <strong> void this {what} and issue a new one</strong>. Both stay on record, and the
            books show what happened and what replaced it.
          </p>
          <p className="text-[12px] text-gray-500">
            Today&rsquo;s {what}s can still be edited freely — nothing has been counted yet.
          </p>
          <div className="pt-1">
            <Button size="sm" onClick={() => navigate({ to: backTo })}>
              ← {backLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

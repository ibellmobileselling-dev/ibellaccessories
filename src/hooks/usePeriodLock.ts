import { toast } from "sonner";
import { CompanyRepo } from "@/repositories";
import { blockedDate, lockMessage } from "@/lib/periodLock";

/**
 * The one place a screen asks "may I change this?".
 *
 * A hook rather than a bare function so the check reads the company settings
 * through the same reactive store as everything else — an owner closing the
 * period in Settings takes effect in an already-open billing tab, without a
 * reload.
 *
 * Pass every date the change touches: for an edit that is the record's current
 * date AND its new one, because moving a bill out of a closed month changes
 * that month too.
 */
export function usePeriodLock() {
  const lockedUpto = CompanyRepo.get().booksLockedUpto;

  /** Returns true when the change may go ahead. Says why when it may not. */
  const canPost = (...dates: (string | undefined)[]): boolean => {
    const bad = blockedDate(dates, lockedUpto);
    if (!bad) return true;
    toast.error(lockMessage(bad, lockedUpto!));
    return false;
  };

  return { lockedUpto, canPost };
}

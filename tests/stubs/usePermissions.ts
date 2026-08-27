/**
 * Test stub for src/hooks/usePermissions.
 *
 * The real hook reads the signed-in user's teamUsers doc, which only exists
 * behind a live Firebase session. Screens need *some* answer, and owner-only
 * sections (Settings → Team, WhatsApp, Bank Reconciliation) are invisible
 * without one — so the test drives it through a global it can flip, letting
 * the same page be asserted from both sides of the permission gate.
 */
import type { ModuleKey } from "@/types";

declare global {
  var __TEST_IS_OWNER__: boolean | undefined;
}

export function usePermissions() {
  const isOwner = globalThis.__TEST_IS_OWNER__ === true;
  const yes = (_module: ModuleKey) => true;
  return {
    me: {
      id: "test-uid",
      email: "test@example.com",
      name: "Test",
      isOwner,
      active: true,
      permissions: {},
      createdAt: "2026-01-01T00:00:00Z",
    },
    isOwner,
    canView: yes,
    canEdit: yes,
    canDelete: yes,
  };
}

import { createServerFn } from "@tanstack/react-start";
import { getAdminAuth, getAdminDb, requireOwner } from "@/lib/firebaseAdmin";
import type { ModuleKey, ModulePermission } from "@/types";

type CreateTeamUserInput = {
  /** The CALLER's own Firebase ID token (await auth.currentUser.getIdToken()),
   * not the new user's — this is how the server independently verifies the
   * caller is really the owner, rather than trusting a client-side clIBELL.
   * A server endpoint is reachable directly over the network regardless of
   * what the UI hides, so this check has to happen here, not in the browser. */
  callerIdToken: string;
  email: string;
  password: string;
  name: string;
  permissions: Partial<Record<ModuleKey, ModulePermission>>;
};

/**
 * Creates a new team member's login + permissions doc, entirely server-side.
 * Client-side createUserWithEmailAndPassword would sign in as the NEW user
 * in the owner's own browser tab, kicking the owner out of their own
 * session — Admin SDK creation avoids that entirely, since it never touches
 * any browser's auth state.
 */
export const createTeamUserServerFn = createServerFn({ method: "POST" })
  .validator((data: unknown): CreateTeamUserInput => {
    const d = data as Partial<CreateTeamUserInput>;
    if (!d?.callerIdToken) throw new Error("Not authenticated");
    if (!d.email?.trim()) throw new Error("Email is required");
    if (!d.password || d.password.length < 6)
      throw new Error("Password must be at least 6 characters");
    if (!d.name?.trim()) throw new Error("Name is required");
    return {
      callerIdToken: d.callerIdToken,
      email: d.email.trim(),
      password: d.password,
      name: d.name.trim(),
      permissions: d.permissions ?? {},
    };
  })
  .handler(async ({ data }) => {
    await requireOwner(data.callerIdToken);
    const auth = await getAdminAuth();
    const db = await getAdminDb();

    const userRecord = await auth.createUser({
      email: data.email,
      password: data.password,
      displayName: data.name,
    });

    // Admin SDK writes bypass Firestore rules by design — this is the one
    // trusted path allowed to create a non-owner teamUsers doc; every
    // other creation attempt is rejected by firestore.rules.
    await db.doc(`teamUsers/${userRecord.uid}`).set({
      id: userRecord.uid,
      email: data.email,
      name: data.name,
      isOwner: false,
      active: true,
      permissions: data.permissions,
      createdAt: new Date().toISOString(),
    });

    return { uid: userRecord.uid };
  });

type DeleteTeamUserInput = { callerIdToken: string; targetUid: string };

/**
 * Permanently removes a team member's login, not just their access. Deleting
 * only the Firestore doc (a plain client-side write) would leave the Firebase
 * Auth account itself intact — they could still sign in, just with no
 * permissions doc — so this has to go through the Admin SDK too, same as
 * creation. Deactivating (TeamUserRepo.update active:false) stays the normal,
 * reversible way to remove access; this is for when the account itself
 * should stop existing.
 */
export const deleteTeamUserServerFn = createServerFn({ method: "POST" })
  .validator((data: unknown): DeleteTeamUserInput => {
    const d = data as Partial<DeleteTeamUserInput>;
    if (!d?.callerIdToken) throw new Error("Not authenticated");
    if (!d.targetUid?.trim()) throw new Error("targetUid is required");
    return { callerIdToken: d.callerIdToken, targetUid: d.targetUid.trim() };
  })
  .handler(async ({ data }) => {
    await requireOwner(data.callerIdToken);
    const auth = await getAdminAuth();
    const db = await getAdminDb();

    const targetDoc = await db.doc(`teamUsers/${data.targetUid}`).get();
    const target = targetDoc.data();
    if (target?.isOwner) {
      throw new Error("The owner account can't be deleted.");
    }

    await auth.deleteUser(data.targetUid);
    await db.doc(`teamUsers/${data.targetUid}`).delete();

    return { ok: true };
  });

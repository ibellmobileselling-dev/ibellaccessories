/**
 * Shared Firebase Admin SDK access for server functions (Team management,
 * WhatsApp connection). Everything here is memoized module-level state —
 * NOT per-call — because Firestore's db.settings() can only be called once
 * ever on a given instance ("Firestore has already been initialized" if
 * called twice), and admin.initializeApp() throws if called twice too. Two
 * separate files each doing their own lazy-init independently WILL collide
 * on the second call, since admin.firestore(app) returns the same singleton
 * for a given app regardless of which file asks for it.
 */

/** Same named Firestore database the client SDK uses — see DATABASE_ID in
 * src/lib/firebase.ts. Must match exactly, or Admin SDK writes would land in
 * the wrong (default) database where the app never looks.
 *
 * Read from the SAME environment variable the client build reads, for that
 * reason: two variables would be two things to set, and setting one of them
 * would put the server and the browser in different databases — which fails
 * silently, because each half works perfectly on its own. */
const DATABASE_ID =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_FIRESTORE_DB) ||
  process.env.VITE_FIRESTORE_DB ||
  "kinteshmobileacce";

let appPromise: Promise<import("firebase-admin").app.App> | null = null;

/** Requires the Admin SDK service-account key, supplied via the
 * FIREBASE_SERVICE_ACCOUNT_KEY env var (the full JSON from Firebase Console
 * → Project Settings → Service Accounts → Generate new private key, as a
 * single-line string) — a secret only the business owner can generate, and
 * must never be committed to the repo. */
async function getAdminApp() {
  if (!appPromise) {
    appPromise = (async () => {
      // Node's ESM interop for this CJS package only exposes a `default`
      // export (admin.apps is undefined on the namespace object itself) —
      // using `admin` directly throws "Cannot read properties of undefined
      // (reading 'length')".
      const admin = (await import("firebase-admin")).default;
      if (admin.apps.length) return admin.app();

      const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      if (!raw) {
        throw new Error(
          "FIREBASE_SERVICE_ACCOUNT_KEY is not set — add the Firebase Admin SDK service " +
            "account JSON (Project Settings → Service Accounts → Generate new private key) " +
            "as an environment variable first.",
        );
      }
      const serviceAccount = JSON.parse(raw);
      return admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    })();
  }
  return appPromise;
}

let dbPromise: Promise<FirebaseFirestore.Firestore> | null = null;

/** The Admin SDK Firestore instance, with databaseId set exactly once. */
export async function getAdminDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const admin = (await import("firebase-admin")).default;
      const app = await getAdminApp();
      const db = admin.firestore(app);
      try {
        // preferRest is required on Vercel — the Admin SDK's default gRPC
        // transport (google-gax/@grpc/grpc-js) doesn't survive Vite/Nitro's
        // serverless bundling and throws "this._gaxModule.GrpcClient is not
        // a constructor" at runtime. Plain HTTP has no such bundling
        // dependency, and works identically for the low read/write volume
        // here.
        db.settings({ databaseId: DATABASE_ID, preferRest: true });
      } catch (err) {
        // On Vercel, each server function (Team vs. WhatsApp) is very
        // likely its own separate serverless bundle — each gets its OWN
        // copy of this module, and thus its own dbPromise, even though
        // admin.firestore(app) returns the SAME underlying client
        // (firebase-admin itself is one real shared package). So a
        // DIFFERENT bundle may have already called settings() on this exact
        // object before this one ever ran — that's not a bug, just means
        // it's already configured the way we want, so it's safe to ignore.
        // Anything else is a real error and must still surface.
        const already = err instanceof Error && /already.*initialized/i.test(err.message);
        if (!already) throw err;
      }
      return db;
    })();
  }
  return dbPromise;
}

export async function getAdminAuth() {
  const admin = (await import("firebase-admin")).default;
  const app = await getAdminApp();
  return admin.auth(app);
}

/** Independently verifies the caller is the active owner — every server
 * function here is a real HTTP endpoint reachable directly, so this can't
 * rely on the Settings page only showing owner-only cards client-side. */
export async function requireOwner(callerIdToken: string): Promise<string> {
  const auth = await getAdminAuth();
  const decoded = await auth.verifyIdToken(callerIdToken);
  const db = await getAdminDb();
  const callerDoc = await db.doc(`teamUsers/${decoded.uid}`).get();
  const caller = callerDoc.data();
  if (!caller?.isOwner || caller.active !== true) {
    throw new Error("Only the business owner can do this.");
  }
  return decoded.uid;
}

/** Same independent-verification idea as requireOwner, but for actions any
 * active team member should be able to do (e.g. sending a bill they can
 * already see) — not just the owner. The owner always passes this too,
 * since isOwner accounts are also active. */
export async function requireActiveUser(callerIdToken: string): Promise<string> {
  const auth = await getAdminAuth();
  const decoded = await auth.verifyIdToken(callerIdToken);
  const db = await getAdminDb();
  const callerDoc = await db.doc(`teamUsers/${decoded.uid}`).get();
  const caller = callerDoc.data();
  if (!caller || caller.active !== true) {
    throw new Error("Your account isn't active — ask the business owner to check your access.");
  }
  return decoded.uid;
}

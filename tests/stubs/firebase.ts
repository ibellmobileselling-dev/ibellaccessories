/**
 * Test stub for src/lib/firebase.
 *
 * The screen tests must NEVER be able to reach the client's live Firestore,
 * so this replaces the real module entirely (see the esbuild --alias in
 * package.json). `isBrowser: false` is the important part: every Repository
 * write path checks it and, when false, updates only the in-memory cache —
 * exactly the behaviour we want for seeded fixture data. `db`/`auth` are
 * never dereferenced on that path, so dummies are enough.
 */
export const DATABASE_ID = "test-only-never-a-real-database";
export const PRODUCTION_DATABASE_ID = "kinteshmobileacce";
/** The harness is, by definition, never the shop's real books — which is what
 *  lets the screen tests assert the warning strip renders. */
export const isProductionData = false;
export const isBrowser = false;
export const db = {} as never;
// A signed-in user, so the audit stamps (createdBy/updatedBy) have something
// to record and the tests can check they are actually written.
export const auth = { currentUser: { email: "test@shop.local" } } as never;

/**
 * Test stub for src/lib/firebaseAdmin.
 *
 * The real module pulls in firebase-admin (and, through pdfServer, puppeteer
 * and node: builtins), none of which can be bundled for a browser — Vite
 * normally strips them from the client build via createServerFn, but the test
 * bundler has no such notion. Nothing in a screen render should ever call
 * these: they only run inside server functions, so reaching one is a bug and
 * throwing says so loudly.
 */
const serverOnly = (name: string) => () => {
  throw new Error(`firebaseAdmin.${name}() must never run during a screen render`);
};

export const getAdminDb = serverOnly("getAdminDb");
export const getAdminAuth = serverOnly("getAdminAuth");
export const requireOwner = serverOnly("requireOwner");
export const requireActiveUser = serverOnly("requireActiveUser");

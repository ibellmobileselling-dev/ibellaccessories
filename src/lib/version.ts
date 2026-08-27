/** The business name shown throughout the shell â€” sidebar, login, splash,
 * page title, logout prompt, backup messages. Defined ONCE here: the rename
 * away from "IBELL" was previously done in the sidebar only, leaving the login
 * page, the browser tab, the backup errors and the home-screen icon label
 * all still saying the old name. Keep public/manifest.webmanifest in step by
 * hand â€” a static JSON file can't import this. */
export const APP_NAME = "IBELL MOBILE";

/** Bump on every deploy â€” shown on the login page and Settings so we can
 * always tell which version a user is actually running. */
export const APP_VERSION = "19 Aug 2026 · v73";

/**
 * Builds the screen tests for the browser and runs them in headless Chrome.
 *
 * A browser (rather than jsdom) because Chrome is already required by the PDF
 * pipeline, so this adds no dependency — and because it runs the same engine
 * the client's shop actually uses.
 */
const esbuild = require("esbuild");
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

const OUT_DIR = path.resolve(__dirname, "../node_modules/.cache/screens");
const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** Two things a plain esbuild call can't express:
 *  - `@/lib/firebase` → the stub, so a test can never reach the live database.
 *  - CSS imports (`@/styles.css?url`) → nothing; the pages import a stylesheet
 *    URL that Vite understands and a bare bundler does not. */
const stubs = {
  name: "screen-test-stubs",
  setup(build) {
    build.onResolve({ filter: /^@\/lib\/firebase$/ }, () => ({
      path: path.resolve(__dirname, "stubs/firebase.ts"),
    }));
    // Server-only islands. Vite strips these from the client build via
    // createServerFn; a plain bundler follows them straight into
    // firebase-admin, puppeteer and node: builtins, none of which belong in
    // (or can even build for) a browser.
    build.onResolve({ filter: /^@\/lib\/firebaseAdmin$/ }, () => ({
      path: path.resolve(__dirname, "stubs/firebaseAdmin.ts"),
    }));
    build.onResolve({ filter: /^@\/hooks\/usePermissions$/ }, () => ({
      path: path.resolve(__dirname, "stubs/usePermissions.ts"),
    }));
    build.onResolve(
      { filter: /^(puppeteer-core|@sparticuz\/chromium|firebase-admin(\/.*)?|node:.*)$/ },
      (args) => ({ path: args.path, namespace: "empty-module" }),
    );
    build.onLoad({ filter: /.*/, namespace: "empty-module" }, () => ({
      contents: [
        "export default {};",
        "export const existsSync = () => false;",
        // TanStack's SSR storage context imports this even on the client path.
        "export class AsyncLocalStorage {",
        "  getStore() { return undefined; }",
        "  run(_s, fn) { return fn(); }",
        "}",
      ].join("\n"),
      loader: "js",
    }));
    build.onResolve({ filter: /\.css(\?\S*)?$/ }, (args) => ({
      path: args.path,
      namespace: "empty-css",
    }));
    build.onLoad({ filter: /.*/, namespace: "empty-css" }, () => ({
      contents: 'export default "/test.css";',
      loader: "js",
    }));
  },
};

/**
 * PERIOD-LOCK COVERAGE — a source check, not a behaviour test.
 *
 * A partial lock is worse than none, because it looks complete: the owner
 * closes July, and one screen quietly keeps writing into it. Behaviour tests
 * can only cover the screens somebody thought to test, and the failure mode
 * here is forgetting a screen — so this asserts the shape of the code instead.
 *
 * Any module that writes a DATED business document must also ask the lock.
 * Add a new write path without a guard and this fails by name, on the next
 * run, before it reaches anyone's books.
 */
/**
 * Every screen that destroys a transaction document must also be able to
 * cancel one.
 *
 * A source check rather than a rendered one, for the same reason the period
 * lock has one: a path that quietly kept hard-deleting would pass every
 * screen test in this file — nothing would fail, a document would simply
 * cease to exist and the month it was in would become a different month.
 * There is no assertion that catches an absence spread across seven screens;
 * there is only this.
 */
function checkVoidCoverage() {
  const DESTROYS =
    /(Sales|Purchase|SaleReturn|PurchaseReturn|Payment|Expense|CashAdjustment|BankTxn)Repo[.]remove(Batched)?\s*\(/;
  const EXEMPT = new Set([
    // Writes both legs of a transfer as one edit: it removes the OLD pair and
    // writes a new one in the same batch, which is a rewrite of a document
    // the user is actively editing, not a correction to a filed one. The
    // Cash screen owns cancelling a transfer, and does.
    "src/components/CashBankTransferDialog.tsx",
  ]);
  const offenders = [];
  for (const root of ["src/components", "src/routes"]) {
    const dir = path.resolve(__dirname, "..", root);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".tsx") && !name.endsWith(".ts")) continue;
      const rel = `${root}/${name}`;
      if (EXEMPT.has(rel)) continue;
      const src = fs.readFileSync(path.join(dir, name), "utf8");
      // The CALL, not the name — the same lesson the lock check learned.
      if (DESTROYS.test(src) && !/\bvoidBatched\s*\(/.test(src)) offenders.push(rel);
    }
  }
  if (offenders.length) {
    console.log("\n  APPEND-ONLY: these destroy a transaction but never offer to cancel one:");
    offenders.forEach((f) => console.log("    x " + f));
    console.log("  A document that has been counted must survive being corrected.\n");
    return false;
  }
  console.log("  Append-only: every path that destroys a document can cancel one instead.");
  return true;
}

/**
 * A backup that drops cancelled documents restores a shop where voided bills
 * have come back to life — and the ledger's reversals with them.
 */
function checkBackupKeepsVoided() {
  const src = fs.readFileSync(path.resolve(__dirname, "../src/routes/settings.tsx"), "utf8");
  if (/dump\[key\]\s*=\s*JSON\.stringify\(repo\.allWithVoided\(\)\)/.test(src)) {
    console.log("  Backups include cancelled documents.");
    return true;
  }
  console.log("\n  BACKUP: the export does not include cancelled documents — a restore would");
  console.log("  bring voided bills back to life.\n");
  return false;
}

/**
 * The test-data warning has to be MOUNTED, not merely written.
 *
 * The screen harness replaces the real root component with a bare Outlet, so
 * a rendered test can prove the strip looks right and can never prove it is
 * on the page. A deployment pointed at the wrong database with no warning on
 * screen is the failure that costs the shop a day's takings, so the wiring is
 * checked here instead.
 */
function checkTestBannerMounted() {
  const src = fs.readFileSync(path.resolve(__dirname, "../src/routes/__root.tsx"), "utf8");
  const mounted = /<TestDataBanner\s*\/>/.test(src);
  // And production must be the fallback, so a deployment that forgets its
  // configuration lands on the shop's own books rather than on a stranger's.
  const fb = fs.readFileSync(path.resolve(__dirname, "../src/lib/firebase.ts"), "utf8");
  const defaultsToProduction =
    /export const DATABASE_ID =[\s\S]{0,200}?PRODUCTION_DATABASE_ID;/.test(fb);
  if (mounted && defaultsToProduction) {
    console.log("  Test-data warning is mounted, and production is the default database.");
    return true;
  }
  if (!mounted) console.log("\n  TEST BANNER: __root.tsx does not mount <TestDataBanner />.");
  if (!defaultsToProduction)
    console.log("\n  TEST BANNER: DATABASE_ID does not fall back to the production database.");
  console.log("");
  return false;
}

function checkPeriodLockCoverage() {
  const roots = ["src/components", "src/routes"];
  // Writes that create or move money/stock with a date on them. Reads,
  // and repair tools that only re-derive stored totals, are not writes.
  const WRITES =
    /(Sales|Purchase|SaleReturn|PurchaseReturn|Payment|Expense|BankTxn|CashAdjustment|StockAdjustment)Repo[.](add|addBatched|update|updateBatched|remove|removeBatched)[^A-Za-z]/;
  const EXEMPT = new Set([
    // Rebuilds stored totals to match documents already there; it never
    // creates, changes or dates a document, and must stay able to correct a
    // closed period's arithmetic.
    "src/routes/settings.tsx",
  ]);
  const offenders = [];
  for (const root of roots) {
    const dir = path.resolve(__dirname, "..", root);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".tsx") && !name.endsWith(".ts")) continue;
      const rel = `${root}/${name}`;
      if (EXEMPT.has(rel)) continue;
      const src = fs.readFileSync(path.join(dir, name), "utf8");
      // The CALL, not the name. Looking for the substring "canPost" passed a
      // file where every reference had been renamed to canPostX — the check
      // has to see the guard being invoked.
      if (WRITES.test(src) && !/\bcanPost\s*\(/.test(src)) offenders.push(rel);
    }
  }
  if (offenders.length) {
    console.log("\n  PERIOD LOCK: these write dated documents but never ask the lock:");
    offenders.forEach((f) => console.log("    x " + f));
    console.log("  A partial lock is worse than none — it looks complete.\n");
    return false;
  }
  console.log("  Period lock: every dated write path asks the lock.");
  return true;
}

async function main() {
  const lockOk = checkPeriodLockCoverage();
  const voidOk = checkVoidCoverage();
  const bannerOk = checkTestBannerMounted();
  const backupOk = checkBackupKeepsVoided();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  fs.writeFileSync(
    path.join(OUT_DIR, "entry.tsx"),
    `import { run } from "${path.resolve(__dirname, "screens.test.tsx").replace(/\\/g, "/")}";
run().then((r) => { (window as any).__RESULT__ = r; })
     .catch((e) => { (window as any).__RESULT__ = { passed: 0, failed: 1, fails: ["harness: " + ((e && e.stack) || (e && e.message) || e)] }; });
`,
    "utf8",
  );

  await esbuild.build({
    entryPoints: [path.join(OUT_DIR, "entry.tsx")],
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    // Some dependency reaches for `process` at runtime, which a browser has
    // no notion of; a minimal shim is enough to get through module init.
    banner: {
      js: "globalThis.process = globalThis.process || { env: {}, argv: [], platform: 'browser', version: '', cwd: () => '/' };",
    },
    outfile: path.join(OUT_DIR, "bundle.js"),
    alias: { "@": path.resolve(__dirname, "../src") },
    plugins: [stubs],
    logLevel: "error",
  });

  // Load the REAL compiled stylesheet when one is available, so layout
  // assertions (heights, scrolling, whether a popup stays capped) measure
  // what the shop actually sees. Without it every element renders unstyled
  // and any visual assertion is meaningless — which silently made an earlier
  // dropdown-scroll check report nonsense. Falls back to unstyled if the app
  // hasn't been built; only the visual checks depend on it.
  const builtCss = (() => {
    const dir = path.resolve(__dirname, "../.vercel/output/static/assets");
    if (!fs.existsSync(dir)) return null;
    const name = fs.readdirSync(dir).find((n) => /^styles-.*\.css$/.test(n));
    return name ? path.join(dir, name) : null;
  })();
  if (!builtCss) {
    console.warn("! No compiled CSS found (build first) — visual checks are skipped.");
  } else {
    // A stale stylesheet is worse than none: a Tailwind class added since the
    // last build simply won't exist, so a layout assertion measures the OLD
    // design and quietly passes. Cost me a wrong conclusion once already.
    const cssTime = fs.statSync(builtCss).mtimeMs;
    const newestSrc = (function walk(dir) {
      let newest = 0;
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        newest = Math.max(newest, st.isDirectory() ? walk(p) : st.mtimeMs);
      }
      return newest;
    })(path.resolve(__dirname, "../src"));
    if (newestSrc > cssTime) {
      console.warn(
        "! The compiled CSS is OLDER than src/ — run a production build first, or any " +
          "layout assertion here is measuring the previous design.",
      );
    }
  }
  fs.writeFileSync(
    path.join(OUT_DIR, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>screen tests</title>` +
      (builtCss ? `<link rel="stylesheet" href="${pathToFileURL(builtCss).href}">` : "") +
      `<body><script src="./bundle.js"></script></body>`,
    "utf8",
  );

  const exe = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) {
    console.error("No Chrome/Edge found — cannot run screen tests.");
    process.exit(2);
  }

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ["--no-sandbox", "--allow-file-access-from-files"],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  // A native confirm()/alert() BLOCKS the page until something answers it, so
  // one stray prompt hangs the entire suite and prints nothing at all — which
  // is exactly what a leftover mounted form's "leave without saving?" did.
  // Dismiss them, and record them: a test that trips one wants to know.
  page.on("dialog", (d) => {
    pageErrors.push(`[dialog] ${d.type()}: ${d.message()}`);
    d.dismiss().catch(() => {});
  });
  page.on("pageerror", (e) =>
    pageErrors.push((e && e.stack ? e.stack : String(e)).split("\n").slice(0, 4).join("\n")),
  );
  // React act() warnings are an artefact of driving mounts from a test
  // harness (router/timer updates land just outside the act block), not a
  // defect in the page — everything else is treated as a hard failure.
  const HARNESS_NOISE = /not wrapped in act|configured to support act|ERR_FILE_NOT_FOUND/;
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    const text = m.text();
    if (HARNESS_NOISE.test(text)) return;
    // Where it came from matters more than the message: React's warnings
    // name the problem ("Received NaN") but never the component, and hunting
    // for it by reading code is exactly the guessing this harness exists to
    // replace.
    const frames = (m.stackTrace?.() ?? [])
      .filter((f) => f && f.url && !f.url.includes("/bundle.js:0"))
      .slice(0, 4)
      .map((f) => `${f.url.split("/").pop()}:${f.lineNumber}:${f.columnNumber}`)
      .join(" < ");
    pageErrors.push(`[${m.type()}] ${text}${frames ? ` @ ${frames}` : ""}`);
  });

  await page.goto("file://" + path.join(OUT_DIR, "index.html").replace(/\\/g, "/"), {
    waitUntil: "domcontentloaded",
  });
  try {
    await page.waitForFunction("window.__RESULT__ !== undefined", { timeout: 120000 });
  } catch {
    console.error("\nThe test page never reported a result. Errors seen:");
    [...new Set(pageErrors)].slice(0, 15).forEach((e) => console.error("  ! " + e));
    if (!pageErrors.length) console.error("  (none — the run is hanging, not throwing)");
    await browser.close();
    process.exit(2);
  }
  const result = await page.evaluate("window.__RESULT__");
  await browser.close();

  console.log("\n══════════════════════════════════════");
  console.log(`  SCREEN TESTS: ${result.passed} passed, ${result.failed} failed`);
  if (result.fails.length) {
    console.log("\nFailures:");
    result.fails.forEach((f) => console.log("  ✗ " + f));
  }
  if (pageErrors.length) {
    console.log(`\nUncaught page errors (${pageErrors.length}):`);
    [...new Set(pageErrors)].slice(0, 10).forEach((e) => console.log("  ! " + e));
  }
  if (!result.failed && !pageErrors.length) {
    console.log("  ✅ ALL SCREENS RENDER REAL DATA");
  }
  console.log("══════════════════════════════════════\n");
  process.exit(
    result.failed || pageErrors.length || !lockOk || !voidOk || !backupOk || !bannerOk ? 1 : 0,
  );
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(2);
});
